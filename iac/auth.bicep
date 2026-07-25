// iac/auth.bicep
// A4 — Easy Auth configuration for the Function (spec §4.1, the recommended validation path).
//
// spec §4.1: "App Service / Functions built-in authentication validates the Entra JWT at the
//   platform, BEFORE your code runs — issuer, audience, and signature are checked by the platform,
//   and your code reads the already-validated claims from the injected X-MS-CLIENT-PRINCIPAL
//   header. Configure the identity provider as Microsoft, set 'Require authentication' so
//   unauthenticated requests are rejected with HTTP 401, and set the allowed token audiences to
//   the broker app client-id GUID and api://<client-id>."
//
// Apply this AFTER the Broker app registration exists (identity/app-registration.md), so the real
// client-id can be substituted for the placeholder. Run via `az` (see identity/grant-revoke-runbook.md).
//
// Microsoft Learn:
// - Authentication/authorization in App Service/Functions: https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization
// - Configure Microsoft Entra authentication: https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-provider-aad
// - Access user identity / client principal: https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-user-identities

@description('Function app name (from iac/outputs.json).')
param functionName string

@description('Broker app registration client-id GUID (from identity/outputs.json; substitute real value at deploy time). PLACEHOLDER.')
param brokerClientId string = '00000000-0000-0000-0000-000000000000'

@description('Broker v2 issuer (from identity/outputs.json). Must end with /v2.0.')
param brokerIssuer string = 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0'

@description('Broker App ID URI (from identity/outputs.json). Accepted alongside the GUID audience.')
param brokerAppIdUri string = 'api://00000000-0000-0000-0000-000000000000'

@description('Unauthenticated paths that bypass Easy Auth (e.g., /api/health for availability probes). CAUTION: exposes an endpoint; disabled by default. Set to specific paths only if required.')
param excludedAuthPaths array = []

resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionName
}

// Easy Auth (authsettingsV2): require authentication platform-wide, reject unauthenticated requests.
// spec §4.1: "App Service / Functions built-in authentication validates the Entra JWT at the
//   platform, BEFORE your code runs — issuer, audience, and signature are checked by the platform,
//   and your code reads the already-validated claims from the injected X-MS-CLIENT-PRINCIPAL
//   header. Configure the identity provider as Microsoft, set 'Require authentication' so
//   unauthenticated requests are rejected with HTTP 401, and set the allowed token audiences to
//   the broker app client-id GUID and api://<client-id>."
//
// SECURITY: globalValidation.requireAuthentication enforces that EVERY request (except those
// in excludedAuthPaths) must carry a valid Entra token. This prevents header forgery: an
// unauthenticated caller cannot forge an x-ms-client-principal header and be accepted by the
// broker. The platform rejects the request at HTTP 401 before application code runs.
//
// Microsoft Learn:
// - authsettingsV2 globalValidation: https://learn.microsoft.com/en-us/azure/templates/microsoft.web/sites/config-authsettingsv2
resource auth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true } // Enable the Easy Auth platform (spec §4.1)
    globalValidation: {
      requireAuthentication: true // MANDATORY: reject unauthenticated requests at the platform (spec §4.1, security hardening)
      unauthenticatedClientAction: 'Return401' // Respond with HTTP 401 (not a login redirect; this is a broker, not an interactive app)
      excludedPaths: excludedAuthPaths // Paths exempt from auth (e.g., ['/api/health'] if availability monitoring requires it; default empty = all paths require auth)
    }
    httpSettings: {
      requireHttps: true
      forwardProxy: { convention: 'NoProxy' }
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: brokerIssuer // v2 issuer (spec §4.2)
          clientId: brokerClientId
          // Allowed token audiences: BOTH the GUID and the api:// URI (spec §4.1, §4.2)
          allowedAudiences: [
            brokerClientId
            brokerAppIdUri
          ]
        }
        validation: {
          allowedAudiences: [
            brokerClientId
            brokerAppIdUri
          ]
          jwtClaimChecks: {
            // Optional: require the roles claim at the platform too (defense in depth; code also enforces).
            // The broker code rejects zero/multi-role tokens (spec §5.1), so this is supplementary.
          }
        }
      }
    }
  }
}

output authConfigured bool = true
output allowedAudiences array = [brokerClientId, brokerAppIdUri]
output issuer string = brokerIssuer

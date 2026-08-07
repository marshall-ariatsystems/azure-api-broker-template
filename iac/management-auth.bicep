// Easy Auth policy for the operator console. App registration creation is kept
// separate because Microsoft Graph is tenant-scoped, not a resource-group API.
param functionName string
param operatorClientId string
param operatorIssuer string
param operatorAppIdUri string
@description('Explicit clients permitted to request operator-audience tokens. Azure CLI is used for the private verification workflow.')
param allowedApplications array = []

resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionName
}
resource auth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      excludedPaths: []
    }
    httpSettings: {
      requireHttps: true
      forwardProxy: { convention: 'NoProxy' }
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: operatorIssuer
          clientId: operatorClientId
        }
        validation: {
          allowedAudiences: [operatorClientId, operatorAppIdUri]
          defaultAuthorizationPolicy: {
            allowedApplications: allowedApplications
            allowedPrincipals: {}
          }
        }
      }
    }
  }
}

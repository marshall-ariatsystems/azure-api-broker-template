# Azure API Key Broker Technical Implementation Specification

> **Revision note (v2):** Corrected after a model-council review that verified every claim against Microsoft Learn. Major changes: the APIM inbound policy now reads `roles` as a `string[]` array from the `broker-jwt` object and enforces exactly-one-vendor-role selection (fixing a substring-match key-selection bug); tokens are standardized on the v2 endpoint (`--scope .../.default`, `requestedAccessTokenVersion: 2`); the custom gateway domain is a publicly-registered `broker.contoso.com` served via split-horizon DNS (Standard v2 / Premium v2 require a publicly-resolvable name) with an Azure DNS Private Resolver for on-prem/VPN resolution; the GitHub OIDC issuer has no trailing slash; and several security/ops gaps (subscription disable, caller-attribution leakage, single-active-key rotation, rate-limit-by-key, break-glass, HA/DR, self-hosted gateway, least-privilege managed-identity RBAC) are addressed.

## 0. Executive intent and non-negotiable security objective

This design implements Azure API Management (APIM) as a server-side API key broker: developers, local tools, GitHub Actions jobs, and Codespaces call APIM with their own Microsoft Entra ID identity, APIM validates that identity, APIM retrieves or references the real vendor API key from Azure Key Vault, APIM injects the vendor key into the upstream request, and APIM returns only the vendor response to the caller. APIM policies can validate JWTs in the inbound pipeline, set or delete request headers, set or delete query parameters, conditionally apply policies, and route to configured backends, which are the exact controls needed for a broker that strips client-supplied keys and injects a server-side key before forwarding to the vendor ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy), [Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy), [Microsoft Learn: choose](https://learn.microsoft.com/en-us/azure/api-management/choose-policy), [Microsoft Learn: set-backend-service](https://learn.microsoft.com/en-us/azure/api-management/set-backend-service-policy)).

The hard requirement is that the real vendor API keys never leave Azure: they must not be placed in local source code, GitHub repository secrets, GitHub Actions logs, browser developer tools, `.env` files, Codespaces secrets, local configuration files, request URLs, client headers, or client logs. APIM named values can reference Azure Key Vault secrets, APIM can use managed identities to access Azure resources such as Key Vault, and Key Vault-backed APIM named values let policies use secrets without exposing the secret value to callers ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: APIM managed identities](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-managed-service-identity)).

## 1. Architecture overview

### 1.1 Diagram in words

```text
Developer laptop / local app / CLI
  or GitHub Actions runner / Codespace
        |
        | 1. Authenticates as a human user or workload to Microsoft Entra ID
        |    using OAuth2/OIDC; no vendor API key is issued to the client.
        v
Microsoft Entra ID
        |
        | 2. Issues an access token whose audience is the APIM broker API
        |    and whose claims represent the caller's user, workload, team, or app role.
        v
Azure API Management gateway (API key broker)
        |
        | 3. Inbound policy validates the JWT, checks roles/scopes, strips any
        |    client-supplied vendor-key headers/query parameters, selects an approved
        |    Key Vault-backed named value, and injects the real vendor key server-side.
        v
Azure Key Vault
        |
        | 4. Stores the real vendor keys; APIM accesses them through managed identity
        |    and APIM named values or, if required, a managed-identity send-request.
        v
Single vendor backend API
        |
        | 5. Vendor receives only APIM's server-side request with the real key;
        |    client receives only the brokered response.
```

### 1.2 Component list

| Component | Role in the broker | Azure-specific implementation |
|---|---|---|
| Client: local developer machine | Sends requests to APIM with a Microsoft Entra access token, never with a vendor key. | Use `az login` or an MSAL-based tool to acquire a token for the APIM broker app registration, then call APIM with `Authorization: Bearer <token>` ([Microsoft Learn: Azure CLI interactive login](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively), [Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token)). |
| Client: GitHub Actions | Uses GitHub OIDC to obtain an Entra token without a GitHub secret. | Configure Entra federated identity credentials for the GitHub repo/ref/environment and use `azure/login` with `id-token: write` permissions ([Microsoft Learn: GitHub OIDC to Azure](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect), [GitHub Docs: OIDC in Azure](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure)). |
| Client: Codespaces | Uses the developer's Entra identity or a workload flow, subject to network reachability. | If APIM is private-only, Codespaces must have a private network path or the org must provide a controlled public ingress because private APIM endpoints are reachable only through the configured private network path ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet)). |
| Microsoft Entra ID | Identity provider and authorization claim issuer. | Expose an API scope and/or app roles on the broker API app registration; assign users, groups, and workload service principals to app roles ([Microsoft Learn: scopes and permissions](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc), [Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)). |
| APIM gateway | Broker enforcement point. | Validate JWTs in inbound policies, select a vendor key, strip client key material, inject server-side headers/query parameters, enforce quotas/rate limits, and log usage metadata ([Microsoft Learn: APIM policy reference](https://learn.microsoft.com/en-us/azure/api-management/api-management-policies)). |
| Azure Key Vault | Secret store for real vendor keys. | Store each vendor key as a separate secret; use APIM managed identity with `get`/`list` or Key Vault Secrets User as appropriate ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)). |
| Vendor API | Single upstream API with multiple vendor keys. | APIM forwards requests to the vendor backend after injecting the selected key using `set-header` or `set-query-parameter` ([Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy)). |

### 1.3 Key-broker pattern

The broker pattern deliberately separates caller identity from vendor credential possession: callers prove who they are to Entra ID and APIM, while APIM alone possesses the authority to use a vendor key. APIM policies execute server-side at the gateway and can change the request sent to the backend, so the injected vendor credential is present only on the APIM-to-vendor leg and is never sent back to the client ([Microsoft Learn: APIM policies](https://learn.microsoft.com/en-us/azure/api-management/api-management-policies), [Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy)).

The vendor key should be injected as an upstream header such as `x-api-key` whenever the vendor supports header authentication, because URL query parameters are more likely to appear in intermediary logs and browser history. APIM supports both header mutation and query-parameter mutation, so this spec includes both patterns but recommends header injection by default ([Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy)).

## 2. Identity and authorization design

### 2.1 Entra app registrations

Create a **Broker API** app registration that represents the APIM broker as the protected resource, and set its Application ID URI to a stable value such as `api://<broker-api-client-id>` or `api://vendor-api-broker`. Microsoft identity platform APIs expose delegated permission scopes and app roles from a resource application, and access tokens use those exposed permissions as claims that APIM can validate ([Microsoft Learn: scopes and permissions](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc), [Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).

Define app roles rather than relying only on Entra group object IDs in tokens, because app roles produce authorization-oriented `roles` claims and allow the admin to assign users, groups, and workload service principals to clear broker permissions. Microsoft documents app roles as application permissions that can be assigned to users, groups, or applications and emitted in tokens for authorization decisions ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).

Recommended app roles:

| App role value | Intended callers | Key-selection implication |
|---|---|---|
| `VendorApi.KeyA.Invoke` | Team A or purpose A | APIM selects Key Vault named value `vendor-key-a`. |
| `VendorApi.KeyB.Invoke` | Team B or purpose B | APIM selects Key Vault named value `vendor-key-b`. |
| `VendorApi.KeyC.Invoke` | CI workload or production automation | APIM selects Key Vault named value `vendor-key-c`. |
| `VendorApi.Admin.Test` | Admin-only test clients | APIM may select a sandbox or canary vendor key. |

Use delegated scopes such as `VendorApi.Invoke` for interactive local developer flows and app roles such as `VendorApi.KeyA.Invoke` for both users and GitHub workload service principals when the key selection must be explicit. OAuth2 authorization-code flow is the standard interactive browser sign-in flow for delegated access, and GitHub workload identity federation uses a service principal/workload identity model rather than a browser user flow ([Microsoft Learn: OAuth2 authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [Microsoft Learn: workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation)).

### 2.2 APIM JWT validation

Use APIM's `validate-jwt` policy at the API or product scope to enforce token presence, issuer, audience, expiration, and required claims before any vendor request is created. Microsoft documents `validate-jwt` as an inbound policy that enforces existence and validity of a JWT and can use OpenID configuration, audiences, issuers, and required claims across APIM policy scopes ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy)).

For Entra-only deployments, `validate-azure-ad-token` is also available and is specifically documented as enforcing the existence and validity of a JWT issued by Microsoft Entra. This spec uses `validate-jwt` in the main artifact because the admin explicitly requested OAuth2/JWT validation via `validate-jwt`, but implementers may replace it with `validate-azure-ad-token` if they prefer the Entra-specific policy ([Microsoft Learn: validate-azure-ad-token](https://learn.microsoft.com/en-us/azure/api-management/validate-azure-ad-token-policy)).

### 2.3 Per-user and per-team grants

The admin grants access by assigning an Entra user or Entra security group to a broker app role, and the admin revokes access by removing that user or group assignment. App roles are designed for application-specific authorization and can be assigned to users, groups, and service principals, which makes them the cleanest authorization primitive for this broker ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).

APIM products and subscriptions can still be used as operational packaging, quota, and additional revocation layers. APIM products are used to publish APIs to developers, APIM groups control product visibility to developers in the developer portal, and APIM subscriptions can be scoped to a product, all APIs, or an individual API ([Microsoft Learn: APIM products](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-create-products), [Microsoft Learn: APIM groups](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-create-groups), [Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)).

Do not treat APIM subscription keys as the primary security mechanism for this hard requirement, because subscription keys are caller-held broker credentials even though they are not the vendor key. APIM subscriptions are useful for metering and operational kill switches, but Entra JWT validation remains the primary identity control because OAuth tokens can identify the user or workload without distributing the upstream vendor secret ([Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions), [Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy)).

**Recommendation: disable the subscription requirement on the brokered API/product** so that `validate-jwt` is the sole gate and no caller-held subscription key can become a second, weaker credential to leak. Set the API (or product) to not require a subscription; if the team instead keeps subscriptions for metering, treat them strictly as metering/per-team kill-switch mechanisms, never as the authorization control ([Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)).

If product-scoped policies are used for authorization or key selection, avoid API-scoped, all-APIs, or built-in all-access subscriptions for normal access because Microsoft notes that product-scope policies are not applied to requests that use API-scoped, all-APIs, or all-access subscriptions. The built-in all-access subscription should be restricted to authorized owners and never embedded in client apps because Microsoft warns that it grants access to every API in the APIM instance ([Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)).

### 2.4 GitHub Actions and Codespaces authentication

GitHub organization SAML SSO and GitHub Actions OIDC solve different problems. GitHub SAML SSO authenticates human users to GitHub Enterprise Cloud through an identity provider, while GitHub Actions OIDC lets a workflow request a short-lived OIDC token that a cloud provider can exchange for cloud credentials without storing long-lived cloud secrets in GitHub ([GitHub Docs: SAML SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/about-authentication-with-saml-single-sign-on), [GitHub Docs: OIDC concepts](https://docs.github.com/en/actions/concepts/security/openid-connect)).

Configure an Entra app registration or managed identity with a federated identity credential whose issuer is `https://token.actions.githubusercontent.com` (**no trailing slash**, per GitHub's OIDC reference), whose audience is `api://AzureADTokenExchange`, and whose subject restricts the trust to the specific GitHub organization, repository, branch, tag, pull request, or environment. Issuer, subject, and audience matching is **exact and case-sensitive**, so verify each value against the actual token `iss`/`sub`/`aud` observed in the tenant before relying on the trust. Microsoft and GitHub document this GitHub OIDC-to-Azure pattern and the Azure CLI supports creating app federated credentials with `az ad app federated-credential create` ([GitHub Docs: OIDC token reference](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect), [Microsoft Learn: workload identity federation trust with GitHub](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-github), [Microsoft Learn: Azure OIDC with GitHub Actions](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect), [Microsoft Learn: az ad app federated-credential](https://learn.microsoft.com/en-us/cli/azure/ad/app/federated-credential?view=azure-cli-latest)).

GitHub-hosted runners and cloud Codespaces still need network reachability to APIM. If APIM is deployed private-only through an internal VNet or private endpoint, GitHub-hosted runners and default Codespaces cannot reach it unless the organization supplies a private network path, such as a self-hosted runner in Azure/VPN or a controlled public ingress tier in front of APIM ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: APIM internal VNet](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet)).

### 2.5 Token version, audience, and issuer (standardize on v2)

This design standardizes on the **v2 token endpoint** to match the policy, which validates the v2 issuer `https://login.microsoftonline.com/<tenant>/v2.0` and a v2 audience. The Broker API app manifest MUST set `requestedAccessTokenVersion: 2`, otherwise Entra issues v1 tokens whose `iss` and `aud` will not match the policy and every call is rejected ([Microsoft Learn: app manifest requestedAccessTokenVersion](https://learn.microsoft.com/en-us/entra/identity-platform/reference-app-manifest), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

For v2 tokens the audience `aud` is the **client-ID GUID** of the Broker API app; the policy validates that GUID and additionally accepts `api://<client-id>` for callers that request the App ID URI form. The issuer is `https://login.microsoftonline.com/<tenant>/v2.0` ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

**A v1/v2 mismatch is the most common cause of token rejection.** Azure CLI's `az account get-access-token --resource <uri>` requests a **v1** token, while `--scope <uri>/.default` requests a **v2** token. All token-acquisition examples in this spec (§9.1 GitHub Actions, §9.2 local dev) therefore use `--scope "<appIdUri>/.default"` (equivalently `api://<client-id>/.default`), never `--resource` ([Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

Regarding client-identity claims: `appid` is a **v1-only** claim and `azp` is the **v2** equivalent, so because we standardize on v2 the broker logs `azp` (keeping `appid` only as a fallback for any residual v1 token) ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

**Mandatory pre-rollout token test.** Before go-live, decode a real user delegated token AND a real GitHub workload app-only token and assert that `ver`, `iss`, `aud`, `roles`, `scp`, `azp`/`appid`, and `oid` exactly match what the policy validates. Do this once per identity type, because the workload app-only token and the interactive delegated token carry different claim shapes ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

### 2.6 App roles for workloads and Conditional Access

**App roles used by CI must include `Application` in `allowedMemberTypes`.** If the broker app role only allows `User`, a CI **app-only** token carries **no `roles` claim** and every CI call returns 403. Set `allowedMemberTypes` to include `Application` (and `User` if humans also use the role), grant the workload service principal a **direct app-role assignment** to the Broker API service principal, and complete **admin consent** for the application permission. Do NOT assign the SP to a group and then assign the group to the role: Entra omits the `roles` claim for application tokens in the group-nesting case ([Microsoft Learn: add app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

Enable **“assignment required”** on the Broker enterprise application so that role-less app-only tokens fail at issuance rather than only at the policy — defense in depth ([Microsoft Learn: add app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: client credentials flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow)).

**Conditional Access.** User CA policies do NOT cover workload identities, and managed identities are not covered by CA at all; workload identity CA is a separate feature and supports only **blocking** controls (it cannot require MFA on a workload). Use **user CA** (device compliance / trusted corporate network) for local developers to bound bearer-token replay, and a **separate workload-identity CA** for the GitHub service principals. Note that SAML SSO / user MFA protects human GitHub sign-in and does NOT protect the GitHub Actions OIDC flow ([Microsoft Learn: Conditional Access for workload identities](https://learn.microsoft.com/en-us/entra/identity/conditional-access/workload-identity)).

## 3. Secret storage and injection design

### 3.1 Key Vault storage model

Create one Key Vault secret per real vendor key, using names that reveal purpose but not value, such as `vendor-api-key-team-a`, `vendor-api-key-team-b`, and `vendor-api-key-ci`. Azure Key Vault stores and manages secrets, and APIM named values can reference Key Vault secrets as a value type for use in policies ([Microsoft Learn: Key Vault secrets](https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

Grant APIM's managed identity the minimum Key Vault permissions required to retrieve secrets. With the Key Vault access-policy model, Microsoft documents `Get` and `List` secret permissions for the APIM managed identity; with Azure RBAC, Microsoft documents assigning `Key Vault Secrets User` to the APIM managed identity for named value integration ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)).

Prefer unversioned Key Vault secret identifiers in APIM named values, because Microsoft states that APIM automatically updates a Key Vault-backed named value within four hours after the Key Vault secret is updated, while a versioned secret identifier prevents automatic rotation in APIM. Manual refresh from the Azure portal or management REST API is available if the admin needs faster rollout after setting a new secret version ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

If the Key Vault firewall is enabled, Microsoft requires using the APIM system-assigned managed identity for APIM access to Key Vault, enabling “Allow trusted Microsoft services to bypass this firewall,” and configuring VNet service endpoints/NSG rules when APIM is deployed in a virtual network. This requirement affects the choice between system-assigned and user-assigned identities for the Key Vault-backed named value path ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: APIM managed identities](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-managed-service-identity)).

### 3.2 APIM named values backed by Key Vault

Create a Key Vault-backed APIM named value for each vendor key, for example `vendor-key-a`, `vendor-key-b`, and `vendor-key-ci`. APIM named values can be referenced in policies by using double braces around the display name, such as `{{vendor-key-a}}`, and Key Vault named values let APIM reuse Key Vault secrets with granular Key Vault access controls ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

A Bicep resource for a Key Vault-backed named value follows the documented `Microsoft.ApiManagement/service/namedValues` schema, whose `keyVault.secretIdentifier` field references the Key Vault secret and whose documentation warns that a versioned secret identifier prevents auto-refresh ([Microsoft Learn: APIM namedValues ARM schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/namedvalues)).

```bicep
// Example only; use an unversioned secret URI for automatic refresh.
resource apim 'Microsoft.ApiManagement/service@2024-05-01' existing = {
  name: apimName
}

resource vendorKeyA 'Microsoft.ApiManagement/service/namedValues@2025-03-01-preview' = {
  parent: apim
  name: 'vendor-key-a'
  properties: {
    displayName: 'vendor-key-a'
    secret: true
    keyVault: {
      // Omit identityClientId to use the system-assigned identity where supported.
      secretIdentifier: 'https://${keyVaultName}.vault.azure.net/secrets/vendor-api-key-team-a'
    }
  }
}
```

For a quick non-Key-Vault test only, `az apim nv create` can create an encrypted APIM secret named value, but production vendor keys should stay in Key Vault-backed named values rather than being stored as APIM-local custom secrets. Microsoft documents `az apim nv create` for APIM named values and separately recommends Key Vault secrets because they improve APIM security and support automatic rotation from Key Vault updates ([Microsoft Learn: az apim nv](https://learn.microsoft.com/en-us/cli/azure/apim/nv?view=azure-cli-latest), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

```bash
# Non-production smoke-test named value only; do not use this for real vendor keys.
az apim nv create \
  --resource-group rg-api-broker-prod \
  --service-name apim-api-broker-prod \
  --named-value-id vendor-key-test \
  --display-name vendor-key-test \
  --secret true \
  --value 'placeholder-do-not-use-real-vendor-key'
```

### 3.3 Alternate dynamic retrieval with managed identity and send-request

The preferred pattern is Key Vault-backed named values because it avoids per-request Key Vault calls and lets APIM refresh from Key Vault on the documented refresh cadence. APIM also has `send-request` and `authentication-managed-identity` policies that can call an external URL and obtain a managed-identity token for resources such as `https://vault.azure.net`, but this should be reserved for unusual dynamic lookup cases because it adds latency, Key Vault transaction volume, and additional policy complexity ([Microsoft Learn: send-request](https://learn.microsoft.com/en-us/azure/api-management/send-request-policy), [Microsoft Learn: authentication-managed-identity](https://learn.microsoft.com/en-us/azure/api-management/authentication-managed-identity-policy), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

### 3.4 Multiple vendor keys from one upstream vendor

Use one APIM named value per vendor key and one explicit authorization mapping per named value. The simplest safe mapping is **app role → APIM policy branch → Key Vault-backed named value**, because the admin controls app-role assignment in Entra ID and the policy never returns the selected key to the caller ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: choose policy](https://learn.microsoft.com/en-us/azure/api-management/choose-policy), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

Recommended mapping options:

| Mapping model | When to use | How the admin controls it | Key exposure risk |
|---|---|---|---|
| App role per key | Best default for teams, CI, and purposes. | Assign Entra users/groups/service principals to app roles. | Low, because the key remains only in Key Vault/APIM. |
| Product per key | Useful when products need separate quotas, subscriptions, and developer portal packaging. | Publish products to APIM groups and apply product-scope policies. | Low, if product-scope policies are guaranteed to apply to the subscriptions used. |
| Operation/path per purpose | Useful when `/sandbox/*`, `/prod/*`, or `/team-a/*` should map to different vendor keys. | Assign route-level policies and Entra app roles. | Low, if authorization and route policies are aligned. |
| Deterministic distribution | Useful when splitting load across vendor keys without exposing them. | Hash on user/team/workload or route through a small selector service. | Low, but harder to reason about for auditing. |

Avoid random per-request key selection in APIM unless the vendor contract explicitly permits it and the implementation provides auditable attribution. APIM `choose` can branch conditionally, but a deterministic mapping from caller claim or product to named value is easier to monitor, revoke, and explain during an incident ([Microsoft Learn: choose policy](https://learn.microsoft.com/en-us/azure/api-management/choose-policy), [Microsoft Learn: APIM monitoring](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor)).

## 4. APIM inbound policy artifact

The following policy validates an Entra access token, denies callers without exactly one recognized vendor-key app role, strips common client-supplied vendor credential locations, selects the Key Vault-backed named value, injects the vendor key into `x-api-key`, prevents forwarding the client Entra token to the vendor, and sends the request to the vendor backend. The policy uses documented APIM controls: `validate-jwt`, `choose`, `set-header`, `set-query-parameter`, `set-variable`, and `set-backend-service` ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy), [Microsoft Learn: choose](https://learn.microsoft.com/en-us/azure/api-management/choose-policy), [Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy), [Microsoft Learn: set-variable](https://learn.microsoft.com/en-us/azure/api-management/set-variable-policy), [Microsoft Learn: set-backend-service](https://learn.microsoft.com/en-us/azure/api-management/set-backend-service-policy)).

**Role selection reads a typed array, not a joined string (critical).** `validate-jwt` with `output-token-variable-name="broker-jwt"` produces a `Microsoft.Azure.ApiManagement.PolicyExpressions.Jwt` object whose `Claims` property is an `IReadOnlyDictionary<string, string[]>`, so `((Jwt)context.Variables["broker-jwt"]).Claims["roles"]` yields the `roles` claim as a `string[]` where `.Contains("VendorApi.KeyA.Invoke")` is an EXACT element match. This is deliberately different from `context.Principal.Claims.GetValueOrDefault("roles", "")`, which returns a COMMA-SEPARATED STRING on which `.Contains()` is a substring test that would let a future role such as `VendorApi.KeyA.InvokeReadOnly` wrongly match `VendorApi.KeyA.Invoke` and be handed the production key. The policy therefore counts how many recognized vendor-key roles the caller holds and returns `403` unless the count is exactly one, rejecting both zero-role and ambiguous multi-role tokens ([Microsoft Learn: APIM policy expressions](https://learn.microsoft.com/en-us/azure/api-management/api-management-policy-expressions), [Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy)).

```xml
<policies>
  <inbound>
    <base />

    <!-- 1. Validate the caller's Entra-issued v2 access token for this broker API.
         For v2 tokens the audience is the client-ID GUID; api://<client-id> is also
         accepted for callers that request the App ID URI form. -->
    <validate-jwt header-name="Authorization"
                  require-scheme="Bearer"
                  failed-validation-httpcode="401"
                  failed-validation-error-message="Unauthorized: missing or invalid broker access token."
                  output-token-variable-name="broker-jwt">
      <openid-config url="https://login.microsoftonline.com/{{tenant-id}}/v2.0/.well-known/openid-configuration" />
      <audiences>
        <audience>{{broker-api-client-id}}</audience>
        <audience>api://{{broker-api-client-id}}</audience>
      </audiences>
      <issuers>
        <issuer>https://login.microsoftonline.com/{{tenant-id}}/v2.0</issuer>
      </issuers>
      <required-claims>
        <claim name="roles" match="any">
          <value>VendorApi.KeyA.Invoke</value>
          <value>VendorApi.KeyB.Invoke</value>
          <value>VendorApi.KeyC.Invoke</value>
        </claim>
      </required-claims>
    </validate-jwt>

    <!-- 2. Read the roles claim as a typed string[] ARRAY from the validated broker-jwt
         object (NOT the comma-joined string from context.Principal). ContainsKey guards
         a role-less token; default to an empty array. -->
    <set-variable name="broker-roles"
                  value="@(((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims.ContainsKey(&quot;roles&quot;) ? ((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims[&quot;roles&quot;] : new string[0])" />

    <!-- 3. Count how many RECOGNIZED vendor-key roles the caller holds. Exact array-element
         membership, not substring on a flattened string. -->
    <set-variable name="key-role-count"
                  value="@{ var roles = (string[])context.Variables[&quot;broker-roles&quot;]; int n = 0; if (roles.Contains(&quot;VendorApi.KeyA.Invoke&quot;)) n++; if (roles.Contains(&quot;VendorApi.KeyB.Invoke&quot;)) n++; if (roles.Contains(&quot;VendorApi.KeyC.Invoke&quot;)) n++; return n; }" />

    <!-- 4. Reject BOTH zero-role and ambiguous multi-role tokens: require exactly one. -->
    <choose>
      <when condition="@((int)context.Variables[&quot;key-role-count&quot;] != 1)">
        <return-response>
          <set-status code="403" reason="Forbidden" />
          <set-header name="Content-Type" exists-action="override">
            <value>application/json</value>
          </set-header>
          <set-body>{"error":"Caller must have exactly one vendor-key role (VendorApi.KeyA.Invoke, VendorApi.KeyB.Invoke, or VendorApi.KeyC.Invoke)."}</set-body>
        </return-response>
      </when>
    </choose>

    <!-- 5. Remove EVERY client-supplied vendor credential location before injection.
         See the canonicalize+allowlist note below: inventory the full credential surface
         the vendor accepts (header case variants, query params, body/form fields, token
         fields) and strip or reject all of them. The deletes below are the vendor-specific
         surface for the x-api-key artifact, not a complete list. -->
    <set-header name="x-api-key" exists-action="delete" />
    <set-header name="X-API-Key" exists-action="delete" />
    <set-header name="api-key" exists-action="delete" />
    <set-header name="apikey" exists-action="delete" />
    <set-header name="X-Vendor-Api-Key" exists-action="delete" />
    <set-query-parameter name="api_key" exists-action="delete" />
    <set-query-parameter name="key" exists-action="delete" />
    <set-query-parameter name="apikey" exists-action="delete" />
    <set-query-parameter name="access_token" exists-action="delete" />
    <set-query-parameter name="token" exists-action="delete" />
    <set-query-parameter name="subscription-key" exists-action="delete" />

    <!-- 6. Record caller metadata from the validated broker-jwt object. These values are
         intended for APIM LOGS ONLY (via diagnostics / log-to-eventhub). By default they
         are NOT forwarded to the vendor to avoid leaking internal Entra oids to a third
         party; see §5 note. azp is the v2 client-id claim (appid is v1-only). -->
    <set-variable name="caller-oid"
                  value="@(((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims.ContainsKey(&quot;oid&quot;) ? ((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims[&quot;oid&quot;][0] : &quot;unknown&quot;)" />
    <set-variable name="caller-azp"
                  value="@(((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims.ContainsKey(&quot;azp&quot;) ? ((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims[&quot;azp&quot;][0] : (((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims.ContainsKey(&quot;appid&quot;) ? ((Jwt)context.Variables[&quot;broker-jwt&quot;]).Claims[&quot;appid&quot;][0] : &quot;unknown&quot;))" />

    <!-- 7. Do not forward the caller's Entra bearer token to the vendor. -->
    <set-header name="Authorization" exists-action="delete" />

    <!-- 8. Select and inject the real vendor key server-side by EXACT array membership.
         The count check above guarantees exactly one branch matches. -->
    <choose>
      <when condition="@(((string[])context.Variables[&quot;broker-roles&quot;]).Contains(&quot;VendorApi.KeyA.Invoke&quot;))">
        <set-header name="x-api-key" exists-action="override">
          <value>{{vendor-key-a}}</value>
        </set-header>
      </when>
      <when condition="@(((string[])context.Variables[&quot;broker-roles&quot;]).Contains(&quot;VendorApi.KeyB.Invoke&quot;))">
        <set-header name="x-api-key" exists-action="override">
          <value>{{vendor-key-b}}</value>
        </set-header>
      </when>
      <when condition="@(((string[])context.Variables[&quot;broker-roles&quot;]).Contains(&quot;VendorApi.KeyC.Invoke&quot;))">
        <set-header name="x-api-key" exists-action="override">
          <value>{{vendor-key-c}}</value>
        </set-header>
      </when>
    </choose>

    <!-- 9. Forward to the single upstream vendor API. -->
    <set-backend-service base-url="https://api.vendor.example" />
  </inbound>

  <backend>
    <base />
  </backend>

  <outbound>
    <base />
    <!-- Ensure the broker never returns a vendor key even if an upstream error echoes it.
         Scrub BOTH the header path and the query path so the two paths are symmetric. -->
    <set-header name="x-api-key" exists-action="delete" />
    <set-header name="X-API-Key" exists-action="delete" />
    <set-header name="api-key" exists-action="delete" />
    <set-header name="apikey" exists-action="delete" />
    <set-header name="X-Vendor-Api-Key" exists-action="delete" />
    <set-query-parameter name="api_key" exists-action="delete" />
    <set-query-parameter name="key" exists-action="delete" />
    <set-query-parameter name="subscription-key" exists-action="delete" />
  </outbound>

  <on-error>
    <base />
    <set-header name="x-api-key" exists-action="delete" />
    <set-header name="X-API-Key" exists-action="delete" />
    <set-header name="api-key" exists-action="delete" />
    <set-header name="apikey" exists-action="delete" />
    <set-header name="X-Vendor-Api-Key" exists-action="delete" />
    <!-- Query strings leak into GatewayLogs request URLs, so scrub the query path on error too. -->
    <set-query-parameter name="api_key" exists-action="delete" />
    <set-query-parameter name="key" exists-action="delete" />
    <set-query-parameter name="subscription-key" exists-action="delete" />
  </on-error>
</policies>
```

If the vendor requires the key in a query parameter rather than a header, replace the selected `set-header` branch with `set-query-parameter name="api_key" exists-action="override"`; APIM documents `set-query-parameter` as supporting `override`, `skip`, `append`, and `delete` actions in inbound/backend sections ([Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy)).

If the vendor authenticates via `Authorization: Bearer <vendor-key>` rather than `x-api-key`, do not merely delete the caller `Authorization` header — delete it and then SET a fresh `Authorization` from the Key Vault-backed named value in the matched branch (for example `<set-header name="Authorization" exists-action="override"><value>Bearer {{vendor-key-a}}</value></set-header>`). The `x-api-key` artifact above is only one of several vendor credential shapes ([Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

**The real leak control is diagnostics configuration, not the header/query delete.** The `on-error` and `outbound` scrubs above are defense-in-depth only. The durable control is to set APIM diagnostics so that frontend/backend request+response header and body logging is set to `none` and routine production request tracing is disabled, because APIM request tracing exposes the request-processing steps (including resolved named values) to anyone with trace access, and a Key Vault-backed named value's secret value is visible to anyone who can read a trace ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: APIM request tracing](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-api-inspector)).

**Canonicalize + allowlist, not denylist.** The concrete deletes above are the vendor-specific credential surface for this design, not a complete list. Before injection, inventory EVERY credential-bearing location the vendor accepts — headers including case variants such as `X-API-Key`, `apikey`, and `api-key`; query parameters; JSON body fields; form fields; and `access_token`/`token` fields — then canonicalize (normalize header case) and strip or reject all of them. APIM header and query policies match header names case-insensitively, but body/form credential fields require explicit handling in the body if the vendor accepts them ([Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy)).

## 5. Network design

### 5.1 Recommended deployment models

For private-only access from on-prem and VPN users, use an APIM deployment that provides private inbound gateway access and connect it to the Azure VNet reached through Meraki MX private routing and VPN. Microsoft documents several APIM networking models: classic Developer/Premium VNet injection in internal mode, Premium v2 VNet injection for gateway isolation, v2 outbound VNet integration, and inbound private endpoints for the managed gateway ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts)).

| Requirement | Recommended APIM network option | Tier notes |
|---|---|---|
| Strict private-only inbound and outbound gateway path | Premium v2 VNet injection, or classic Premium internal VNet mode. | Premium v2 provides gateway isolation, and classic internal VNet mode is documented for Developer/Premium ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts), [Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet)). |
| Private inbound to gateway without full VNet injection | APIM inbound private endpoint and disabled public network access. | Inbound private endpoint supports Developer, Basic, Standard, Standard v2, Premium, and Premium v2, and Microsoft says public network access can be disabled when private endpoint is configured ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint)). |
| Cost-conscious production with private clients and public management plane | Standard v2 with inbound private endpoint; add outbound VNet integration only if backend or dependencies require it. | Standard v2 supports inbound private endpoint connections and outbound VNet integration, but Basic v2/Standard v2 cannot be deployed entirely inside a VNet ([Microsoft Learn: v2 tiers](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview), [Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint)). |
| Vendor API is public internet only | APIM can call the public vendor API; restrict egress by firewall/NAT controls where the chosen APIM tier/networking model allows. | APIM is public by default and can act as a gateway to public backends, while VNet options depend on tier ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts)). |
| Public ingress required for GitHub-hosted runners or external users | Place Azure Front Door Premium or Application Gateway WAF in front and still require Entra JWT validation at APIM. | Microsoft documents Azure Front Door Premium Private Link to origins and Application Gateway WAF in front of internal APIM scenarios ([Microsoft Learn: Azure Front Door Private Link](https://learn.microsoft.com/en-us/azure/frontdoor/private-link), [Microsoft Learn: APIM with Application Gateway](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-integrate-internal-vnet-appgateway), [Microsoft Learn: Application Gateway WAF](https://learn.microsoft.com/en-us/azure/web-application-firewall/ag/ag-overview)). |

### 5.1a DNS name resolvability constraint (Standard v2 / Premium v2)

On Standard v2 and Premium v2, APIM requires that the gateway be reachable by a **publicly resolvable DNS name**: a custom gateway domain on these tiers must be publicly resolvable and cannot be restricted to a private DNS zone only. This means the `broker-api.contoso.internal` non-public custom domain used earlier in drafts of this design is **unsupported** on the recommended Standard v2 baseline ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: v2 tiers overview](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview)).

The correct pattern is a **publicly-registered apex/hostname served via split-horizon DNS**. Register a real public name such as `broker.contoso.com`. For on-prem/VPN clients, resolve that name (via the `privatelink.azure-api.net` private zone and/or a private-view public zone) to the **private endpoint IP**; simultaneously **disable public network access** on APIM so that even though the name is publicly resolvable, the endpoint refuses public traffic. The NAME is public; the TRAFFIC stays private ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint)).

Split-horizon resolution across a VPN is a **hard infrastructure requirement**, not optional: on-prem servers cannot use Azure's internal DNS (`168.63.129.16`) across a VPN, so resolving Azure private DNS zones from on-prem requires an **Azure DNS Private Resolver** (or DNS forwarder VMs deployed in the VNet) with conditional forwarding from corporate DNS. Budget and deploy the DNS Private Resolver as part of the network foundation ([Microsoft Learn: Azure DNS Private Resolver](https://learn.microsoft.com/en-us/azure/dns/dns-private-resolver-overview), [Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint)).

### 5.1b Outbound egress and fixed IP

Standard v2 uses a **shared SNAT pool** for outbound calls and does **not** support attaching a NAT Gateway for a stable, fixed egress IP. If the vendor allowlists a specific outbound IP, Standard v2 must route egress through outbound VNet integration behind an Azure Firewall or NAT (added cost), or the design must move to Premium, which supports VNet injection with controllable egress ([Microsoft Learn: v2 tiers overview](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview), [Microsoft Learn: v2 outbound VNet integration](https://learn.microsoft.com/en-us/azure/api-management/integrate-vnet-outbound)).

### 5.2 Meraki MX private route and VPN ingress

Route on-prem and VPN client traffic from the Meraki MX into the Azure hub or APIM VNet so that users resolve and reach the APIM gateway private endpoint/private IP over private routing. APIM internal mode endpoints are not registered on public DNS and remain inaccessible until DNS is configured for the VNet, and APIM private endpoints require custom DNS or an Azure private DNS zone that maps the APIM hostname to the private endpoint IP ([Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet), [Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint)).

For an APIM private endpoint design, create or link the `privatelink.azure-api.net` private DNS zone to the VNet used by on-prem/VPN clients, and configure conditional forwarding from on-prem DNS to an **Azure DNS Private Resolver inbound endpoint** in the VNet so corporate/VPN clients can resolve the Azure private zone (they cannot query `168.63.129.16` across the VPN). Microsoft documents `privatelink.azure-api.net` as the default private DNS zone for APIM private endpoints, states that the private endpoint uses an IP address from the hosting Azure VNet, and documents the Azure DNS Private Resolver as the supported way to forward on-prem DNS queries to Azure private zones ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: Azure DNS Private Resolver](https://learn.microsoft.com/en-us/azure/dns/dns-private-resolver-overview)).

For classic internal VNet mode, create private DNS records for the APIM gateway hostname, developer portal if used, management endpoint if needed, and any custom domain names to point to APIM's private virtual IP. Microsoft states that in internal mode the gateway, developer portal, direct management, and Git endpoints are accessible only within the controlled VNet and are not public-DNS registered ([Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet)).

### 5.3 Public ingress option

If GitHub-hosted runners, cloud Codespaces, or external partners need access without VPN, use a controlled public entry point rather than exposing APIM broadly. Azure Front Door Premium can connect privately to supported origins by using Private Link, and Application Gateway with WAF can front internal APIM for HTTP filtering and private routing ([Microsoft Learn: Azure Front Door Private Link](https://learn.microsoft.com/en-us/azure/frontdoor/private-link), [Microsoft Learn: APIM with Application Gateway](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-integrate-internal-vnet-appgateway), [Microsoft Learn: Application Gateway WAF](https://learn.microsoft.com/en-us/azure/web-application-firewall/ag/ag-overview)).

Even when public ingress exists, APIM must still validate Entra tokens and never accept a vendor key from the client. Front-door controls reduce exposure and add WAF protections, but the broker security boundary remains APIM's identity validation plus server-side secret injection ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy), [Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy)).

## 6. Preventing key leakage

### 6.1 Required controls

| Leakage path | Control |
|---|---|
| GitHub repository secrets | Do not store vendor keys in GitHub; use GitHub OIDC to obtain Entra tokens without cloud secrets ([GitHub Docs: OIDC concepts](https://docs.github.com/en/actions/concepts/security/openid-connect), [Microsoft Learn: Azure OIDC with GitHub Actions](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)). |
| Local `.env` files | Store only the APIM base URL, Entra tenant ID, and broker audience; use `az login` or MSAL to obtain access tokens ([Microsoft Learn: Azure CLI interactive login](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively), [Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token)). |
| Client-provided key headers or query strings | Strip `x-api-key`, `api-key`, `X-Vendor-Api-Key`, `api_key`, `key`, and similar values before APIM injects the real key ([Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy)). |
| APIM logs | Log caller object ID, app ID (`azp`), product, operation, status code, and latency, but do not log request/response headers or bodies that could contain credentials. Application Insights logging can materially reduce throughput at high request rates and Microsoft states it is not intended as an audit system for every high-volume request ([Microsoft Learn: APIM and Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights)). |
| Caller attribution to the vendor | Keep caller `oid`/`azp`/request-id in APIM logs only; do NOT inject `x-broker-caller-*` headers into the request forwarded to the vendor, or you leak internal Entra object IDs to a third party. Only forward attribution if the vendor contract requires it ([Microsoft Learn: log-to-eventhub](https://learn.microsoft.com/en-us/azure/api-management/log-to-eventhub-policy), [Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy)). |
| APIM tracing | Disable routine production tracing and restrict who can enable request tracing, because tracing is a debugging feature that inspects request-processing steps ([Microsoft Learn: APIM request tracing](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-api-inspector)). |
| APIM policy authoring | Limit policy-edit permissions to the admin and infrastructure owners only, because Microsoft warns that users who can modify policies may be able to use managed identity tokens in unintended ways or log/exfiltrate them ([Microsoft Learn: authentication-managed-identity](https://learn.microsoft.com/en-us/azure/api-management/authentication-managed-identity-policy)). |
| Key Vault access | Grant only APIM managed identity and break-glass administrators access to vendor key secrets; use Key Vault RBAC or access policies with least privilege ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)). |
| Network egress | Where possible, require APIM/Azure Firewall/NAT as the only route from managed networks to the vendor API endpoint so local devices cannot use leaked or guessed keys directly. APIM networking options and NSG/firewall controls depend on the selected tier and VNet model ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts), [Microsoft Learn: v2 outbound VNet integration](https://learn.microsoft.com/en-us/azure/api-management/integrate-vnet-outbound)). |

### 6.2 Logging rules

Do not log the upstream `x-api-key` header, `api_key` query parameter, `Authorization` header after injection, request bodies, or full URLs if the vendor key ever must be in the URL. APIM can send selected request or response context information to Event Hubs with `log-to-eventhub`, and the implementation should explicitly log only metadata such as timestamp, APIM request ID, operation, status, caller object ID, selected key alias, and latency ([Microsoft Learn: log-to-eventhub](https://learn.microsoft.com/en-us/azure/api-management/log-to-eventhub-policy), [Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor)).

## 7. Admin operations

### 7.1 Onboarding a developer

1. Confirm the developer is an Entra user and can authenticate through the tenant used by the broker. Azure CLI interactive sign-in supports browser-based and device-code authentication for local workflows ([Microsoft Learn: Azure CLI interactive login](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively)).
2. Add the developer to the Entra group mapped to the desired broker app role, such as `VendorApi.KeyA.Invoke`. App roles can be assigned to users and groups for application authorization ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).
3. If APIM subscriptions are used for metering, create or approve the developer/team subscription for the correct product. APIM subscriptions are named containers for subscription keys and can be scoped to products, all APIs, or individual APIs ([Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)).
4. Provide the APIM base URL, broker audience, tenant ID, and a sample `curl` command, but do not provide a vendor API key.

### 7.2 Offboarding and revocation

1. Remove the user from the Entra group or remove their app-role assignment. App roles are the primary authorization source for APIM's JWT claim validation in this design ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy)).
2. Revoke or regenerate any APIM subscription key issued to that user/team if APIM subscriptions are enabled. APIM subscription keys are generated in pairs and can be regenerated with minimal disruption by switching between key A and key B ([Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)).
3. If the user may have had any indirect exposure to a vendor key through an incident, rotate the affected Key Vault secret and revoke the old key at the vendor. Key Vault-backed APIM named values refresh automatically within four hours when unversioned secret identifiers are used, and manual refresh is available for faster APIM update ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).
4. Review APIM, Azure Monitor, Key Vault, and Entra audit logs for the user's object ID, app ID, and request IDs. APIM integrates with Azure Monitor metrics, resource logs, and Application Insights for monitoring, with documented caveats around high-volume logging ([Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor), [Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights)).

### 7.3 Zero-downtime vendor key rotation

**Precondition — zero-downtime rotation requires vendor support for overlapping keys.** The staged overlap below only achieves zero downtime if the vendor supports multiple simultaneously-active keys. If the vendor allows only ONE active key at a time, rotation is a **cutover with an outage window**: coordinate a maintenance window, set the new key in Key Vault, force an immediate APIM named-value refresh, and verify before revoking the old key at the vendor. Document that fallback explicitly in the rotation runbook ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

**Rotation speed for incident response.** The documented ~4-hour auto-refresh cadence is too slow for an active incident. For fast rotation, use a **manual refresh** (Azure portal or management REST API) OR wire an **Event Grid** subscription on the Key Vault `Microsoft.KeyVault.SecretNewVersionCreated` event to trigger an automated APIM named-value refresh (via a Function/Logic App calling the APIM management REST API) so the new secret propagates immediately ([Microsoft Learn: Key Vault Event Grid events](https://learn.microsoft.com/en-us/azure/key-vault/general/event-grid-overview), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

1. Create a new version of the existing Key Vault secret using `az keyvault secret set`, which Microsoft documents as creating or updating a secret in a Key Vault ([Microsoft Learn: az keyvault secret](https://learn.microsoft.com/en-us/cli/azure/keyvault/secret?view=azure-cli-latest)). Key Vault secret values for APIM named-value retrieval must be **1–4096 characters** ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).
2. Keep the APIM named value pointed at the unversioned Key Vault secret URI so APIM can automatically pick up the new secret version. Microsoft states that versioned secret identifiers prevent automatic rotation and unversioned Key Vault-backed named values refresh in APIM within four hours after Key Vault update ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).
3. During the overlap window, keep both old and new vendor keys valid at the vendor if the vendor supports multiple active keys. This overlap absorbs APIM's documented refresh delay and any long-running requests ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).
4. Manually refresh the APIM named value from the Azure portal or management REST API if the vendor requires faster cutover. Microsoft documents manual refresh for Key Vault-backed APIM named values ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).
5. Verify that new requests succeed through APIM, then revoke the old key at the vendor and record the rotation event in the admin change log.

```bash
# Create a new Key Vault secret version without placing the key in code.
# Prefer entering the value interactively in a secure admin shell or reading it from a protected file.
az keyvault secret set \
  --vault-name kv-api-broker-prod \
  --name vendor-api-key-team-a \
  --value '<new-vendor-key-entered-by-admin-only>'
```

### 7.4 Monitoring, quotas, and attribution

Enable APIM Azure Monitor metrics and resource logs, and export selected logs to a Log Analytics workspace for operations and security review. Microsoft documents APIM monitoring through metrics, alerts, activity logs, and resource logs, while noting that the Consumption tier does not support collection of resource logs ([Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor)).

Use APIM `rate-limit` and `quota` policies per product, API, operation, or key alias to prevent one developer/team from exhausting the vendor account. Microsoft documents the `rate-limit` policy and `quota` policy as APIM access restriction policies across APIM policy scopes ([Microsoft Learn: rate-limit](https://learn.microsoft.com/en-us/azure/api-management/rate-limit-policy), [Microsoft Learn: quota](https://learn.microsoft.com/en-us/azure/api-management/quota-policy)).

For attribution, log APIM request ID, Entra object ID (`oid`), client-app ID (`azp` for v2, `appid` fallback), APIM product, APIM operation, key alias such as `vendor-key-a`, response status, latency, and vendor request ID if present. **Keep these attribution values in APIM logs only** — do NOT set them as request headers forwarded to the vendor, because doing so would leak internal Entra object IDs to a third party. The policy in §4 therefore stores `caller-oid`/`caller-azp` in policy variables for diagnostics/`log-to-eventhub` context rather than injecting `x-broker-caller-*` headers into the backend request; only add such headers if the vendor contract explicitly requires them ([Microsoft Learn: log-to-eventhub](https://learn.microsoft.com/en-us/azure/api-management/log-to-eventhub-policy), [Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor)).

### 7.5 Sub-allocating a shared vendor key across callers (rate-limit-by-key / quota-by-key)

Because multiple callers share one vendor key, per-instance `rate-limit` and `quota` will NOT enforce a global ceiling on a scaled-out or multi-region gateway (each instance counts independently). Use **`rate-limit-by-key`** and **`quota-by-key`** instead, which are available in the v2 tiers and enforce a shared counter, keyed on an expression. Key the limits on the **selected key alias** (for example the `vendor-key-a|b|c` chosen in the policy) to sub-allocate the vendor's real RPM/TPM/monthly quota per key, and optionally add the caller `oid` as a secondary key to fair-share within a team. This maps the vendor's actual contractual limits down to individual callers sharing a single upstream credential ([Microsoft Learn: rate-limit-by-key](https://learn.microsoft.com/en-us/azure/api-management/rate-limit-by-key-policy), [Microsoft Learn: quota-by-key](https://learn.microsoft.com/en-us/azure/api-management/quota-by-key-policy)).

### 7.6 Break-glass runbook (single chokepoint)

This broker is a **single chokepoint for ALL vendor access**, so a short break-glass procedure is mandatory. Cover at minimum: (a) **APIM down / region outage** — fail over to a secondary region or availability-zone instance if provisioned, otherwise invoke the documented manual vendor-call fallback under admin control; (b) **managed identity lost Key Vault access** — re-grant `Key Vault Secrets User` to the APIM system-assigned identity and re-validate named-value resolution; (c) **named-value refresh failed** — manual refresh via portal/REST or re-point the named value; (d) **total broker outage** — a break-glass admin retrieves the vendor key directly from Key Vault (audited, time-boxed, rotate immediately after) to sustain critical operations. Key Vault soft-delete and purge protection guard against accidental secret loss during break-glass ([Microsoft Learn: APIM managed identities](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-managed-service-identity), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)).

### 7.7 Availability and disaster recovery

A Standard v2 single-region, single-instance deployment is a chokepoint for every vendor call. Improve availability with: **availability-zone** deployment where the tier/region supports it; **Key Vault soft-delete + purge protection + geo-redundancy** for secret durability; and, if RPO/RTO demand it, **classic Premium multi-region gateways** for active-passive or active-active failover. Record an explicit **RPO/RTO placeholder for the admin to fill** (e.g., “RPO = ____, RTO = ____”) and size the availability design to meet it ([Microsoft Learn: v2 tiers overview](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview), [Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)).

### 7.8 Options analysis: APIM self-hosted gateway

The APIM **self-hosted gateway** is a first-class answer to private-egress and runner-reachability problems: deploy the gateway container into the corporate or Azure network so it can reach private backends and be reached by on-network runners, while control-plane management stays in Azure. The important caveat is that **inbound private endpoints are NOT supported on the self-hosted gateway**, so it solves reachability/egress placement but not the managed-gateway private-endpoint requirement — the two options are complementary, not interchangeable ([Microsoft Learn: self-hosted gateway overview](https://learn.microsoft.com/en-us/azure/api-management/self-hosted-gateway-overview), [Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint)).

### 7.9 Codespaces / GitHub runner reachability (chosen design)

Runner reachability is a **decision, not an open question**. **Primary path:** use self-hosted runners in an Azure VNet (or GitHub-hosted runners with Azure private networking) so CI reaches the private APIM endpoint directly; for Codespaces, use a private network path into the VNet. **Alternative:** if public ingress is required, front APIM with Azure Front Door Premium (Private Link to origin) or Application Gateway WAF — but budget the real cost of that ingress tier. The self-hosted-runner-in-VNet path is the recommended default because it keeps traffic private and avoids a public front door ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: Azure Front Door Private Link](https://learn.microsoft.com/en-us/azure/frontdoor/private-link), [Microsoft Learn: APIM with Application Gateway](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-integrate-internal-vnet-appgateway)).

## 8. Step-by-step implementation plan

### Phase 1: Azure foundation

1. Create a dedicated resource group, for example `rg-api-broker-prod`, for APIM, Key Vault, private DNS, networking resources, and monitoring. Azure resource-group scoping is the normal deployment boundary for APIM named values and Key Vault role assignments used in this design ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)).
2. Create or select the Azure VNet reachable from the Meraki MX private route and VPN, and create subnets for APIM/private endpoint, Application Gateway if used, Azure Firewall/NAT if used, and self-hosted runners if private GitHub access is required. APIM VNet injection and private endpoint configurations require VNet/DNS/NSG planning, and Standard v2 outbound VNet integration has delegated subnet requirements ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts), [Microsoft Learn: v2 outbound VNet integration](https://learn.microsoft.com/en-us/azure/api-management/integrate-vnet-outbound)).
3. Deploy Log Analytics and Application Insights for APIM monitoring, using sampling and selective logging. Microsoft warns that logging all events to Application Insights can have serious performance implications and that Application Insights is not intended as a high-volume audit system ([Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights)).

### Phase 2: Deploy APIM with the right network mode

1. For highest isolation, deploy Premium v2 with VNet injection or classic Premium in internal VNet mode. Microsoft documents Premium v2 VNet injection for isolating inbound and outbound gateway traffic and classic Developer/Premium internal mode for VNet-injected APIM endpoints that are only accessible in the VNet ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts), [Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet)).
2. For cost-conscious private gateway access, deploy Standard v2 and configure an inbound private endpoint, then disable public network access if the service should be private-only. Microsoft documents Standard v2 private endpoint support and states that incoming traffic can be limited to private endpoints by disabling public network access on APIM instances configured with private endpoints ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: v2 tiers](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview)).
3. Configure private DNS for APIM. APIM private endpoints use `privatelink.azure-api.net`, and internal VNet mode requires DNS because the endpoints are not registered on public DNS ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet)).
4. If public ingress is required, deploy Azure Front Door Premium with Private Link or Application Gateway WAF in front of APIM, and still keep APIM JWT validation mandatory. Microsoft documents Front Door Premium Private Link to origins and Application Gateway WAF fronting internal APIM scenarios ([Microsoft Learn: Azure Front Door Private Link](https://learn.microsoft.com/en-us/azure/frontdoor/private-link), [Microsoft Learn: APIM with Application Gateway](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-integrate-internal-vnet-appgateway)).

### Phase 3: Key Vault and APIM identity

1. Create Key Vault with purge protection, soft delete, RBAC or access-policy model, private endpoint/firewall settings, and diagnostic logging. Key Vault supports private endpoint access through Azure Private Link and supports RBAC for authorization management ([Microsoft Learn: Key Vault Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)).
2. Enable APIM system-assigned managed identity, especially if the Key Vault firewall will be enabled. APIM managed identities are generated by Entra ID and eliminate the need to provision or rotate secrets for APIM-to-Azure-resource access ([Microsoft Learn: APIM managed identities](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-managed-service-identity)).
3. Grant the APIM managed identity Key Vault secret `Get` and `List` via access policy or `Key Vault Secrets User` via RBAC. Microsoft documents these permissions and role assignment patterns for APIM named value Key Vault integration ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).
4. Store each vendor key as a separate Key Vault secret with `az keyvault secret set`. Microsoft documents `az keyvault secret set --name --vault-name --value` as creating or updating a secret in Key Vault ([Microsoft Learn: az keyvault secret](https://learn.microsoft.com/en-us/cli/azure/keyvault/secret?view=azure-cli-latest)).
5. Create APIM Key Vault-backed named values for each secret, using unversioned secret URIs. Microsoft documents the Key Vault named value type and warns that versioned secret identifiers prevent automatic rotation ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: APIM namedValues ARM schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/namedvalues)).

### Phase 4: Entra ID authorization

1. Create the Broker API app registration and expose an Application ID URI. Microsoft identity platform APIs use exposed scopes and app roles to authorize client access ([Microsoft Learn: scopes and permissions](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc), [Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).
2. Add delegated scope `VendorApi.Invoke` for interactive developer tools and app roles `VendorApi.KeyA.Invoke`, `VendorApi.KeyB.Invoke`, and `VendorApi.KeyC.Invoke` for key-specific access. Microsoft documents delegated scopes and app roles as token-claim authorization mechanisms ([Microsoft Learn: scopes and permissions](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc), [Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).
3. Assign Entra groups and GitHub workload service principals to app roles. App role assignments are the admin-controlled grant mechanism in this design ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).
4. Create client app registrations if local tools require interactive MSAL flows, and grant them delegated permission to call the Broker API. Azure CLI and app permission commands can manage OAuth2 permissions, including delegated scopes and app roles ([Microsoft Learn: az ad app permission](https://learn.microsoft.com/en-us/cli/azure/ad/app/permission?view=azure-cli-latest)).

### Phase 5: APIM API and policies

1. Import or create the APIM API that represents the vendor API paths to broker. APIM backends can store backend base URLs and can be referenced by policies for reuse ([Microsoft Learn: APIM backends](https://learn.microsoft.com/en-us/azure/api-management/backends)).
2. Apply the inbound policy in Section 4 at the API scope or product scope. APIM policy scopes include global, product, API, and operation, but product-scope policies do not apply to API-scoped or all-APIs subscriptions ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy), [Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)).
3. Configure rate limiting and quotas aligned to vendor limits. APIM includes rate-limit and quota policies for access restriction ([Microsoft Learn: rate-limit](https://learn.microsoft.com/en-us/azure/api-management/rate-limit-policy), [Microsoft Learn: quota](https://learn.microsoft.com/en-us/azure/api-management/quota-policy)).
4. Configure diagnostics to log metadata only and never log vendor key headers, query strings, or bodies. Microsoft documents Azure Monitor and Application Insights integration and warns about logging performance impact and audit limitations ([Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor), [Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights)).

### Phase 6: GitHub OIDC

1. Create an Entra workload app registration or managed identity dedicated to GitHub CI for each trust boundary, such as repo/environment. Microsoft documents workload identity federation as trusting tokens from an external identity provider instead of storing long-lived secrets ([Microsoft Learn: workload identity federation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation)).
2. Add a federated identity credential with issuer `https://token.actions.githubusercontent.com` (**no trailing slash**), audience `api://AzureADTokenExchange`, and a subject tied to the repo and environment. The subject form `repo:ORG/REPO:environment:<Name>` is used for environment-scoped runs; branch/tag subject forms (`repo:ORG/REPO:ref:refs/heads/<branch>`) must match the workflow trigger mode. Microsoft and GitHub document this subject/audience/issuer model for GitHub Actions OIDC to Azure and note that the issuer has no trailing slash ([GitHub Docs: OIDC token reference](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect), [Microsoft Learn: workload identity federation trust with GitHub](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-github)).
3. Assign the GitHub workload service principal to the required broker app role. App roles support assignment to applications/service principals for workload authorization ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)).
4. Use `azure/login` in workflows and then request a **v2** access token for the broker with `az account get-access-token --scope "<appIdUri>/.default"` (never `--resource`, which yields a v1 token). Note that `azure/login` only proves the workflow logged in as the service principal — it does NOT prove the acquired broker token carries the app role, so add a step that decodes the token and asserts the expected `aud`/`iss`/`roles` before calling APIM ([Microsoft Learn: Azure OIDC with GitHub Actions](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect), [Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

```bash
# Example federated credential creation for an Entra app registration.
cat > github-federated-credential.json <<'JSON'
{
  "name": "github-main-prod",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:ORG/REPO:environment:Production",
  "description": "GitHub Actions Production environment trust for API broker",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON

az ad app federated-credential create \
  --id '<github-workload-app-client-id-or-object-id>' \
  --parameters @github-federated-credential.json
```

### Phase 7: Testing and rollout

1. Test denial with no token, wrong audience, wrong issuer, and missing app role. APIM `validate-jwt` can enforce audiences, issuers, and required claims in the inbound policy ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy)).
2. Test that client-supplied `x-api-key`, `api_key`, and similar values are removed and replaced server-side. APIM `set-header` and `set-query-parameter` support deleting and overriding request values ([Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy)).
3. Test that logs contain the key alias but never the real vendor key. APIM logging should be configured for selected context only rather than full sensitive headers or bodies ([Microsoft Learn: log-to-eventhub](https://learn.microsoft.com/en-us/azure/api-management/log-to-eventhub-policy), [Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights)).
4. Test private network access through Meraki on-prem and VPN DNS resolution. APIM private endpoints and internal VNet mode require correct private DNS mapping to private IPs ([Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet)).
5. Roll out team by team, beginning with a sandbox vendor key and a small Entra group. APIM products, groups, and subscriptions can be used to package access and apply quotas during rollout ([Microsoft Learn: APIM products](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-create-products), [Microsoft Learn: APIM groups](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-create-groups), [Microsoft Learn: APIM subscriptions](https://learn.microsoft.com/en-us/azure/api-management/api-management-subscriptions)).

## 9. Example artifacts

### 9.1 GitHub Actions workflow using OIDC

This workflow uses GitHub OIDC to log in to Azure without a stored Azure client secret, requests a **v2** access token for the broker with `--scope "<appIdUri>/.default"`, asserts the token's `aud`/`iss`/`roles` (because `azure/login` proves only SP login, not app-role possession), and then calls APIM with that token. GitHub documents the need for `id-token: write`, and Microsoft documents Azure login with OIDC and `az account get-access-token` for access-token acquisition ([GitHub Docs: OIDC in Azure](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure), [Microsoft Learn: Azure OIDC with GitHub Actions](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect), [Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token)).

```yaml
name: Call APIM key broker

on:
  workflow_dispatch:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

env:
  # v2 scope form; APP_ID_URI is api://<broker-client-id> or a custom App ID URI.
  BROKER_SCOPE: api://00000000-0000-0000-0000-000000000000/.default
  # Expected v2 audience is the client-ID GUID (aud), and expected issuer is the v2 endpoint.
  EXPECTED_AUD: 00000000-0000-0000-0000-000000000000
  EXPECTED_ISS: https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0
  # Publicly-registered name that resolves to the private endpoint for private clients.
  BROKER_BASE_URL: https://broker.contoso.com

jobs:
  call-broker:
    runs-on: ubuntu-latest
    environment: Production
    steps:
      - uses: actions/checkout@v4

      - name: Azure login via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: Acquire v2 broker token and assert claims
        shell: bash
        run: |
          set -euo pipefail
          # --scope requests a v2 token; --resource would request a v1 token and be rejected.
          TOKEN=$(az account get-access-token \
            --scope "$BROKER_SCOPE" \
            --query accessToken -o tsv)
          echo "::add-mask::$TOKEN"

          # azure/login only proves SP login; it does NOT prove the token carries the app role.
          # Decode the JWT payload and assert aud/iss/roles before calling APIM.
          PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | awk '{l=length($0)%4; if(l>0)for(i=0;i<4-l;i++)$0=$0"="; print}' | base64 -d 2>/dev/null)
          AUD=$(echo "$PAYLOAD" | jq -r '.aud')
          ISS=$(echo "$PAYLOAD" | jq -r '.iss')
          ROLES=$(echo "$PAYLOAD" | jq -r '(.roles // []) | join(",")')
          echo "aud=$AUD iss=$ISS roles=$ROLES"
          [ "$AUD" = "$EXPECTED_AUD" ] || [ "$AUD" = "api://$EXPECTED_AUD" ] || { echo "aud mismatch"; exit 1; }
          [ "$ISS" = "$EXPECTED_ISS" ] || { echo "iss mismatch (expected v2 issuer)"; exit 1; }
          echo "$ROLES" | grep -q 'VendorApi.Key' || { echo "no vendor-key role in token (check Application allowedMemberTypes + direct app-role assignment)"; exit 1; }
          echo "BROKER_TOKEN=$TOKEN" >> "$GITHUB_ENV"

      - name: Call broker without vendor key
        shell: bash
        run: |
          curl --fail-with-body \
            -H "Authorization: Bearer ${BROKER_TOKEN}" \
            -H "Content-Type: application/json" \
            --data '{"prompt":"hello from CI"}' \
            "$BROKER_BASE_URL/v1/vendor/endpoint"
```

### 9.2 Local developer token and call

A local developer obtains a **v2** Entra token for the broker API and calls APIM with only a bearer token. Azure CLI supports interactive login and `az account get-access-token --scope "<appIdUri>/.default"` returns a v2 access token; `--resource` would return a v1 token whose `iss`/`aud` do not match the policy ([Microsoft Learn: Azure CLI interactive login](https://learn.microsoft.com/en-us/cli/azure/authenticate-azure-cli-interactively), [Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

```bash
TENANT_ID='11111111-1111-1111-1111-111111111111'
# v2 scope form (.default). --scope requests a v2 token; --resource would request v1 and be rejected.
BROKER_SCOPE='api://00000000-0000-0000-0000-000000000000/.default'
# Publicly-registered name that resolves to the private endpoint for private (on-prem/VPN) clients.
BROKER_BASE_URL='https://broker.contoso.com'

az login --tenant "$TENANT_ID" --use-device-code

TOKEN=$(az account get-access-token \
  --tenant "$TENANT_ID" \
  --scope "$BROKER_SCOPE" \
  --query accessToken -o tsv)

curl --fail-with-body \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"input":"local test"}' \
  "$BROKER_BASE_URL/v1/vendor/endpoint"
```

### 9.3 MSAL-style local application behavior

A local app should request a delegated access token for the broker resource and place only that token in the APIM request. Microsoft documents OAuth2 authorization-code flow for interactive delegated access, and this app must never read, store, or transmit the vendor key itself ([Microsoft Learn: OAuth2 authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [Microsoft Learn: scopes and permissions](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc)).

```text
1. User signs in to Entra ID.
2. Local app requests scope: api://<broker-api-client-id>/VendorApi.Invoke.
3. Entra ID returns an access token for the broker API.
4. Local app calls APIM with Authorization: Bearer <broker-token>.
5. APIM validates token, injects vendor key server-side, and forwards to vendor.
```

## 10. Cost, tiers, and trade-offs

| Option | Advantages | Trade-offs | Recommended use |
|---|---|---|---|
| Developer tier | Low-cost evaluation and supports classic VNet injection in internal mode. | Microsoft states Developer has no SLA and is not suitable for production ([Microsoft Learn: upgrade and scale APIM](https://learn.microsoft.com/en-us/azure/api-management/upgrade-and-scale), [Azure API Management pricing](https://azure.microsoft.com/en-us/pricing/details/api-management/)). | Lab and proof of concept only. |
| Standard v2 | Production-ready v2 tier with lower cost than Premium and support for inbound private endpoints and outbound VNet integration. | Standard v2 cannot be deployed entirely inside a VNet and its management plane/developer portal remain public with outbound VNet integration ([Microsoft Learn: v2 tiers](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview), [Microsoft Learn: v2 outbound VNet integration](https://learn.microsoft.com/en-us/azure/api-management/integrate-vnet-outbound)). | Recommended cost-conscious production default when private endpoint plus disabled public network access is acceptable. |
| Premium classic | Mature enterprise tier with classic VNet internal mode and multi-region support. | Higher cost and longer provisioning than v2 in many cases; classic internal mode applies to Developer/Premium ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts), [Azure API Management pricing](https://azure.microsoft.com/en-us/pricing/details/api-management/)). | Production private-only APIM where classic features or multi-region are needed. |
| Premium v2 | Enterprise v2 option with full virtual network isolation, high scale, and availability-zone capabilities. | Highest-cost v2 direction and newer feature surface; verify regional availability and feature gaps before commitment ([Microsoft Learn: v2 tiers](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview), [Azure API Management pricing](https://azure.microsoft.com/en-us/pricing/details/api-management/)). | Strategic target for high-volume, private-only gateway isolation. |
| Consumption | Serverless billing per execution. | Not appropriate for this private broker if private networking, resource logs, or stable enterprise controls are required; Microsoft notes Consumption does not support resource log collection ([Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor), [Azure API Management pricing](https://azure.microsoft.com/en-us/pricing/details/api-management/)). | Avoid for this hard-security broker unless requirements are relaxed. |

Key Vault costs are typically minor for API-key storage but include secret transactions, certificate operations, key operations, and automated rotation charges depending on usage. Microsoft lists Key Vault vault secret operations at a per-transaction price category and notes prices are estimates that vary by agreement, purchase date, currency, and other factors ([Azure Key Vault pricing](https://azure.microsoft.com/en-us/pricing/details/key-vault/)).

Application Gateway WAF, Azure Front Door Premium, Azure Firewall, NAT Gateway, Log Analytics ingestion, and self-hosted runner compute are additional cost drivers if the network design requires public ingress, private egress control, or GitHub private connectivity. Microsoft documents Front Door Premium Private Link, Application Gateway WAF, and APIM/Application Insights logging as separate services or features that should be costed independently ([Microsoft Learn: Azure Front Door Private Link](https://learn.microsoft.com/en-us/azure/frontdoor/private-link), [Microsoft Learn: Application Gateway WAF](https://learn.microsoft.com/en-us/azure/web-application-firewall/ag/ag-overview), [Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights)).

## 11. Security and compliance considerations

### 11.1 Least privilege

Only the admin and infrastructure pipeline should be allowed to create or edit vendor Key Vault secrets, APIM named values, APIM policies, APIM backends, Entra app roles, and GitHub federated credentials. Microsoft explicitly warns that APIM policy editors using managed-identity policies may be able to obtain or forward managed-identity tokens if policy authoring is not tightly controlled ([Microsoft Learn: authentication-managed-identity](https://learn.microsoft.com/en-us/azure/api-management/authentication-managed-identity-policy)).

**The durable least-privilege control is RBAC on the APIM MANAGED IDENTITY, not just restricting who can edit policy.** Restricting policy authors is necessary but insufficient: a rogue policy author could use `send-request` + `authentication-managed-identity` against `https://vault.azure.net` to read ANY secret the identity can reach. Therefore constrain the APIM managed identity's Key Vault RBAC to **`Key Vault Secrets User` (get) scoped to ONLY the specific vendor-key secrets** it must read — not the whole vault, and never a broader role — so that even an abusive policy cannot exfiltrate unrelated secrets. Human users should not have routine read access to vendor-key secret values ([Microsoft Learn: authentication-managed-identity](https://learn.microsoft.com/en-us/azure/api-management/authentication-managed-identity-policy), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

### 11.2 Audit logging

Enable Key Vault diagnostic logging, APIM Azure Monitor logs, Entra audit/sign-in logs, and GitHub workflow audit trails, then correlate them using APIM request IDs and Entra object IDs. APIM integrates with Azure Monitor for metrics, alerts, activity logs, and resource logs, and Key Vault supports diagnostic and access logging through Azure monitoring features ([Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor), [Microsoft Learn: Key Vault Private Link](https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service)).

Do not rely on Application Insights as the sole audit system for every request, because Microsoft states that Application Insights is not intended as an audit system and is not suited for logging each individual request for high-volume APIs. Use Azure Monitor/Log Analytics and selective `log-to-eventhub` metadata for security investigations while redacting all credential-bearing fields ([Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights), [Microsoft Learn: log-to-eventhub](https://learn.microsoft.com/en-us/azure/api-management/log-to-eventhub-policy)).

### 11.3 PCI-relevant notes

If the vendor API handles cardholder data or PCI-relevant payloads, APIM diagnostics must avoid logging PAN, sensitive authentication data, bearer tokens, vendor keys, and full request/response bodies. This design's default metadata-only logging supports PCI minimization by recording caller, route, status, latency, and key alias rather than sensitive data, and Microsoft’s Application Insights guidance reinforces that high-volume full-request logging is not appropriate for audit use ([Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights), [Microsoft Learn: APIM Azure Monitor](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-use-azure-monitor)).

### 11.4 Rotation cadence

Rotate vendor keys on a regular cadence agreed with the vendor, after any suspected exposure, after offboarding high-risk personnel, and after policy or logging incidents that could have disclosed credential material. Key Vault secret versioning plus unversioned APIM named values supports staged rotation with APIM refresh within four hours and optional manual refresh ([Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: az keyvault secret](https://learn.microsoft.com/en-us/cli/azure/keyvault/secret?view=azure-cli-latest)).

## 12. Acceptance criteria

1. A developer can call the vendor through APIM after Entra authentication and app-role assignment, without seeing or storing a vendor key. APIM validates JWTs and injects headers server-side through documented inbound policies ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy), [Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy)).
2. A developer with no app role receives `401` or `403` from APIM and no vendor request is sent. APIM `validate-jwt` supports failed-validation responses and required claims, and `return-response` can produce a custom deny response ([Microsoft Learn: validate-jwt](https://learn.microsoft.com/en-us/azure/api-management/validate-jwt-policy), [Microsoft Learn: return-response](https://learn.microsoft.com/en-us/azure/api-management/return-response-policy)).
3. A request containing a fake `x-api-key` or `api_key` from the client still uses only the server-selected Key Vault-backed named value. APIM `set-header` and `set-query-parameter` support delete and override actions for inbound requests ([Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy), [Microsoft Learn: set-query-parameter](https://learn.microsoft.com/en-us/azure/api-management/set-query-parameter-policy)).
4. GitHub Actions can call APIM using OIDC without any vendor key or Azure client secret in repository secrets. GitHub and Microsoft document OIDC federation from GitHub Actions to Azure without long-lived secrets ([GitHub Docs: OIDC concepts](https://docs.github.com/en/actions/concepts/security/openid-connect), [Microsoft Learn: Azure OIDC with GitHub Actions](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)).
5. APIM logs and downstream logs do not contain real vendor keys, bearer tokens, or credential-bearing query strings. APIM supports selective context logging and Microsoft warns against high-volume full logging in Application Insights ([Microsoft Learn: log-to-eventhub](https://learn.microsoft.com/en-us/azure/api-management/log-to-eventhub-policy), [Microsoft Learn: APIM Application Insights](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-app-insights)).
6. Removing a user from the Entra group/app role blocks future authorized broker access, and rotating the vendor key in Key Vault updates APIM without client changes. App roles control authorization claims, and Key Vault-backed APIM named values refresh from unversioned Key Vault secret identifiers ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)).

## 13. Final recommendation

Present the tier decision honestly as a **fork**, because the DNS-resolvability constraint (§5.1a) changes the cost math:

**Option 1 — true private-only (recommended when “never trust the endpoint” is strict):** classic **Premium internal VNet mode** OR **Premium v2 VNet injection**. These support genuinely private, non-public-resolvable endpoints and full VNet isolation for both inbound AND outbound traffic, so the gateway name never needs to be publicly resolvable ([Microsoft Learn: APIM virtual network concepts](https://learn.microsoft.com/en-us/azure/api-management/virtual-network-concepts), [Microsoft Learn: internal VNet mode](https://learn.microsoft.com/en-us/azure/api-management/api-management-using-with-internal-vnet), [Microsoft Learn: v2 tiers overview](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview)).

**Option 2 — cost-conscious:** **Standard v2 + inbound private endpoint + disabled public access + a publicly-registered apex (`broker.contoso.com`) with split-horizon DNS + Azure DNS Private Resolver.** This works, but the supplementary infrastructure erodes the savings: on Standard v2 the gateway name must be publicly resolvable (§5.1a), on-prem/VPN resolution requires an Azure DNS Private Resolver (added cost), and if fixed egress, WAF, or public ingress is needed you must add NAT/Azure Firewall, Front Door Premium, or Application Gateway (§5.1b). Once those are summed, Standard v2 can approach the cost of Premium while giving less isolation — so pick Option 2 only when the DNS-Resolver-plus-private-endpoint total is genuinely below the Premium delta ([Microsoft Learn: v2 tiers overview](https://learn.microsoft.com/en-us/azure/api-management/v2-service-tiers-overview), [Microsoft Learn: APIM private endpoint](https://learn.microsoft.com/en-us/azure/api-management/private-endpoint), [Microsoft Learn: Azure DNS Private Resolver](https://learn.microsoft.com/en-us/azure/dns/dns-private-resolver-overview)).

The safest authorization model is **Entra app roles per vendor key alias**, not local API keys or GitHub secrets. The safest secret model is **Key Vault secret per vendor key plus APIM Key Vault-backed named value per key**, with APIM policy branches selecting a named value by role and injecting the real vendor key only on the APIM-to-vendor request ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: APIM named values](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties), [Microsoft Learn: set-header](https://learn.microsoft.com/en-us/azure/api-management/set-header-policy)).

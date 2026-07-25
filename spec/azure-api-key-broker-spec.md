# Serverless Azure Function API Key Broker Technical Specification

> **What this is:** A complete, standalone design for a server-side vendor API key broker built on **Azure Functions (Flex Consumption)** instead of Azure API Management. It is the **cost-optimized alternative** to the APIM-based design in `azure-api-key-broker-spec.md`: roughly **~$40/month (~$480/year) versus ~$1,067/month** for APIM Standard v2 core, a ~96% reduction, with **every** security property of the APIM spec preserved. APIM buys convenience (a turnkey policy engine, portal dashboards, built-in quota-by-key, managed named-value rotation). It does **not** buy security you cannot otherwise build in ~200 lines of broker code.
>

> This spec deliberately reuses the APIM spec's requirements, terminology, hostname (`broker.contoso.com`), v2 token conventions, and app-role names so the two designs are directly interchangeable.

---

## 0. Non-negotiable security objective (identical to the APIM design)

This design implements an Azure Function as a server-side API key broker: developers, local tools, and GitHub Actions jobs call the broker with their own Microsoft Entra ID identity; the broker validates that identity, retrieves the real vendor API key from Azure Key Vault via a managed identity, injects the vendor key into the upstream request server-side, and returns only the vendor response. Azure Functions run trusted server-side code that the caller cannot inspect, so the injected vendor credential is present only on the broker-to-vendor leg and is never returned to the client ([Microsoft Learn: Azure Functions overview](https://learn.microsoft.com/en-us/azure/azure-functions/functions-overview)).

The hard requirement is unchanged: the real vendor API keys never leave Azure. They must not appear in local source code, GitHub repository secrets, GitHub Actions logs, browser developer tools, `.env` files, local configuration files, request URLs, client headers, or client logs. Vendor keys live only in Azure Key Vault and are read by the Function's managed identity ([Microsoft Learn: Key Vault secrets](https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets), [Microsoft Learn: managed identities for Azure resources](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview)).

The same requirements the APIM design satisfies apply here. Developers call the broker with their **own** Entra ID identity and never see the vendor key. Keys are selected by the caller's Entra app role: the original APIM design covered **one** vendor, and the deployed Node broker generalizes that to **one or more**, each app role mapped to a vendor via `ROLE_SECRET_MAP`. The admin solely controls key creation, rotation, and access. Callers work from a GitHub codebase (GitHub Actions, and SAML->Entra SSO for humans) or locally, and all of them are Entra ID identities. Connectivity is your **existing** private ingress path from on-prem plus VPN ingress (e.g. site-to-site VPN, ExpressRoute, or an SD-WAN/edge-appliance route into the VNet).

---

## 1. Overview: what changes versus APIM (and what does not)

The broker pattern is unchanged. Only the enforcement engine changes, from an APIM policy pipeline to a small amount of Function code. The table below is the honest accounting of the trade.

| Capability | APIM approach | Function broker approach | Security parity |
|---|---|---|---|
| Token validation (issuer/audience/expiry) | `validate-jwt` inbound policy | **Easy Auth** platform validation before code runs (recommended), or `Microsoft.Identity.Web` in-code | Same guarantee |
| Role-based key selection | `choose` policy branches on `roles[]` | Exact array-membership match in code with multi-role 403 (default; opt-in `MULTI_ROLE_VENDOR_ROUTING` enables vendor-named multi-role routing) | Same guarantee |
| Secret storage | Key Vault-backed named values | Key Vault secrets read by managed identity + in-memory TTL cache | Same guarantee |
| Credential scrubbing | `set-header`/`set-query-parameter` deletes | Canonicalize-and-allowlist scrub in code across headers/query/body | **Stronger** (allowlist, not denylist) |
| Private networking | Private endpoint + DNS Private Resolver | Private endpoint on existing VNet + NSG IP filtering | Same guarantee, lower cost |
| Rate limit / quota by key | `rate-limit-by-key` / `quota-by-key` policy | Code-enforced limits backed by Azure Table/Redis | Same guarantee, you own the code |
| Rotation | 4-hour named-value auto-refresh | Cache TTL + optional Key Vault Event Grid cache-bust | **Faster** incident response |
| Observability | Azure Monitor / App Insights | Application Insights (same backend) | Same guarantee |
| **What you give up** | n/a | Turnkey policy GUI, portal dashboards, built-in quota-by-key, managed named-value rotation, a developer portal | Convenience only, **not security** |

The load-bearing point, confirmed by the model council against Microsoft Learn: the broker's security properties are properties of **identity validation, least-privilege secret access, server-side injection, and credential scrubbing**. All four are ordinary application concerns that a Function implements directly ([Microsoft Learn: Azure Functions overview](https://learn.microsoft.com/en-us/azure/azure-functions/functions-overview), [Microsoft Learn: App Service/Functions authentication](https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization)).

---

## 2. Compute-host decision

**Primary recommendation: Azure Functions Flex Consumption with 1 always-ready instance (2 GiB), VNet-integrated.** Flex Consumption supports virtual-network integration, configurable **always-ready** instances that eliminate cold starts, per-instance concurrency, and fast scale to as many as 1,000 instances. That is the profile for an interactive internal broker where a handful of developers and CI jobs need low, predictable first-call latency ([Microsoft Learn: Flex Consumption plan](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan), [Azure Functions pricing](https://azure.microsoft.com/en-us/pricing/details/functions/)). One always-ready 2 GiB instance costs about **$26/month of compute**. Add Key Vault, Application Insights, and the Function storage account and the realistic total is **~$40/month** on the default existing-VNet + private endpoint networking (§7, §13).

**Decision table:**

| Host option | Cold start | Monthly cost | Best when |
|---|---|---|---|
| **Flex Consumption, 1 always-ready (2 GiB)** (recommended) | None | **~$40** | Interactive devs + CI need predictable first-call latency; existing VNet reused |
| Flex Consumption, scale-to-zero | ~1–2 s first call | ~$13 | Callers tolerate occasional cold-start latency; cost is paramount |
| Azure Container Apps (min-1 replica or scale-to-zero) | None / ~1–2 s | ~$5–40 | Team prefers containers, needs a richer runtime, or wants the generous free grant |

Flex Consumption **scale-to-zero** removes the always-ready baseline and falls back to on-demand billing (with the monthly free grant of execution time and executions), landing near **~$13/month** at the cost of a ~1–2 s cold start on the first call after idle ([Microsoft Learn: Flex Consumption plan](https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan), [Azure Functions pricing](https://azure.microsoft.com/en-us/pricing/details/functions/)).

**Azure Container Apps** is a strong alternative if the team prefers containers (fitting a Proxmox/homelab operating style) or needs a fuller runtime. Container Apps bills for vCPU-seconds and memory GiB-seconds plus requests, and provides a monthly **free grant per subscription** of 180,000 vCPU-seconds, 360,000 GiB-seconds, and 2,000,000 requests, so a single small broker often stays within or near the free grant ([Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/), [Microsoft Learn: Container Apps billing](https://learn.microsoft.com/en-us/azure/container-apps/billing)). Container Apps supports VNet integration and ingress IP restrictions for the same private-networking posture ([Microsoft Learn: Container Apps networking](https://learn.microsoft.com/en-us/azure/container-apps/networking)).

**Flex Consumption with 1 always-ready instance is the default.** It removes cold-start surprises for interactive developers, integrates with the existing VNet for outbound calls to the vendor, and costs ~$40/month all-in.

---

## 3. Architecture

### 3.1 Data flow

```text
Developer laptop / CLI  OR  GitHub Actions runner
        |
        | 1. Authenticates to Entra ID (OAuth2/OIDC). No vendor key is ever issued to the client.
        v
Microsoft Entra ID
        |
        | 2. Issues a v2 access token: audience = broker app client-id GUID (or api://<client-id>),
        |    issuer = https://login.microsoftonline.com/<tenant>/v2.0, roles = the caller's vendor-key role.
        v
[ EXISTING VNet ingress: your private ingress path from on-prem + VPN ]
        |
        | 3. Reaches broker.contoso.com over the existing private path; inbound is restricted
        |    to the on-prem/VPN ingress CIDR ranges with public network access disabled.
        v
Azure Function broker (Flex Consumption, VNet-integrated)
        |  3a. Easy Auth validates the JWT (issuer/audience/expiry) BEFORE code runs.
        |  3b. Code reads validated claims from X-MS-CLIENT-PRINCIPAL.
        |  3c. Selects the vendor key by EXACT app-role array membership (multi/zero role -> 403 by
        |      default; opt-in MULTI_ROLE_VENDOR_ROUTING lets a caller name the vendor in the path
        |      /broker/<vendor>/... and hold several vendor roles).
        |  3d. Reads the key from Key Vault via SYSTEM-ASSIGNED managed identity (cached, TTL).
        |  3e. Canonicalizes + allowlist-scrubs all caller-supplied credential locations.
        |  3f. Injects the vendor key server-side. Caller oid/appid are NOT forwarded to the vendor.
        v
Vendor backend API(s) — one or more vendors via ROLE_SECRET_MAP (over VNet-integrated outbound)
        |
        | 4. Vendor receives only the broker's request with the real key.
        v
        |  4a. Broker strips/scrubs the response; the vendor key is never returned to the caller.
        v
Caller receives only the brokered response.
```

### 3.2 Component list

| Component | Role in the broker | Azure implementation |
|---|---|---|
| Client: local developer | Calls the broker with an Entra token, never a vendor key. | `az login` + `az account get-access-token --scope "<appIdUri>/.default"` (v2), then `Authorization: Bearer <token>` ([Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token)). |
| Client: GitHub Actions | Uses GitHub OIDC to obtain an Entra token with no stored secret. | Federated identity credential + `azure/login` with `id-token: write` ([Microsoft Learn: GitHub OIDC to Azure](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)). |
| Microsoft Entra ID | Identity provider and authorization-claim issuer. | Broker app registration exposes app roles; admin assigns users, groups, and workload service principals ([Microsoft Learn: app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps)). |
| Azure Function (broker) | Broker enforcement point. | Easy Auth validates JWTs; code selects a key, scrubs credentials, injects the vendor key, forwards to the vendor ([Microsoft Learn: Functions authentication](https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization)). |
| Azure Key Vault | Secret store for real vendor keys. | One secret per vendor key; Function managed identity holds `Key Vault Secrets User` scoped to only those secrets ([Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)). |
| Vendor API | One or more upstream vendor APIs; each app role maps to a vendor via `ROLE_SECRET_MAP`. | Function injects the selected key server-side. Inject modes: `header`, `bearer`, `basic`, `pair`, `oauth2cc` (client-credentials: the broker mints and caches the vendor Bearer). |
| Existing VNet + private ingress path | Private ingress and (optionally) egress path. | Function VNet integration for outbound; inbound via a private endpoint whose subnet NSG is scoped to the on-prem/VPN ingress CIDR ranges ([Microsoft Learn: Functions networking options](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options)). |

---

## 4. Identity and authentication (v2, matching the APIM design)

### 4.1 Two validation options (Easy Auth recommended)

**(a) Easy Auth (recommended).** App Service / Functions built-in authentication validates the Entra JWT **at the platform, before your code runs**. Issuer, audience, and signature are checked by the platform; your code reads the already-validated claims from the injected `X-MS-CLIENT-PRINCIPAL` header (base64-encoded JSON). This is the lower-code, more-secure default, because token validation is exactly the kind of thing hand-written code gets subtly wrong ([Microsoft Learn: authentication and authorization in App Service/Functions](https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization), [Microsoft Learn: configure Microsoft Entra authentication](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-provider-aad), [Microsoft Learn: access user identity / client principal](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-user-identities)). Configure the identity provider as Microsoft, set **"Require authentication"** so unauthenticated requests are rejected with HTTP 401, and set the **allowed token audiences** to the broker app client-id GUID and `api://<client-id>` ([Microsoft Learn: configure Microsoft Entra authentication](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-provider-aad)).

**(b) In-code validation (fallback).** For full control, validate in code with `Microsoft.Identity.Web` / MSAL, which performs the same issuer/audience/signature checks and exposes typed claims. Use this only when you need custom validation logic Easy Auth cannot express ([Microsoft Learn: Microsoft.Identity.Web](https://learn.microsoft.com/en-us/entra/msal/dotnet/microsoft-identity-web/), [Microsoft Learn: protected web API token validation](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-protected-web-api-verification-scope-app-roles)).

### 4.2 Standardize on v2 tokens (the council's v1/v2 correction)

The design standardizes on the **v2 token endpoint**, matching the APIM spec exactly. The audience `aud` is the **client-ID GUID** of the Broker app (the policy and Easy Auth also accept `api://<client-id>`), and the issuer is `https://login.microsoftonline.com/<tenant>/v2.0`. The Broker app manifest MUST set `requestedAccessTokenVersion: 2`. Without it, Entra issues v1 tokens whose `iss`/`aud` do not match, and every call is rejected ([Microsoft Learn: app manifest reference](https://learn.microsoft.com/en-us/entra/identity-platform/reference-app-manifest), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

**A v1/v2 mismatch is the most common cause of token rejection.** `az account get-access-token --resource <uri>` requests a **v1** token; `--scope "<appIdUri>/.default"` requests a **v2** token. All token-acquisition examples in this spec (§4.4, §15) therefore use `--scope`, never `--resource`. That is the exact correction the council flagged ([Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)). Because we standardize on v2, the broker logs `azp` (v2) rather than `appid` (v1-only), keeping `appid` only as a residual fallback ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)).

### 4.3 App roles (including the CI `Application` fix)

Define app roles on the Broker app registration, identical to the APIM design:

| App role value | Intended callers | Key-selection implication |
|---|---|---|
| `VendorApi.KeyA.Invoke` | Team A / purpose A | Broker selects Key Vault secret `vendor-api-key-team-a`. |
| `VendorApi.KeyB.Invoke` | Team B / purpose B | Broker selects Key Vault secret `vendor-api-key-team-b`. |
| `VendorApi.KeyC.Invoke` | CI workload / automation | Broker selects Key Vault secret `vendor-api-key-ci`. |

**App roles used by CI must include `Application` in `allowedMemberTypes`.** If a broker app role only allows `User`, a CI **app-only** token carries **no `roles` claim** and every CI call returns 403. This is the most likely day-one CI failure. Set `allowedMemberTypes` to include `Application` (and `User` where humans also use the role), grant the workload service principal a **direct app-role assignment** to the Broker service principal, and complete admin consent ([Microsoft Learn: add app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)). The assignment must never go through a group: Entra omits the `roles` claim for application tokens in the group-nesting case. For defense in depth, enable **"Assignment required"** on the Broker enterprise application so role-less app-only tokens fail at issuance rather than only at the broker ([Microsoft Learn: restrict an app to a set of users](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users)).

### 4.4 GitHub Actions and human SSO (two distinct flows)

**GitHub Actions** use OIDC workload identity federation: configure an Entra federated identity credential whose issuer is **exactly** `https://token.actions.githubusercontent.com` (**no trailing slash**, per GitHub's OIDC reference; the council's exactness fix), whose exchange audience is `api://AzureADTokenExchange`, and whose subject restricts trust to the specific org/repo/ref/environment. Issuer, subject, and audience matching is exact and case-sensitive ([GitHub Docs: about security hardening with OpenID Connect](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect), [Microsoft Learn: workload identity federation trust with GitHub](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-github)).

**Human developers** authenticate to GitHub via **SAML SSO -> Entra**, a distinct mechanism from the OIDC workload flow. SAML SSO authenticates human users to GitHub Enterprise Cloud through the identity provider; GitHub Actions OIDC lets a workflow exchange a short-lived token for cloud access without stored secrets ([GitHub Docs: about authentication with SAML SSO](https://docs.github.com/en/enterprise-cloud@latest/authentication/authenticating-with-saml-single-sign-on/about-authentication-with-saml-single-sign-on), [GitHub Docs: OpenID Connect concepts](https://docs.github.com/en/actions/concepts/security/openid-connect)). Note that user MFA / SAML protects human GitHub sign-in and does **not** protect the GitHub Actions OIDC flow; workload-identity Conditional Access is a separate, blocking-only regime ([Microsoft Learn: Conditional Access for workload identities](https://learn.microsoft.com/en-us/entra/identity/conditional-access/workload-identity)).

---

## 5. Key-selection logic

The broker reads `roles` as an **array** from the validated claims (from `X-MS-CLIENT-PRINCIPAL` under Easy Auth, or from the typed `ClaimsPrincipal` under in-code validation), counts how many **recognized** vendor-key roles the caller holds, and returns **403** unless the count is exactly one. Selection uses **exact array-element membership**, never a substring match on a joined string. That is the code equivalent of the fixed APIM policy, and it kills the council-flagged exploit where a future role such as `VendorApi.KeyA.InvokeReadOnly` would wrongly match `VendorApi.KeyA.Invoke` on a substring test ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference), [Microsoft Learn: client principal / user identities](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-user-identities)).

> **Deployed-broker note: default vs. opt-in multi-role routing.** The exactly-one-role rule above is the **default** and remains the out-of-the-box behavior. The deployed Node broker (`function-node/src/broker.js`) adds an opt-in app setting **`MULTI_ROLE_VENDOR_ROUTING`** (default **off**, which preserves this strict default exactly). When set to **`true`**, a caller MAY hold **multiple** vendor roles and names the vendor as the first path segment `/broker/<vendor>/...`; the broker authorizes on the caller **holding** that named role. Naming a vendor role you were not assigned still returns 403, so security is unchanged: the `roles` claim is still populated only by Enterprise-App role assignments. This is the relaxation the drop-in bridge (`clients/bridge/`) relies on so one identity can serve several vendors.

### 5.1 Code snippet: exact-match role selection with multi-role and zero-role 403 (C#)

```csharp
// Recognized vendor-key roles mapped to their Key Vault secret names.
// EXACT-match membership only — never substring/Contains on a joined string.
private static readonly IReadOnlyDictionary<string, string> KeyRoleToSecret =
    new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["VendorApi.KeyA.Invoke"] = "vendor-api-key-team-a",
        ["VendorApi.KeyB.Invoke"] = "vendor-api-key-team-b",
        ["VendorApi.KeyC.Invoke"] = "vendor-api-key-ci",
    };

/// <summary>
/// Selects exactly one vendor-key secret from the caller's validated role claims.
/// Returns null and an HTTP 403 body when the caller holds zero or more than one
/// recognized vendor-key role. roles MUST be the parsed array of claim values,
/// e.g. principal.FindAll("roles").Select(c => c.Value), NOT a comma-joined string.
/// </summary>
public static (string? secretName, IActionResult? error) SelectVendorSecret(IEnumerable<string> roles)
{
    // Read as an array; distinct + exact membership against the recognized set.
    var callerRoles = new HashSet<string>(roles ?? Array.Empty<string>(), StringComparer.Ordinal);
    var matched = KeyRoleToSecret.Keys.Where(callerRoles.Contains).ToList(); // exact element match

    if (matched.Count != 1)
    {
        // Rejects BOTH the zero-role case and the ambiguous multi-role case.
        var body = new
        {
            error = "Caller must have exactly one vendor-key role " +
                    "(VendorApi.KeyA.Invoke, VendorApi.KeyB.Invoke, or VendorApi.KeyC.Invoke).",
            matchedRoleCount = matched.Count
        };
        return (null, new ObjectResult(body) { StatusCode = StatusCodes.Status403Forbidden });
    }

    return (KeyRoleToSecret[matched[0]], null); // exactly one -> deterministic secret
}
```

The `roles` array is obtained from the validated principal. Under Easy Auth, decode `X-MS-CLIENT-PRINCIPAL` (base64 JSON) and take every claim whose type is `roles` as separate array elements; under `Microsoft.Identity.Web`, use `principal.FindAll("roles").Select(c => c.Value)`. In both cases the input to `SelectVendorSecret` is a **list of individual role strings**, so `HashSet.Contains` is an exact match, not a substring test ([Microsoft Learn: client principal / user identities](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-user-identities), [Microsoft Learn: roles/scope validation in protected web APIs](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-protected-web-api-verification-scope-app-roles)).

---

## 6. Key storage and injection

### 6.1 Storage and least-privilege access

Store each real vendor key as a separate Azure Key Vault secret (secrets accept 1–4096 characters) with names that reveal purpose but not value: `vendor-api-key-team-a`, `vendor-api-key-team-b`, `vendor-api-key-ci` ([Microsoft Learn: Key Vault secrets](https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets)). The Function uses a **system-assigned managed identity** to read them, avoiding any client secret ([Microsoft Learn: managed identity for App Service/Functions](https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity)).

**The durable least-privilege control is RBAC on the managed identity.** Grant the Function's system-assigned identity **`Key Vault Secrets User`** scoped to **only the specific vendor-key secrets**, not the whole vault, and never a broader role. A broker compromised at that scope still cannot read unrelated secrets. This is the council's least-privilege-MI fix expressed as scoped Key Vault RBAC ([Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide), [Microsoft Learn: assign a Key Vault access role](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide#assign-role)). Humans should not have routine read access to the vendor-key secret values.

### 6.2 Fetch, cache, and inject

Fetch secrets with the Key Vault SDK (`SecretClient`) or Key Vault references, and cache the value **in memory with a TTL** (e.g., 5 minutes) to avoid a Key Vault call per request; on a `401`/`403` from the vendor, invalidate the cache and re-fetch to pick up a rotated key immediately ([Microsoft Learn: Key Vault secret client library](https://learn.microsoft.com/en-us/azure/key-vault/secrets/quick-create-net), [Microsoft Learn: Key Vault references in App Service/Functions](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references)). Inject the selected key **server-side** into the outbound vendor request, chosen per the vendor's contract ([Microsoft Learn: HttpClient outbound calls from Functions](https://learn.microsoft.com/en-us/azure/azure-functions/functions-best-practices#use-a-single-static-client)).

The deployed Node broker supports five inject modes, selected per role via `ROLE_SECRET_MAP`: **`header`** (a header such as `x-api-key`), **`bearer`** (`Authorization: Bearer <key>`), **`basic`** (HTTP Basic from an id/secret pair), **`pair`** (id and secret as two headers), and **`oauth2cc`** (OAuth2 client-credentials: the broker exchanges a stored `client_id`/`client_secret` at the vendor's token endpoint for a short-lived vendor Bearer, **mints and caches it server-side** until shortly before expiry, and injects that; the calling app implements no OAuth). The `pair`/`basic`/`oauth2cc` modes store both halves in a single Key Vault secret (JSON) so they rotate atomically.

### 6.3 Credential scrubbing: canonicalize + allowlist (stronger than a denylist)

Before injecting the server-side key, the broker removes **every** caller-supplied credential location. The council flagged that a denylist of specific header/param names is bypassable via casing or unlisted fields, so this design **canonicalizes then allowlists**: normalize inbound header names to a canonical case, drop any header/query/body field that is not on an explicit forward-allowlist, and reject requests that carry credential-shaped fields the vendor accepts (`x-api-key` and case variants, `api-key`, `apikey`, `authorization`, `api_key`, `key`, `access_token`, `token`, `subscription-key`, and equivalent body/form fields). Because this is an allowlist, unknown credential smuggling vectors fail closed by default ([Microsoft Learn: Azure Functions HTTP trigger](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-http-webhook-trigger), [OWASP: input validation cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html)). Apply the same scrub symmetrically on the response path so the broker never returns a vendor key even if an upstream error echoes it.

### 6.4 Do not forward caller attribution to the vendor

The broker records caller `oid`/`azp`/request-id in Application Insights **for attribution only** and does **not** forward any `x-broker-caller-*` header (or the caller's Entra bearer token) to the third-party vendor. That closes the outbound Entra-oid leak the council found in the APIM design. Attribution stays in logs and never rides the vendor leg ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference), [Microsoft Learn: Application Insights for Functions](https://learn.microsoft.com/en-us/azure/azure-functions/functions-monitoring)).

---

## 7. Networking: private endpoint + NSG IP filtering on the existing VNet (default)

**Critical context, honored throughout:** the environment **already has** an Azure VNet with a **private ingress path** from on-prem plus **VPN ingress** (e.g. site-to-site VPN, ExpressRoute, or an SD-WAN/edge-appliance route into the VNet). This design builds **around** that existing asset rather than proposing new connectivity. The template only ADDS subnets, an NSG, a private endpoint, and a private DNS zone to that VNet. It never creates or modifies your existing VNet peering, gateways, routes, network appliances, or tunnels; those are referenced read-only.

### 7.1 Default: private endpoint with NSG-enforced IP allow/deny

Inbound reaches the broker **only** through an `Microsoft.Network/privateEndpoints` (groupId `sites`) in the existing VNet, with `publicNetworkAccess: 'Disabled'`. Outbound vendor calls leave over Flex Consumption **VNet integration** on a separate delegated subnet ([Microsoft Learn: Azure Functions networking options](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options), [Microsoft Learn: private endpoints for App Service](https://learn.microsoft.com/en-us/azure/app-service/overview-private-endpoint)).

**The IP allow/deny list is enforced by an NSG on the private endpoint subnet, NOT by access restrictions.** This is the load-bearing detail of the design. Per [Microsoft Learn: App Service access restrictions](https://learn.microsoft.com/en-us/azure/app-service/overview-access-restrictions#how-it-works): *"If the traffic is sent through a private endpoint, it sends directly to the site without any restrictions. Restrictions to private endpoints are configured using network security groups."* Consequently:

- The NSG carries a **blacklist** (deny rules, priority 100+, evaluated first), a **whitelist** (allow on TCP 443 from the on-prem/VPN CIDRs, priority 200+), and a **catch-all deny** at priority 4000.
- The subnet **must** set `privateEndpointNetworkPolicies: 'Enabled'`. NSGs are bypassed on private endpoint subnets by default ([Microsoft Learn: network security of private endpoints](https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-overview#network-security-of-private-endpoints)). If this reads `Disabled`, every rule above is silently inert.
- `siteConfig.ipSecurityRestrictions` is retained only as defense-in-depth on the (disabled) public default endpoint. It is **not** the private-path filter.

Two subnets are required. The Flex Consumption integration subnet is delegated to `Microsoft.App/environments`, which **differs from** the `Microsoft.Web/serverFarms` delegation used by Elastic Premium and Dedicated plans, and per Microsoft Learn it "can't already be in use for other purposes (like private or service endpoints)".

**DNS is an operator prerequisite, not an IaC resource.** The template creates the `privatelink.azurewebsites.net` private DNS zone and links it to the existing VNet (resolution only). On-prem and VPN clients do not use Azure DNS, so the DNS admin must conditionally forward that zone to a resolver inside the VNet: either an **Azure DNS Private Resolver** inbound endpoint or an existing forwarder VM. Azure's platform resolver `168.63.129.16` is not reachable from on-prem. Without this forwarding, on-prem clients resolve a public IP and fail against a Function with public access disabled. See `iac/network-design.md` §3.1.

### 7.2 Fallback: access restrictions only (no private endpoint)

Set `deployPrivateEndpoint: false`. The Function keeps its public default endpoint with `ipSecurityRestrictions` scoped to the on-prem/VPN CIDRs as the only inbound control, and no private DNS work is needed. This is a **downgrade, not an equivalent**: traffic traverses the public front end and is filtered by source IP at the App Service layer rather than never being publicly routable. Choose it only where the §7.1 DNS forwarding cannot be arranged. Saves the ~$7/month private endpoint cost.

### 7.3 Outbound / fixed egress IP

If the vendor allowlists a specific outbound IP, use the existing VNet integration plus a **NAT Gateway** on the integration subnet for a stable egress IP ([Microsoft Learn: NAT Gateway integration for outbound](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options#virtual-network-integration), [Microsoft Learn: Azure NAT Gateway overview](https://learn.microsoft.com/en-us/azure/nat-gateway/nat-overview)). If the org already has a fixed egress path through its existing network edge, **reuse it** rather than adding a NAT Gateway.

---

## 8. Rotation and lifecycle (what you build vs APIM's managed named-values)

The admin rotates a vendor key by setting a new value on the Key Vault secret. The broker's cache TTL (e.g., 5 minutes) picks up the new value on the next refresh; for fast incident response, wire a Key Vault **Event Grid** `Microsoft.KeyVault.SecretNewVersionCreated` event to a small Function that busts the cache immediately. That is the council's turn-a-weakness-into-a-control fix, and it beats APIM's up-to-4-hour named-value refresh ([Microsoft Learn: Key Vault as an Event Grid source](https://learn.microsoft.com/en-us/azure/key-vault/general/event-grid-overview), [Microsoft Learn: receive Key Vault notifications via Event Grid](https://learn.microsoft.com/en-us/azure/key-vault/general/event-grid-tutorial)).

**Zero-downtime rotation requires the vendor to support overlapping active keys.** If the vendor allows only one live key at a time, document the cutover as a brief planned outage window rather than assuming zero downtime. This is the council's single-active-key correction ([Microsoft Learn: Key Vault secret rotation guidance](https://learn.microsoft.com/en-us/azure/key-vault/secrets/tutorial-rotation)).

**Break-glass runbook.** If the broker is down or its managed identity loses Key Vault access, the runbook covers: (1) verify the MI's `Key Vault Secrets User` assignment on the specific secrets; (2) confirm the Function's VNet integration, private endpoint, and PE-subnet NSG are intact; (3) redeploy the Function from source with the pinned configuration; (4) as a last resort, the admin (not developers) issues vendor calls directly from a controlled admin workstation while the broker is restored ([Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide), [Microsoft Learn: Functions deployment](https://learn.microsoft.com/en-us/azure/azure-functions/functions-deployment-technologies)).

---

## 9. Rate limiting and quota (build in code; APIM gives this for free)

Because multiple callers share one vendor key, the broker sub-allocates the vendor's real RPM/TPM/monthly quota in code, keyed by **caller `oid`** and/or **selected key alias**. Enforce per-caller and per-key counters in a small store (**Azure Table Storage** for simple counters, **Azure Cache for Redis** for higher-throughput sliding windows) and return `429 Too Many Requests` with `Retry-After` when a limit is exceeded ([Microsoft Learn: Azure Table Storage](https://learn.microsoft.com/en-us/azure/storage/tables/table-storage-overview), [Microsoft Learn: Azure Cache for Redis](https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/cache-overview)). This is the main capability re-implemented versus APIM's `rate-limit-by-key` / `quota-by-key` policies, and it is ~30–50 lines of code plus a table.

---

## 10. Observability and governance

Use **Application Insights** (the same telemetry backend APIM uses) to record per-caller (`oid`) and per-key usage, 4xx/5xx counts, latency, and vendor-error rates, with alerts on error-rate and latency spikes ([Microsoft Learn: monitor Azure Functions with Application Insights](https://learn.microsoft.com/en-us/azure/azure-functions/functions-monitoring), [Microsoft Learn: Application Insights alerts](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-overview)). Log the leak-scrubbing assertions (which credential fields were stripped) as structured events for audit. Keep **secrets and keys out of logs**: never log the vendor request/response bodies on the vendor leg, and redact any credential-bearing field before emitting telemetry ([Microsoft Learn: Application Insights data collection and privacy](https://learn.microsoft.com/en-us/azure/azure-monitor/app/data-collection-basics)). Telemetry cost at this scale is minimal (~$5/month, §13).

---

## 11. Security posture and PCI notes

This design mirrors every control of the APIM design. The vendor key is **never exposed** to the caller, because injection happens server-side. Access is **identity-bound** through Entra JWT validation and app roles. The managed identity is **least-privilege**: `Key Vault Secrets User` scoped to only the vendor-key secrets. Networking is **private** over the existing on-prem/VPN ingress path with public access disabled. **Audit logging** runs through Application Insights plus Key Vault and Entra logs, correlated by `oid` and request-id. And **only the admin** creates or rotates keys and controls role assignment ([Microsoft Learn: Functions authentication](https://learn.microsoft.com/en-us/azure/app-service/overview-authentication-authorization), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide), [Microsoft Learn: Functions networking options](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options)).

**PCI-relevant notes.** If the vendor handles cardholder or PCI-relevant data, the broker's default **metadata-only** logging supports PCI minimization — record caller, route, status, latency, and key alias, never PAN, sensitive authentication data, bearer tokens, vendor keys, or full request/response bodies ([Microsoft Learn: Application Insights data collection basics](https://learn.microsoft.com/en-us/azure/azure-monitor/app/data-collection-basics)). Rotate vendor keys on a regular agreed cadence, after any suspected exposure, and after high-risk offboarding (§8).

---

## 12. Parity matrix: no security lost, only convenience

Each row maps a security requirement or a council-flagged fix to how the APIM design and the function broker each satisfy it.

| Requirement | APIM approach | Function broker approach | Parity |
|---|---|---|---|
| Vendor key never exposed to caller | Server-side inject via `set-header`; scrub response | Server-side inject in code; scrub response symmetrically | Yes |
| Caller uses own Entra identity | `validate-jwt` inbound | Easy Auth platform validation before code | Yes |
| v2 token audience/issuer, `--scope` not `--resource` | v2 issuer + client-id `aud`; `.default` scope | Same v2 conventions; Easy Auth audiences = client-id + `api://<client-id>` | Yes |
| `requestedAccessTokenVersion: 2` | Set on Broker manifest | Set on Broker manifest (identical) | Yes |
| Exact-array role selection, multi-role 403 | `roles[]` from `broker-jwt`, exact `.Contains`, count!=1 -> 403 | `HashSet` exact membership, count!=1 -> 403 (default; opt-in `MULTI_ROLE_VENDOR_ROUTING` = vendor-named multi-role routing) (§5 snippet) | Yes |
| CI gets a `roles` claim | `allowedMemberTypes: Application` + direct SP assignment | Same Entra config (identical) | Yes |
| Role-less tokens fail early | "Assignment required" on enterprise app | Same Entra config (identical) | Yes |
| GitHub OIDC issuer no trailing slash | `https://token.actions.githubusercontent.com` (no `/`) | Same FIC config (identical) | Yes |
| Human SSO ≠ workload OIDC | SAML->Entra distinct from OIDC flow | Same distinction stated (§4.4) | Yes |
| Credential smuggling blocked | Header/query deletes (denylist) | Canonicalize + allowlist across header/query/body | Yes, **stronger** |
| No caller oid forwarded to vendor | Logs only, no `x-broker-caller-*` | Attribution in App Insights only; nothing forwarded | Yes |
| Least-privilege secret access | KV RBAC on APIM MI, scoped to vendor secrets | `Key Vault Secrets User` on Function MI, scoped to vendor secrets | Yes |
| Private networking | Private endpoint + DNS Resolver | Private endpoint on existing VNet + NSG IP filtering, public access disabled | Yes, same control, lower cost |
| Fast rotation for incident response | Manual refresh / 4-hour auto | Cache TTL + Event Grid immediate cache-bust | Yes, **faster** |
| Single-active-key rotation honesty | Documented cutover window | Documented cutover window (identical) | Yes |
| Rate limit / quota by key | `rate-limit-by-key` / `quota-by-key` | Code-enforced counters (Table/Redis) | Yes, you own the code |
| Audit logging | Azure Monitor / App Insights | App Insights (same backend) | Yes |
| Admin-only key control | RBAC on KV / APIM / Entra | RBAC on KV / Function / Entra | Yes |
| Break-glass / HA-DR | Runbook | Runbook (§8) + serverless multi-instance | Yes |

### 12.1 Code snippet: token-claim assertion (pre-rollout and CI gate)

Before go-live, decode a **real** user delegated token **and** a **real** GitHub workload app-only token, then assert `ver`, `iss`, `aud`, and `roles` exactly match what the broker expects. The council made this runtime test mandatory. The bash snippet below runs in CI or locally and fails the build on any mismatch ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference), [Microsoft Learn: az account get-access-token](https://learn.microsoft.com/en-us/cli/azure/account?view=azure-cli-latest#az-account-get-access-token)).

```bash
set -euo pipefail

# v2 scope form (.default). --scope requests a v2 token; --resource would request v1 and be rejected.
BROKER_SCOPE='api://00000000-0000-0000-0000-000000000000/.default'
EXPECTED_AUD='00000000-0000-0000-0000-000000000000'
EXPECTED_ISS='https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0'

TOKEN=$(az account get-access-token --scope "$BROKER_SCOPE" --query accessToken -o tsv)
echo "::add-mask::$TOKEN"

# Decode the JWT payload (base64url) without trusting the transport.
PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' \
  | awk '{l=length($0)%4; if(l>0)for(i=0;i<4-l;i++)$0=$0"="; print}' | base64 -d 2>/dev/null)

VER=$(echo "$PAYLOAD"  | jq -r '.ver')
AUD=$(echo "$PAYLOAD"  | jq -r '.aud')
ISS=$(echo "$PAYLOAD"  | jq -r '.iss')
ROLES=$(echo "$PAYLOAD" | jq -r '(.roles // []) | join(",")')
echo "ver=$VER aud=$AUD iss=$ISS roles=$ROLES"

[ "$VER" = "2.0" ] || { echo "FAIL: not a v2 token (check requestedAccessTokenVersion + --scope)"; exit 1; }
[ "$AUD" = "$EXPECTED_AUD" ] || [ "$AUD" = "api://$EXPECTED_AUD" ] || { echo "FAIL: aud mismatch"; exit 1; }
[ "$ISS" = "$EXPECTED_ISS" ] || { echo "FAIL: iss mismatch (expected v2 issuer)"; exit 1; }
# Exactly one recognized vendor-key role, mirroring the broker's server-side check.
N=$(echo "$ROLES" | tr ',' '\n' | grep -Ecx 'VendorApi\.Key[ABC]\.Invoke' || true)
[ "$N" -eq 1 ] || { echo "FAIL: expected exactly one vendor-key role, found $N"; exit 1; }
echo "PASS: token claims valid for the broker"
```

---

## 13. Cost model

Numbers below are usage-light internal-broker estimates (≈500k executions/month, ~300 ms each, 2 GiB) computed from the companion `optiond_cost.py` and verified against current pricing. Costs scale with executions and GB-seconds but stay far below APIM for a small userbase ([Azure Functions pricing](https://azure.microsoft.com/en-us/pricing/details/functions/), [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/), [Azure API Management pricing](https://azure.microsoft.com/en-us/pricing/details/api-management/)).

**Recommended: Flex Consumption, 1 always-ready (2 GiB), existing VNet, no PE/DNS**

| Line item | Monthly |
|---|---|
| Always-ready baseline (2 GiB, 24×7) | $20.74 |
| Execution time (~500k × 300 ms × 2 GiB) | $4.80 |
| Executions (500k @ $0.40/M) | $0.20 |
| Key Vault operations | $0.50 |
| Application Insights (light) | $5.00 |
| Function storage account | $2.00 |
| Private endpoint | $0.00 (existing private route) |
| DNS Private Resolver | $0.00 (resolved over existing path) |
| **Realistic monthly total** | **~$33.24 (~$400/yr)** |

**Variants and comparison:**

| Option | Monthly |
|---|---|
| **Function broker: Flex always-ready, existing VNet, private endpoint (default, §7.1)** | **~$40** |
| Function broker: Flex always-ready, access restrictions only (fallback, §7.2) | ~$33 |
| Function broker: Flex scale-to-zero (accepts cold starts) | ~$13 |
| Function broker: Container Apps (min-1 to scale-to-zero) | ~$5–40 |
| APIM Standard v2 core | ~$1,067 |
| APIM Premium v2 | ~$3,168 |

The default path costs about **~$40/month versus ~$1,067/month** for APIM Standard v2, a **~96% reduction**, and lands about **99%** below APIM Premium v2. Per §12, no security property is traded away to get there.

> **Excluded from these figures:** the on-prem DNS forwarding required by §7.1. If the org has no existing forwarder reachable from on-prem and stands up an Azure DNS Private Resolver for this, that resolver is a **material additional monthly cost**, priced per inbound endpoint and per query at [Azure DNS pricing](https://azure.microsoft.com/pricing/details/dns/), and in most cases larger than the broker itself. Orgs that already operate a forwarder into the VNet add nothing. Price this before committing to §7.1.

---

## 14. What you give up versus APIM (honest trade-offs)

- There is no turnkey policy GUI. Behavior lives in code and configuration, not a visual policy editor.
- Rate limiting and quota become your code to write and maintain. APIM ships `rate-limit-by-key` / `quota-by-key` for free (§9).
- The canonicalize+allowlist request scrub is yours too (§6.3), though it ends up stronger than APIM's denylist.
- Rotation is a cache TTL plus an optional Event Grid cache-bust (§8) instead of managed named-value refresh.
- No built-in developer portal: no self-service catalog, no subscription UI.
- You own roughly 200 lines of broker code. In exchange you patch less runtime, since Flex Consumption is serverless and Microsoft manages the host.

**Choose the function broker when:** the userbase is small and known, there are one or more vendors (each mapped to an app role via `ROLE_SECRET_MAP`), cost is a priority, and the team is comfortable owning a small broker codebase. **Choose APIM when:** many teams and vendors are onboarded, a self-service developer portal is needed, or the org wants zero application-code ownership.

---

## 15. Implementation outline

Reuse the existing VNet and your private ingress path. No new connectivity is provisioned.

1. **Infra (reuse existing network):** add a delegated subnet in the **existing VNet** for Function VNet integration; deploy the Key Vault and the Flex Consumption Function; enable the Function's **system-assigned managed identity**; grant it `Key Vault Secrets User` scoped to **only** the vendor-key secrets; add the **private endpoint** with its subnet **NSG scoped to the on-prem/VPN ingress CIDR ranges** and **disable public network access** (§7.1; the access-restriction-only fallback is §7.2) ([Microsoft Learn: Functions networking options](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options), [Microsoft Learn: Key Vault RBAC guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide)).
2. **Identity:** create the Broker app registration; set `requestedAccessTokenVersion: 2`; define the three vendor-key app roles with `allowedMemberTypes` including `Application`; enable "Assignment required"; create the GitHub federated identity credential (issuer with no trailing slash) ([Microsoft Learn: add app roles](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps), [Microsoft Learn: workload identity federation with GitHub](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust-github)).
3. **Auth:** enable Easy Auth with "Require authentication" and allowed audiences = client-id GUID + `api://<client-id>` ([Microsoft Learn: configure Entra authentication](https://learn.microsoft.com/en-us/azure/app-service/configure-authentication-provider-aad)).
4. **Code:** read validated claims from `X-MS-CLIENT-PRINCIPAL`; select the key by **exact array membership with multi-role/zero-role 403** (§5); fetch and cache the Key Vault secret; **canonicalize+allowlist scrub** all caller credential fields (§6.3); inject the key server-side; enforce per-caller/per-key rate limits (§9); do **not** forward caller `oid` to the vendor (§6.4).
5. **Test (the council's runtime tests):** decode a **real** user token and a **real** CI app-only token and assert `ver`/`iss`/`aud`/`roles` (§12.1); assign a principal **two** key-roles and assert **403**; attempt credential smuggling across header/query/body and assert it is stripped; rotate a key and verify the cache-refresh window; confirm DNS/network reachability over the private on-prem/VPN path ([Microsoft Learn: access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference), [Microsoft Learn: Functions networking options](https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options)).

This spec is the design, not the full orchestration plan; the sequence above is intentionally tight.

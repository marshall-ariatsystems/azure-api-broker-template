# Sysadmin guide: deploy and operate the secrets broker

Operational manual for whoever stands the broker up and keeps it running. Every task is shown **two
ways**, through the **Azure Portal (UI)** and with the **`az` CLI**. Pick whichever you prefer; they
do the same thing.

> **Audience:** an Azure administrator with Owner/Contributor on the target subscription (or the
> scoped roles listed in [Prerequisites](#prerequisites)) who can also create Entra app
> registrations. No prior knowledge of this repo is assumed.
>
> **New to the concept?** Start with the repository [README](../README.md) for the architecture and
> trust boundary. This guide is about deploying and operating it.

---

## Contents

- [How it fits together (60 seconds)](#how-it-fits-together-60-seconds)
- [Prerequisites](#prerequisites)
- [Placeholder convention](#placeholder-convention)
- [Part 1 — Deploy from scratch](#part-1--deploy-from-scratch)
- [Part 2 — Deploy a code update](#part-2--deploy-a-code-update)
- [Part 3 — Manage vendors (keys)](#part-3--manage-vendors-keys)
- [Part 4 — Manage callers (access)](#part-4--manage-callers-access)
- [Part 5 — Rotate a key](#part-5--rotate-a-key)
- [Part 6 — Monitoring & health](#part-6--monitoring--health)
- [Part 7 — Troubleshooting](#part-7--troubleshooting)
- [Part 8 — Security posture checklist](#part-8--security-posture-checklist)
- [Appendix — quick reference](#appendix--quick-reference)

---

## How it fits together (60 seconds)

```
Caller (Entra token) ──► Easy Auth (validates JWT, 401 if bad) ──► Broker Function
                                                                        │ managed identity
                                                                        ▼
                                                                    Key Vault (real keys)
                                                                        │ key injected server-side
                                                                        ▼
                                                                    Vendor API ──► only the response back
```

Five moving parts you will administer:

| Part | Resource | What you do to it |
|---|---|---|
| **Front door** | Easy Auth on the Function App | Turn it on, list which client apps may call, exclude the health path |
| **Broker** | Azure Function (`function-node/`, Node 22, Flex Consumption) | Deploy code, set app settings |
| **Vault** | Azure Key Vault | Load & rotate vendor keys (write-only) |
| **Identity** | Entra app registration + app roles | Define roles, assign callers |
| **Network** | An **existing** VNet + a delegated subnet this adds | Keep it private; deploy from inside it |


---

## Prerequisites

**Tools** (all free): [`az` CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) (log in with
`az login`), `jq`, `node` ≥ 22, and `zip`. The Portal path needs only a browser.

**Azure roles** you (or the deploying identity) need:

| To do this | You need |
|---|---|
| Deploy IaC (RG, Function, Storage, VNet subnet) | **Contributor** on the subscription/RG, plus **Contributor** on the RG that holds the existing VNet |
| Create the Entra app + roles + assignments | **Application Administrator** (or Owner of the app object) |
| Assign the managed identity to Key Vault | **User Access Administrator** / **Owner** on the vault (RBAC) |
| Load/rotate secrets | **Key Vault Secrets Officer** on the vault |
| Run the admin console | Secrets Officer on the vault + **Website Contributor** on the app + Graph read on the app reg |

**Network:** you must already have a VNet carrying private ingress (S2S VPN / ExpressRoute / SD-WAN).
This broker **only adds** one delegated subnet plus inbound restrictions to it. It never touches your
existing peering, gateways, routes, or tunnels. See
[`iac/network-design.md`](../iac/network-design.md).

---

## Placeholder convention

The repo ships with grep-findable placeholders (marker: **`PLACEHOLDER`**). Substitute real values at
deploy time; never commit the real ones.

| Placeholder | Ships as | Replace with |
|---|---|---|
| `tenantId` | `11111111-1111-1111-1111-111111111111` | your Entra tenant GUID |
| `brokerClientId` | `00000000-0000-0000-0000-000000000000` | the broker app's real `appId` |
| `appIdUri` | `api://00000000-...` | `api://<brokerClientId>` |
| `issuer` | `https://login.microsoftonline.com/<tenantId>/v2.0` | **must end in `/v2.0`** |
| KV secret values | `REPLACE-WITH-REAL-VENDOR-KEY-...` | real key, loaded **out of band** |

Throughout this guide, angle-bracket tokens like `<FUNCTION_APP>`, `<RG>`, `<KEYVAULT>`,
`<SUBSCRIPTION>`, `<BROKER_CLIENT_ID>` are yours to fill in. Default resource names use the pattern
`apibkr-<suffix>-*` (e.g. `apibkr-optd-func`, `apibkr-optd-kv`).

---

## Part 1 — Deploy from scratch

Do these in order. Steps 1–2 provision infrastructure, 3–5 wire identity and auth, 6–8 ship the code.

### Step 1 — Deploy the foundation

Provisions the resource group, a **delegated subnet on your existing VNet**, Storage, App Insights, the
Flex Consumption plan, the Function App (system-assigned managed identity, VNet-integrated, public
access **Disabled**), and Key Vault (soft-delete + purge protection, RBAC). Source:
[`iac/foundation.bicep`](../iac/foundation.bicep).

**CLI**
```bash
az deployment group create \
  --resource-group <RG> \
  --template-file iac/foundation.bicep \
  --parameters \
      namingSuffix=<suffix> \
      existingVnetName=<VNET> \
      existingVnetResourceGroup=<VNET_RG> \
      vnetIntegrationSubnetCidr=10.50.5.0/26 \
      onPremIngressCidr=<YOUR_ONPREM_CIDR> \
      brokerHostname=<broker.example.com> \
      publicNetworkAccess=Disabled
```

**Portal**
1. **Create a resource → Template deployment (deploy a custom template)** → **Build your own template
   in the editor** → **Load file** → pick `iac/foundation.bicep` (the Portal compiles Bicep) → **Save**.
2. Choose the target **Resource group**, fill the parameters above, **Review + create** → **Create**.
3. Watch **Deployment → Outputs**. Record `functionName`, `keyVaultName`, `keyVaultUri`, and
   `identityPrincipalId`; you need all four below. The supported deployment CLI stores the
   non-secret identifiers in local, ignored deployment state.

Key posture this sets: **inbound restricted** to your on-prem/VPN CIDR (everything else denied),
**public network access Disabled**, outbound via VNet integration.

### Step 2 — Deploy Key Vault secret slots + grant the identity

[`iac/keyvault.bicep`](../iac/keyvault.bicep) creates vendor-key secret slots (placeholder values) and
grants the Function's managed identity **`Key Vault Secrets User`** **scoped to each individual
secret** rather than the whole vault. That scoping is the least-privilege part; don't widen it out of
convenience.

**CLI**
```bash
az deployment group create \
  --resource-group <RG> \
  --template-file iac/keyvault.bicep \
  --parameters keyVaultName=<KEYVAULT> functionPrincipalId=<identityPrincipalId>
```

**Portal (equivalent, manual)**
- **Key Vault → Objects → Secrets → Generate/Import** to create each slot.
- **Key Vault → Access control (IAM) → Add role assignment → Key Vault Secrets User →** assign to the
  Function App's **managed identity**. For least privilege, scope the assignment at the **secret**
  level (open the secret → its IAM), not the vault.

### Step 3 — Create the Entra app registration

Source of truth: [`identity/app-registration.md`](../identity/app-registration.md).

**CLI**
```bash
# 1) create, then re-point the identifier URI at the REAL appId
az ad app create --display-name "Vendor API Key Broker" \
  --identifier-uris "api://00000000-0000-0000-0000-000000000000"
BROKER_CLIENT_ID=$(az ad app list --display-name "Vendor API Key Broker" --query '[0].appId' -o tsv)
az ad app update --id "$BROKER_CLIENT_ID" --identifier-uris "api://$BROKER_CLIENT_ID"

# 2) v2 tokens — the #1 cause of silent token rejection if wrong
az ad app update --id "$BROKER_CLIENT_ID" --set requestedAccessTokenVersion=2

# 3) require role assignment (role-less tokens fail at issuance)
az ad sp update --id "$BROKER_CLIENT_ID" --set appRoleAssignmentRequired=true
```

**Portal**
1. **Entra ID → App registrations → New registration** → name it, **Register**.
2. **Expose an API → Application ID URI → Add** → accept `api://<clientId>`. Add the delegated scope
   **`VendorApi.Invoke`** (who can consent: Admins).
3. **Manifest** → set `"requestedAccessTokenVersion": 2` → **Save**.
4. **Entra ID → Enterprise applications →** (same app) **→ Properties → Assignment required? = Yes**.

### Step 4 — Define app roles

Each role maps to exactly one Key Vault secret. Authoritative list:
[`identity/app-roles.json`](../identity/app-roles.json).

| Role (value) | Secret | Member types |
|---|---|---|
| `VendorApi.KeyA.Invoke` | `vendor-api-key-team-a` | Application, User |
| `VendorApi.KeyB.Invoke` | `vendor-api-key-team-b` | Application, User |
| `VendorApi.KeyC.Invoke` | `vendor-api-key-ci` | Application, User |
| `VendorApi.Admin.Test` | `vendor-api-key-canary` | User |

> **Any role a CI/workload identity will use MUST include `Application` in its member types.**
> Otherwise app-only tokens carry no `roles` claim and every call 403s. This one bites people.

**Portal:** **App registrations → (app) → App roles → Create app role**, once per role. Set *Value*,
choose *Allowed member types*, Enable. **CLI:** apply from the JSON with
`az ad app update --id "$BROKER_CLIENT_ID" --set appRoles=@identity/app-roles.json` (see the runbook for
the exact shape).

### Step 5 — Apply Easy Auth

[`iac/auth.bicep`](../iac/auth.bicep) sets `authsettingsV2`: Entra provider, unauthenticated requests
→ **401** (no login redirect), audiences = `[<clientId>, api://<clientId>]`. Apply **after** the app
reg exists.

**CLI**
```bash
az deployment group create \
  --resource-group <RG> \
  --template-file iac/auth.bicep \
  --parameters \
      brokerClientId=<BROKER_CLIENT_ID> \
      brokerAppIdUri="api://<BROKER_CLIENT_ID>" \
      brokerIssuer="https://login.microsoftonline.com/<TENANT_ID>/v2.0"
```

**Portal**
1. **Function App → Settings → Authentication → Add identity provider → Microsoft.**
2. App registration: **Pick an existing** → the broker app.
3. **Unauthenticated requests → HTTP 401 Unauthorized.** This is a **machine API**, not a website. Do
   **not** pick "redirect to log in".
4. **Save.** Confirm the issuer URL ends in `/v2.0`.

> `auth.bicep` does **not** set the caller allowlist or the health-path exclusion. Those are
> [Part 4](#part-4--manage-callers-access) and [Part 6](#part-6--monitoring--health).

### Step 6 — Deploy the broker code

The broker is deployed via **One Deploy** with `node_modules` **bundled** in the zip.

```bash
cd function-node
npm ci                                    # install production deps
zip -r ../broker.zip host.json package.json src node_modules
cd ..
az functionapp deployment source config-zip \
  -g <RG> -n <FUNCTION_APP> --src broker.zip --build-remote false
```

**Portal:** **Function App → Deployment → Deployment Center** supports GitHub Actions and external git.
For a one-off zip, **Advanced Tools (Kudu) → Tools → Zip Push Deploy** and drag the zip in.

> **Warning: private-network deploy caveat.** See [Part 2](#part-2--deploy-a-code-update). If
> public access is Disabled, a deploy from outside the VNet returns **403 at the SCM endpoint**.
> Deploy from an in-VNet host, or use the temporary-toggle workaround documented there.

### Step 7 — Configure app settings & smoke test

**Required settings**:

| Setting | Purpose |
|---|---|
| `KEYVAULT_URI` | `https://<KEYVAULT>.vault.azure.net/` |
| `VENDOR_BASE_URL` | default vendor base URL |
| `INJECT_MODE` | `header` (default) / `bearer` / `pair` / `basic` / `oauth2cc` |
| `ROLE_SECRET_MAP` | JSON: role → `{secret, baseUrl, inject, tokenUrl, scope, …}` (changing it needs **no redeploy**) |
| `DEMO_MODE` | `1` adds cosmetic `x-broker-*` response headers; **set `0` for production** |

**Rate limiting** (quota enforcement via Table Storage; optional but recommended for production):

| Setting | Purpose | Default |
|---|---|---|
| `RATE_LIMIT_STORAGE_ACCOUNT` | Storage account name (managed identity; no connection string) holding the counter table. **Required to enable rate limiting.** | (none; rate limiting disabled if absent) |
| `QUOTA_CALLER_PER_MIN` | Per-caller request limit (per unique `oid` / object ID) | 60 |
| `QUOTA_KEY_PER_MIN` | Per-vendor-key request limit (per unique secret name) | 600 |
| `RATE_LIMIT_TABLE_NAME` | Table Storage table name for quota counters | `brokerRateLimits` |
| `RATE_LIMIT_FAIL_MODE` | Quota enforcement mode: `closed` rejects when the quota store is unreachable; `open` allows (availability vs security tradeoff). **Closed is recommended; open is for high-availability scenarios where quota store outages must not block the broker.** | `closed` |

**Header allowlist** (credential scrubbing configuration):

| Setting | Purpose | Default / Built-in |
|---|---|---|
| `FORWARD_HEADER_ALLOWLIST` | Comma-separated custom headers to forward to the vendor, **additive** to the built-in allowlist. Use this when a vendor requires a custom header (e.g., `x-correlation-id`, `x-custom-tenant`). **Callers sending any header not in the allowlist and not credential-shaped are silently dropped; credentials are rejected (400).** | Built-in: `accept`, `accept-charset`, `accept-encoding`, `accept-language`, `content-type`, `user-agent`, `traceparent`, `tracestate`, `x-request-id` |

**Portal:** **Function App → Settings → Environment variables** (formerly *Configuration → Application
settings*) → **+ Add** each → **Apply**. **CLI:** `az functionapp config appsettings set -g <RG> -n <FUNCTION_APP> --settings KEY=VALUE`.

**Smoke test** (from inside the VNet / private path):
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<broker.example.com>/api/health   # 401 (Easy Auth on) — healthy
curl -H "Authorization: Bearer $TOKEN" https://<broker.example.com>/api/broker/<path>   # 200 + vendor response
```
Also run the offline checks: `bash test/run-smoke-bars.sh` and
`node function-node/test/oauth-recovery.test.js`.

**Important behavior change — credential scrubbing is now stricter:**

The broker **rejects (HTTP 400) requests carrying credential-shaped query parameters, body fields, or headers**. This surfaces smuggling attempts clearly and ensures logging clarity. For example:
- A caller sends `?api_key=xyz` → **400** with `credential-shaped query parameter not allowed: api_key`
- A caller sends `Authorization: Bearer xyz` (the caller's own Entra token, expected on every request) → **silently stripped** (the auth header pattern is expected; Easy Auth validates it first, so forwarding it to the vendor would be the security bug)
- A caller sends `x-ms-*` headers (Easy Auth's own injections like `x-ms-client-principal`) → **silently stripped** (platform-supplied, expected on every request)

The built-in credential-shaped names are: `x-api-key`, `api-key`, `apikey`, `api_key`, `authorization`, `key`, `access_token`, `token`, `subscription-key`, `x-api-key-id`, `x-api-secret`, `x-key-id`, `x-secret`, `client_id`, `client_secret`, plus any deployment-configured injection headers.

If a vendor requires a custom non-credential header that is being dropped, add it to `FORWARD_HEADER_ALLOWLIST` (see the settings table above).

---

## Part 2 — Deploy a code update

Same One Deploy as Step 7: rebuild the zip and push. The wrinkle is the network.

### The private-network deploy caveat

When **`publicNetworkAccess=Disabled`**, the app's SCM/Kudu endpoint resolves (over public DNS) to a
public frontend that **rejects the deploy with HTTP 403**. Two ways through:

**A. Deploy from inside the VNet (preferred).** Run the `config-zip` from a host that reaches the app
over the private path: a jumpbox, a build agent, or the app's own VNet. No posture change.

**B. Temporary toggle (reversible, when no in-VNet host is handy).** Flip public access on, deploy,
flip it straight back. Easy Auth still fronts the runtime during the window, and Kudu still requires
your Azure credentials.

```bash
az resource update -g <RG> -n <FUNCTION_APP> --resource-type Microsoft.Web/sites \
  --set properties.publicNetworkAccess=Enabled
az functionapp deployment source config-zip -g <RG> -n <FUNCTION_APP> --src broker.zip --build-remote false
az resource update -g <RG> -n <FUNCTION_APP> --resource-type Microsoft.Web/sites \
  --set properties.publicNetworkAccess=Disabled
az functionapp show -g <RG> -n <FUNCTION_APP> --query 'properties.publicNetworkAccess' -o tsv  # must print: Disabled
```

**Portal:** **Function App → Settings → Networking → Public network access** → toggle **Enabled**,
deploy, then toggle **Disabled** and **verify** it reads Disabled again. Do not leave it Enabled.

### Rollback

Keep the previous zip. To roll back, redeploy it the same way. Because `ROLE_SECRET_MAP` and vendor
keys live in settings and Key Vault rather than in the code, a code rollback never disturbs vendor
config. `az functionapp restart -g <RG> -n <FUNCTION_APP>` clears the in-memory secret/token cache.

---

## Part 3 — Manage vendors (keys)

A "vendor" is one real API key the broker injects, reachable by one app role. The scripted path does
everything atomically; the Portal path is the same steps by hand.

### Inject modes

| Mode | What the vendor wants | Broker behavior |
|---|---|---|
| `header` | key in a custom header (e.g. `x-api-key`) | injects the header |
| `bearer` | `Authorization: Bearer <key>` | injects the bearer |
| `pair` / `basic` | id + secret | stored as one JSON secret, injected as pair / Basic auth |
| `oauth2cc` | OAuth2 client-credentials | broker **mints & caches the token itself** and re-mints on 401, so the caller stays fully keyless |

### Scripted onboarding (recommended)

[`cicd/onboard-vendor.sh`](../cicd/onboard-vendor.sh) is idempotent. It writes the KV secret, scopes the
MI grant to that secret, adds the app role, merges `ROLE_SECRET_MAP` (no redeploy), and optionally
assigns the role. Always dry-run first.

```bash
SUBSCRIPTION=<SUB> RESOURCE_GROUP=<RG> FUNCTION_APP=<FUNCTION_APP> KV_NAME=<KEYVAULT> \
BROKER_CLIENT_ID=<BROKER_CLIENT_ID> FUNC_PRINCIPAL_ID=<identityPrincipalId> \
VENDOR_NAME=Acme INJECT=oauth2cc BASE_URL=https://api.acme.com \
TOKEN_URL=https://api.acme.com/connect/token SCOPE="read" \
VENDOR_CLIENT_ID=... VENDOR_CLIENT_SECRET=... \
  bash cicd/onboard-vendor.sh --dry-run      # prints every az command, key value redacted
# re-run without --dry-run to apply
```
Full env-var list and governance (keep key→identity 1:1) in
[`cicd/onboarding-runbook.md`](../cicd/onboarding-runbook.md).

### Portal (manual equivalent)

1. **Key Vault → Secrets → Generate/Import** → add the vendor key (or an id+secret JSON blob).
2. **Key Vault → the secret → IAM** → grant the Function MI **Key Vault Secrets User** (secret scope).
3. **App registration → App roles → Create app role** `VendorApi.<Vendor>.Invoke` (Application + User).
4. **Function App → Environment variables** → edit **`ROLE_SECRET_MAP`**, add the role→secret entry
   (`{"VendorApi.Acme.Invoke":{"secret":"acme","baseUrl":"https://api.acme.com","inject":"oauth2cc","tokenUrl":"...","scope":"read"}}`)
   → **Apply**. No redeploy.
5. Assign the role to the caller. See [Part 4](#part-4--manage-callers-access).

> Serving **multiple vendors from one caller identity** requires the app setting
> `MULTI_ROLE_VENDOR_ROUTING=true`, which adds `/api/broker/<vendor>/...` routing. Off by default.

---

## Part 4 — Manage callers (access)

A caller has to clear two independent gates: its app is on the Easy Auth **allowlist**, and it holds
the **app role** for the vendor it wants. Grant both, or it fails.

### (a) Easy Auth allowlist (`allowedApplications`)

Only client apps whose appId is on this list may call at all (they present their own SP as `azp`).

**Portal:** **Function App → Authentication → (Microsoft provider) → Edit → Allowed client
applications** → add each caller app's **appId** → **Save**.

**CLI:** patch `authsettingsV2` `identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedApplications`
(read-modify-write so you don't clobber the list, see
[`identity/grant-revoke-runbook.md`](../identity/grant-revoke-runbook.md)).

> **Hardening:** remove the Azure CLI appId `04b07795-8ddb-461a-bbee-02f9e1bf7b46` from the allowlist
> before production. It's only there so human `az`-issued tokens work during testing.

### (b) App-role assignment

**Human users, via a group (Portal):** **Entra ID → Enterprise applications → (broker app) → Users
and groups → Add user/group** → pick the group → pick the role → **Assign**.

**CLI (human via group):**
```bash
az ad app role assignment add --id "$BROKER_CLIENT_ID" \
  --role "<ROLE_ID>" --assignee-object-id "<GROUP_OID>" --assignee-principal-type Group
```

**CI / workload identity (SP), CLI only.** Portal "Users and groups" can't target another SP. Assign
the role **directly**, never via a group; Entra omits the `roles` claim for group-nested app tokens.
```bash
az ad app role assignment add --id "$BROKER_CLIENT_ID" \
  --role "<ROLE_ID>" --assignee-object-id "<CI_SP_OID>" --assignee-principal-type ServicePrincipal
```

**Revoke:** remove the group membership (human) or
`az ad app role assignment remove ... --assignee-object-id "<SP_OID>" --assignee-principal-type ServicePrincipal`
(SP). **If a key may be exposed, rotate the key AND revoke the role.**

---

## Part 5 — Rotate a key

Rotation is **write-only** and needs **no redeploy**. You only replace the value in Key Vault.

**Portal:** **Key Vault → Secrets → (the secret) → New Version** → paste the new value → **Create**.
**CLI:**
```bash
az keyvault secret set --vault-name <KEYVAULT> --name vendor-api-key-team-a --value '<NEW-KEY>'
```

**When it takes effect:** the broker caches secrets in memory for **5 minutes** (`SECRET_TTL_MS`), so
the new value is live within 5 min. To make it immediate:

- **Restart** the app (clears the cache): **Function App → Overview → Restart**, or
  `az functionapp restart -g <RG> -n <FUNCTION_APP>`.
- Or wire the one-time **Event Grid `SecretNewVersionCreated`** cache-bust subscription (see
  [`test/rotation-runbook.md`](../test/rotation-runbook.md)).
- **Reactive:** on a vendor `401/403` the broker already invalidates and re-fetches automatically. For
  `oauth2cc`, it re-mints the token once and retries.

> **Zero-downtime** is only guaranteed if the vendor supports two valid keys overlapping. If it
> doesn't, plan a short cutover window.

### The admin console (`admin-ui/`)

A **localhost-only** UI for the write-only tasks: load or rotate a secret, edit `ROLE_SECRET_MAP`,
probe a vendor, restart, health tile. It binds `127.0.0.1` and uses your `az login`. `npm start` →
`http://localhost:8788`. It **cannot** show or export key values, and it never runs hosted. Needs
Secrets Officer on the vault plus Website Contributor on the app. Config in
`admin-ui/broker.config.json`.

---

## Part 6 — Monitoring & health

### Health probe

The broker exposes **`GET /api/health`** → `{status, uptimeSec, oauthTokensCached, secretsCached,
demoMode}`. Easy Auth still gates it (unauth → 401). For an **unauthenticated** uptime probe (external
monitor), add the path to the exclusion list:

**Portal:** **Function App → Authentication → Edit → Excluded paths** → add `/api/health` → **Save**.
**CLI:** patch `authsettingsV2` `globalValidation.excludedPaths` to include `/api/health`
(read-modify-write).

### Alerts

Deploy [`observability/alerts.bicep`](../observability/alerts.bicep) (needs an Action Group id):

| Alert | Fires when | Severity |
|---|---|---|
| 4xx spike | `Http4xx > 5` in 5 min | 2 |
| 5xx spike | `Http5xx > 5` in 5 min | 1 |
| Latency | avg `HttpResponseTime > 2000 ms` | 2 |
| KV access anomaly | Key Vault Unauthorized/Forbidden `> 0` | 1 |
| Cold start | App Insights exceptions `> 0` | 2 |

**CLI:** `az deployment group create -g <RG> --template-file observability/alerts.bicep --parameters functionName=<FUNCTION_APP> appInsightsName=<AI> actionGroupId=<ACTION_GROUP_ID>`.
**Portal:** **Monitor → Alerts → Create → Alert rule**, scope the Function App / Key Vault, add the
same conditions.

### Dashboards & logs

[`observability/dashboards.md`](../observability/dashboards.md) has KQL for per-caller (`oid`) and
per-key-**alias** panels (requests, 401/403, 429, p95 latency, rotation signal). View in **Function App
→ Monitoring → Logs** (Application Insights) or **Metrics** for the raw counters. **Never logged:** the
real key value (only its alias), caller tokens, or vendor request/response bodies.

---

## Part 7 — Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **401** on every call | No/expired token, or caller app not on the Easy Auth allowlist | Check the token; add the app's appId to `allowedApplications` ([Part 4a](#a-easy-auth-allowlist-allowedapplications)) |
| **403** with a valid token | Caller lacks the app **role**, or the role omits `Application` member type for an app-only token | Assign the role ([Part 4b](#b-app-role-assignment)); ensure CI roles allow `Application` |
| Tokens silently rejected | App reg `requestedAccessTokenVersion` ≠ 2, or issuer not `/v2.0` | Set v2 ([Step 3](#step-3--create-the-entra-app-registration)); fix issuer |
| **403 at SCM** on deploy | Public access Disabled + deploying from outside the VNet | Deploy from in-VNet, or temp-toggle ([Part 2](#the-private-network-deploy-caveat)) |
| Vendor calls 401 after a rotation | Cache still holds the old key (≤5 min) | Wait 5 min, restart, or rely on reactive re-fetch ([Part 5](#part-5--rotate-a-key)) |
| `oauth2cc` vendor 401s | Wrong `tokenUrl`/`scope`, or bad client creds in KV | Verify the `ROLE_SECRET_MAP` entry + the stored secret |
| Health probe 401 from a monitor | `/api/health` not excluded | Add it to `excludedPaths` ([Part 6](#health-probe)) |
| App won't start after deploy | Runtime mismatch | Confirm `FUNCTIONS_WORKER_RUNTIME=node` in app settings ([Step 7](#step-7--configure-app-settings--smoke-test)) |

**Where to look:** **Function App → Monitoring → Log stream** (live), **→ Logs** (App Insights history),
**→ Diagnose and solve problems** (guided). Add `DEMO_MODE=1` temporarily to see `x-broker-*` diagnostic
response headers, and turn it back **off** for prod.

---

## Part 8 — Security posture checklist

Before calling it production:

- [ ] `publicNetworkAccess = Disabled` on the Function App **and** Key Vault
- [ ] Private endpoint exists and its connection state is **Approved**
- [ ] PE subnet `privateEndpointNetworkPolicies` = **Enabled** (if `Disabled`, the NSG is bypassed and you have NO IP filtering)
- [ ] PE-subnet NSG allows only your on-prem/VPN CIDR; `DenyAllInbound` present
- [ ] On-prem DNS forwards `privatelink.azurewebsites.net` to a resolver inside the VNet
- [ ] Inbound access restrictions still scoped to on-prem/VPN CIDR (defense-in-depth on the public path only)
- [ ] Easy Auth **on**, unauthenticated → **401** (not login-redirect)
- [ ] `allowedApplications` lists **only** real caller apps, with the **Azure CLI appId removed**
- [ ] App reg: `requestedAccessTokenVersion=2`, `appRoleAssignmentRequired=true`
- [ ] Managed identity is **Key Vault Secrets User scoped to secrets**, not the vault
- [ ] Key Vault **purge protection** on; no real key values in git (placeholders only)
- [ ] `DEMO_MODE=0`
- [ ] Alerts wired to an Action Group someone actually watches
- [ ] Rotation + grant/revoke runbooks handy; break-glass path documented

---

## Appendix — quick reference

**Everyday `az` commands**
```bash
# app settings
az functionapp config appsettings list -g <RG> -n <FUNCTION_APP> -o table
az functionapp config appsettings set  -g <RG> -n <FUNCTION_APP> --settings KEY=VALUE
# rotate a key
az keyvault secret set --vault-name <KEYVAULT> --name <SECRET> --value '<NEW>'
# restart (clears secret/token cache)
az functionapp restart -g <RG> -n <FUNCTION_APP>
# network posture
az functionapp show -g <RG> -n <FUNCTION_APP> --query 'properties.publicNetworkAccess' -o tsv

# private endpoint approved + the IP it resolves to
az network private-endpoint show -g <RG> -n <PREFIX>-pe \
  --query '{state:privateLinkServiceConnections[0].privateLinkServiceConnectionState.status, ip:customDnsConfigs[0].ipAddresses[0]}'

# CRITICAL: must print 'Enabled', else the PE-subnet NSG is bypassed entirely
az network vnet subnet show -g <VNET_RG> --vnet-name <VNET> -n <PREFIX>-pe-subnet \
  --query privateEndpointNetworkPolicies -o tsv
# health
curl -s -o /dev/null -w '%{http_code}\n' https://<broker.example.com>/api/health
```

**Related runbooks**

| File | Covers |
|---|---|
| [`iac/network-design.md`](../iac/network-design.md) | VNet reuse, private endpoint + NSG IP filtering, DNS prerequisite |
| [`identity/app-registration.md`](../identity/app-registration.md) | App reg, roles, v2 tokens |
| [`cicd/onboarding-runbook.md`](../cicd/onboarding-runbook.md) | Vendor onboarding, all env vars |
| [`cicd/oidc-setup-runbook.md`](../cicd/oidc-setup-runbook.md) | GitHub OIDC → broker (keyless CI) |
| [`identity/grant-revoke-runbook.md`](../identity/grant-revoke-runbook.md) | Caller grant/revoke, allowlist |
| [`test/rotation-runbook.md`](../test/rotation-runbook.md) | Key rotation, cache-bust |
| [`observability/dashboards.md`](../observability/dashboards.md) | KQL dashboards |

**Setting names (Node broker):** `KEYVAULT_URI`, `VENDOR_BASE_URL`, `INJECT_MODE`,
`VENDOR_KEY_HEADER_NAME`, `VENDOR_KEYID_HEADER_NAME`, `VENDOR_SECRET_HEADER_NAME`, `ROLE_SECRET_MAP`,
`MULTI_ROLE_VENDOR_ROUTING`, `DEMO_MODE`.

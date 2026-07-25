# Session Context — cxkey Key Broker (Option D) Live Deployment Review & Fixes
**Date:** 2026-07-21
**Operator:** admin@capitalexcavation.com
**Working dir:** /home/marhearn/.pi/azure_api_mgmt
**Reference docs:** ~/Documents/Client_Work/azure_api_broker/Option D — *.md (Portal + CLI walkthroughs)

---

## 1. Goal
Replace hardcoded vendor API keys in client code with an Azure-fronted **key broker**. The caller
presents its own Microsoft Entra token; the broker (an Azure Function) validates it, selects the
right vendor key from Key Vault based on the caller's single app role, strips any smuggled
credentials, injects the real key server-side, and forwards to the vendor. The real key never
leaves Azure. Intended access path: **users reach the broker privately over the existing Meraki
vMX VPN**, the same way `CX_Production_vNET` resources are reached.

---

## 2. Subscriptions (tenant 6a776d8b-0d62-4acb-945a-a51042d17ac0)
| Name | Sub ID | Notes |
|---|---|---|
| cx-dev-team | 3bbb2610-9f72-46b2-9b72-06556e82630e | Broker function + KV live here (rg-dev-sandbox) |
| CX_Production_Subscription | c650ec0c-63b3-4c78-a53a-23dde9cc2056 | Production vnet, private endpoint, vMX, DNS |
| Subscription 1 | (present) | — |
| AI_SG1 | (present) | — |

---

## 3. Live Resource Inventory

### 3.1 Entra app registration — `cxkey-broker-api`
- **appId (client ID):** ce485d55-f7af-40a8-b9d3-12dd64252740
- **object ID:** c641e5aa-0ee7-44a4-af01-ea6a46b4c25e
- **service principal (enterprise app) ID:** 0e52f716-f5af-4a7f-970e-4f16f4ded259
- **identifierUri:** api://ce485d55-f7af-40a8-b9d3-12dd64252740
- **signInAudience:** AzureADMyOrg (single tenant)
- **requestedAccessTokenVersion:** 2
- **appRoleAssignmentRequired (SP):** true
- **App roles (all enabled, members = [User, Application]):**
  | Value | Role ID |
  |---|---|
  | VendorApi.KeyA.Invoke | 69216011-f0e5-4295-8d11-827986f0fe1b |
  | VendorApi.KeyB.Invoke | 1123165a-3cba-4f3a-b02a-a843175f2c79 |
  | VendorApi.KeyC.Invoke | f01d0728-ab78-4327-922f-8ed7e72482d8 |
- **Delegated scope (ADDED this session):** `user_impersonation` id c4d2d889-5c2e-4a21-a19a-bbb9d059e9eb (type User)
- **Pre-authorized client (ADDED this session):** Microsoft Azure CLI 04b07795-8ddb-461a-bbee-02f9e1bf7b46
- **Federated credentials:** none (GitHub OIDC not set up)

**Role assignments:**
- admin@capitalexcavation.com (oid ddec1650-79fd-4dbc-afc7-3b6236a90f70, display "Admin") → VendorApi.KeyA.Invoke
- scanner@capitalexcavation.com (oid 72ab0787-ded2-4b43-a04e-1a22ab3ba0eb, display "Scanner") → VendorApi.KeyB.Invoke *(switched from KeyA this session)*

### 3.2 Key Vault — `kv-broker-cxapi` (rg-dev-sandbox, cx-dev-team)
- RBAC authorization: **on**; vaultUri https://kv-broker-cxapi.vault.azure.net/
- Public network: **Enabled** (PoC); soft-delete on; purge protection off
- Secrets (enabled): vendor-key-a, vendor-key-b, vendor-key-c — **still PoC fakes** (sk-fake-A/B/C)
- Function MI (b93151aa-5cdc-480e-80a9-aa746bcadf47) has **Key Vault Secrets User** scoped to the whole vault

### 3.3 Storage — `stkeymgmtcx` (CX_group, cx-dev-team)
- StorageV2, allowBlobPublicAccess=false, public network Enabled
- Flex deployment package container: app-package-func-broker-cxapi-ca3b0c6
- Deployment + AzureWebJobsStorage authenticate via **connection string (account key)**, not MI

### 3.4 Function app — `func-broker-cxapi` (rg-dev-sandbox, cx-dev-team)
- Flex Consumption, **Node 22**, state Running, HTTPS-only, TLS 1.2
- **Default hostname:** func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net
- **publicNetworkAccess: Disabled** (private-endpoint-only — correct posture)
- System-assigned MI principalId: b93151aa-5cdc-480e-80a9-aa746bcadf47
- Always-ready: 1 each for http/blob/durable; instance memory 2048 MB; max 100
- App settings: KEYVAULT_URI=https://kv-broker-cxapi.vault.azure.net/, VENDOR_BASE_URL=https://httpbin.org/anything (PoC), INJECT_MODE=header
- No outbound VNet integration configured (virtualNetworkSubnetId = null)

### 3.5 Production networking (CX_Production_Subscription, RG `CX_Poduction_ResourceGroup`)
- **CX_Production_vNET** 10.0.0.0/16, DNS = Azure default
  - subnet `default` 10.0.0.0/24 — prod VMs; route table **vMX_to_Capital_RouteTable**; KeyVault service endpoint
  - subnet `AzureBastionSubnet` 10.0.1.0/24 — Bastion host CX_BASTION
  - subnet `vn-broker-cxapi` 10.0.2.0/26 — **delegated to Microsoft.App/environments** (staged for Flex outbound VNet integration; currently unused)
- **Peering:** CX_Production_vNET ↔ **vMX_Meraki** (10.2.0.0/24, subnet vMX_Subnet) — Connected, forwarded traffic allowed
- **Private endpoint `pve-broker-cxapi`** (+ nic, NSG `sg-broker-cxapi`)
  - target: func-broker-cxapi (cross-subscription), groupId `sites`, status **Approved**
  - subnet: CX_Production_vNET/default, **private IP 10.0.0.10**
- **Private DNS zone `privatelink.azurewebsites.net`** (linked to CX_Production_vNET, link `22bcc744e98a6`)
  - A: func-broker-cxapi-csb2cscrdcdka3fy.centralus-01 → 10.0.0.10
  - A: func-broker-cxapi-csb2cscrdcdka3fy.scm.centralus-01 → 10.0.0.10
- Other zones present (linked to vMX_Meraki): privatelink.vaultcore.azure.net, privatelink.blob.core.windows.net (used by Azure Migrate resources)
- On-prem "Capital" LAN reached via vMX; on-prem DNS servers **192.168.60.229 / 192.168.60.230** (CX domain controllers)

---

## 4. Changes Made This Session (chronological)

1. **Easy Auth fix on func-broker-cxapi (authsettingsV2 PUT).**
   - issuer: `https://login.microsoft.com/<tenant>/v2.0` → **`https://login.microsoftonline.com/6a776d8b-0d62-4acb-945a-a51042d17ac0/v2.0`** (wrong host would break OIDC/`iss` validation)
   - allowedAudiences: `[]` → **`["ce485d55-...","api://ce485d55-..."]`**
   - unchanged: requireAuth=true, unauthAction=Return401, allowedApplications=[ce485d55-...], clientId
2. **Scanner role switch:** added VendorApi.KeyB.Invoke, removed VendorApi.KeyA.Invoke (now exactly one = KeyB).
3. **Exposed delegated scope + pre-authorized CLI** on cxkey-broker-api (see 3.1) to unblock user-delegated token acquisition via Azure CLI (fixes AADSTS650057 / AADSTS65001).

*Not changed:* app roles model, assignment-required, service-principal path, networking, KV/storage.

---

## 5. Test Artifacts (in ./test/)
Four equivalent smoke tests; each: DNS/private-path check → acquire+decode v2 token (prints ver/aud/roles)
→ Test A (200 + injected key) → Test B (401 no token) → Test D (smuggled x-api-key stripped).
- `broker-smoketest.sh` — bash + az/curl/jq
- `broker-smoketest.mjs` — Node 18+ (`npm i @azure/identity`), uses DefaultAzureCredential
- `broker_smoketest.py` — Python 3 (`pip install azure-identity requests`), DefaultAzureCredential
- `broker-smoketest.ps1` — PowerShell 5.1 / 7 (pure ASCII; TLS1.2; az token). For the Windows prod VMs.

Constants used: scope `api://ce485d55-f7af-40a8-b9d3-12dd64252740/.default`, broker
`https://func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net/api/broker/anything`,
expected private IP 10.0.0.10.

---

## 6. Errors Encountered & Resolutions
- **PowerShell parse errors** — file had em dashes; Windows PS 5.1 read as ANSI → mojibake. Fixed: script is now pure ASCII.
- **`az login --scope` "expected at least one argument"** — PowerShell line-wrap split the arg; must be one line.
- **AADSTS65001 consent_required** (admin) / **AADSTS650057 Invalid resource** (scanner) — broker exposed **no delegated scope**, so the CLI (user-delegated client) had nothing valid to request. Fixed by adding `user_impersonation` + pre-authorizing the CLI (change #3).
- **Token failure was NOT a missing role** — admin holds KeyA; scanner holds KeyB.
- **Earlier wrong call:** I first reported "stranded ingress" because I only looked for a private endpoint in rg-dev-sandbox. The PE is cross-subscription in the prod RG and is Approved — ingress is built.

---

## 7. Current State / Verified
- Identity, roles, KV secrets, Node-22 Flex function: **stood up**. "No cold start" hardening (always-ready) applied.
- Easy Auth now correct (issuer + both audiences). Assignment-required enforced.
- Private ingress path exists: PE 10.0.0.10 (Approved) + privatelink DNS + vMX peering.
- **Blocking gap found during testing:** the Windows prod box resolves the broker hostname to the
  **public** IP 20.118.48.4 (via on-prem DCs 192.168.60.229/230), not 10.0.0.10 — so the private
  path isn't used. Token also failed until the scope/pre-auth fix.
- Broker still points at **httpbin with fake keys** (PoC), so Test A echoes sk-fake-*, not a real vendor call.

---

## 8. Remaining Work
1. **DNS for VPN clients (the real ingress gap).** On-prem DCs (192.168.60.229/230) forward
   `azurewebsites.net` to a public resolver. Fix: stand up an **Azure Private DNS Resolver**
   (inbound endpoint in CX_Production_vNET) or a forwarder VM, then add a **conditional forwarder
   on the DCs** for `azurewebsites.net` → that resolver IP. Then every VPN user resolves 10.0.0.10.
   *Quick test shortcut:* hosts entry `10.0.0.10  func-broker-cxapi-...azurewebsites.net` on the box.
2. **Verify vMX route to 10.0.0.0/16** so on-prem→10.0.0.10 actually routes over the tunnel.
3. **Flip broker off PoC:** set VENDOR_BASE_URL to the real vendor, INJECT_MODE per vendor contract,
   replace KV secrets with real keys.
4. *(Optional, full private path)* attach outbound VNet integration into vn-broker-cxapi, add KV +
   storage private endpoints, disable their public access.
5. *(Prod hardening)* GitHub OIDC federated credential + direct app-role assignment to CI SP;
   least-privilege KV RBAC scoped per-secret; rate limiting; App Insights alerts.

---

## 9. Client App Integration (the developer's actual change)
Delete the API key; acquire an Entra token via DefaultAzureCredential and call the broker.
- Scope: `api://ce485d55-f7af-40a8-b9d3-12dd64252740/.default`
- Base URL: `https://func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net/api/broker/` + vendor path
- Real apps authenticate as a **service principal / managed identity with a direct app-role
  assignment** (no consent prompt). The CLI consent/pre-auth work is only for human CLI testing.

```python
from azure.identity import DefaultAzureCredential
import requests
tok = DefaultAzureCredential().get_token("api://ce485d55-f7af-40a8-b9d3-12dd64252740/.default").token
r = requests.get("https://func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net/api/broker/anything",
                 headers={"Authorization": f"Bearer {tok}"})
```

---

## 10. Test Procedure (Windows prod box, as Scanner → expects sk-fake-B)
```powershell
az logout
az login --tenant "6a776d8b-0d62-4acb-945a-a51042d17ac0"
az account get-access-token --scope "api://ce485d55-f7af-40a8-b9d3-12dd64252740/.default"
# hosts shortcut until DNS resolver is built:
Add-Content C:\Windows\System32\drivers\etc\hosts "`n10.0.0.10`tfunc-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net"
.\broker-smoketest.ps1
```
Expected: token ver=2.0, roles=VendorApi.KeyB.Invoke; Test A 200 + sk-fake-B; Test B 401; Test D stripped.

# Session Context — Broker made to actually work end-to-end (Node deploy)
**Date:** 2026-07-22
**Operator:** admin@capitalexcavation.com (az CLI signed in as this user)
**Working dir:** /home/marhearn/.pi/azure_api_mgmt
**Prior context:** SESSION-CONTEXT-2026-07-21.md (live-deploy review), SIGN-OFF.md (C# artifact set)

---

## 1. Headline
The live Flex Consumption function `func-broker-cxapi` had **0 functions deployed** — an
empty/unloadable package — so every authenticated call 404'd. We wrote and deployed a **minimal
Node 22 broker** (`function-node/`) to the existing app and proved the full chain live against
**OpenRouter** (a stand-in for NinjaOne, chosen because it uses a static `Bearer` key).

**Acceptance (live, from this machine over the private path):**
- A — valid Entra token + role KeyA → **200** + OpenRouter key JSON (real key injected server-side)
- B — no token → **401** (Easy Auth)
- D — smuggled `x-api-key` + valid token → **200** (smuggled cred stripped, real key wins)

## 2. Key discovery: two implementations
- **Live/deployed = Node 22** PoC infra (settings `VENDOR_BASE_URL` / `INJECT_MODE` / `KEYVAULT_URI`).
  Its original source was lost, and the app had no functions loaded.
- **This repo's `function/` = .NET 8 (C#)** "v1 artifact set" (SIGN-OFF.md) — **never deployed**;
  different app-setting names (`VENDOR_BACKEND_BASE_URL`, `VENDOR_KEY_AS_BEARER`). Left as-is.
- Decision: keep Node (already provisioned, easier). New code lives in **`function-node/`**.

## 3. Changes made this session (LIVE Azure)
1. **App settings** on `func-broker-cxapi` (sub cx-dev-team 3bbb2610…, rg-dev-sandbox):
   - `VENDOR_BASE_URL`: `https://httpbin.org/anything` → **`https://openrouter.ai/api/v1`**
   - `INJECT_MODE`: `header` → **`bearer`**
2. **Key Vault** `kv-broker-cxapi`: `vendor-key-a` new version = the **OpenRouter test key**
   (copied from a duplicate secret `vendor-key-a-2` the operator created).
3. **Easy Auth** (`authsettingsV2`): added **Azure CLI appId `04b07795-8ddb-461a-bbee-02f9e1bf7b46`**
   to `allowedApplications` (was only the broker `ce485d55…`). Needed so human CLI-issued tokens
   (azp = Azure CLI) are accepted. Audiences / requireAuth / secret-ref preserved.
4. **Deployed** `function-node/` via One Deploy (`az functionapp deployment source config-zip`,
   node_modules bundled). Function `broker` now registered (route `broker/{*path}`).

## 4. Verified networking (#2 from prior session — no Azure-side change needed)
- vMX NVA `vMXMerakiVM` NIC `10.2.0.4`, **IP forwarding ON**, in mrg-cisco-meraki-vmx-20220902113854.
- Peering `CX_Production_vNET ↔ vMX_Meraki`: Connected, allowForwardedTraffic=true.
- Route table `vMX_to_Capital_RouteTable` on prod `default` subnet returns on-prem client subnets
  (192.168.60/.5/.3 → 10.2.0.4). Broker PE `10.0.0.10` is in that subnet.
- This machine resolves the broker to `10.0.0.10` and reaches it privately.
- Only unverifiable-from-Azure piece: the Meraki dashboard advertising `10.0.0.0/16` to on-prem
  (symmetric return routes already exist, so almost certainly configured).

## 4b. pi agent identity (wired + verified this session)
- App/SP **`cxkey-pi-agent`** — client ID **`1cea04a4-0e41-4959-a4f4-f4e36038d85f`**,
  SP objectId `59a6cdd5-473d-464e-be28-eb14b046fefa`.
- Direct app-role assignment: **`VendorApi.KeyA.Invoke`** (→ vendor-key-a, the OpenRouter key).
- Added to Easy Auth `allowedApplications` (this is the correct prod pattern — a real SP, not the CLI).
- Auth = client credentials (secret). On the pi set `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
  `AZURE_CLIENT_SECRET`; `DefaultAzureCredential` + `broker_client.broker_openai()` does the rest.
- **Verified live:** app-only token roles=[KeyA]; smoke A/B/D/E all PASS.
- ⚠️ The client secret created during testing was printed into the chat — **treat as burned**,
  rotate before the pi goes live (see TODO).

## 5. TODO — cleanup + prod hardening (do NOT ship test state)
- [ ] **Rotate the pi-agent client secret** (`az ad app credential reset --id 1cea04a4-…`) and set
      it only on the pi — the test secret leaked into the session transcript.
- [ ] **Revert Easy Auth allowlist for prod:** remove Azure CLI `04b07795…` from
      `allowedApplications`; list real client SP appIds instead (prod apps present their own SP as azp).
- [ ] **Delete the duplicate secret** `vendor-key-a-2` in `kv-broker-cxapi` (leftover).
- [ ] **Swap OpenRouter → NinjaOne** when ready: set `VENDOR_BASE_URL` to the NinjaOne region base
      (e.g. `https://app.ninjarmm.com` / `eu` / `ca` / `oc`), load the NinjaOne M2M tokens into
      `vendor-key-a/b/c` (per role). Static bearer M2M tokens — no OAuth exchange (confirmed by operator).
- [ ] **#5 prod hardening** (deferred until seen working — now it is): GitHub OIDC FIC + direct
      app-role assignment to CI SP; per-secret KV RBAC; rate limiting; App Insights alerts.
- [ ] Rotate the OpenRouter test key after testing (it's a real, if small, key).

## 6. Constants
- Broker: `https://func-broker-cxapi-csb2cscrdcdka3fy.centralus-01.azurewebsites.net/api/broker/<path>`
- Private IP: `10.0.0.10` | Scope: `api://ce485d55-f7af-40a8-b9d3-12dd64252740/.default`
- Roles → secrets: KeyA→vendor-key-a, KeyB→vendor-key-b, KeyC→vendor-key-c
- Test endpoint used: `/api/broker/auth/key` → `https://openrouter.ai/api/v1/auth/key`

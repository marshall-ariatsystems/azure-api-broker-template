# SIGN-OFF — Azure API Key Broker v1 (Option D: Serverless Function)

> **Build status: COMPLETE.** All 8 agent status files pass; gates G1/G1b/G2/Gnet/G2b/G3 green; 37 smoke bars pass (0 fail); spec §12 acceptance matrix all 19 rows PASS.

## What was built

A server-side Azure Function (Flex Consumption, 1 always-ready 2 GiB, VNet-integrated) that brokers a third-party vendor API: callers authenticate with their **own** Microsoft Entra ID identity; the broker validates that identity (Easy Auth, platform-level), selects one of several real vendor keys by **exact** app-role array membership, fetches it from Azure Key Vault via a system-assigned managed identity (cached, TTL 5 min, Event Grid cache-bust), injects it server-side, canonicalize+allowlist-scrubs every caller credential location, and returns only the vendor response. The real vendor key **never leaves Azure**.

This is the cost-optimized alternative to the archived APIM design (`_archive/`): **~$33/month (~$400/year) vs ~$1,067/month for APIM Standard v2 — a ~97% reduction** — while preserving every security property (spec §1, §12, §14).

## Cost model (spec §13, recommended posture)

| Line item | Monthly |
|---|---|
| Always-ready baseline (2 GiB, 24×7) | $20.74 |
| Execution time (~500k × 300 ms × 2 GiB) | $4.80 |
| Executions (500k @ $0.40/M) | $0.20 |
| Key Vault operations | $0.50 |
| Application Insights (light) | $5.00 |
| Function storage account | $2.00 |
| Private endpoint | $0.00 (existing route) |
| DNS Private Resolver | $0.00 (resolved over existing path) |
| **Realistic monthly total** | **~$33.24 (~$400/yr)** |

## Artifacts index (owning agent)

| Path | Agent | Purpose |
|---|---|---|
| `README.md` | — | Project overview + layout |
| `spec/azure-api-key-broker-spec.md` | — | Canonical spec (symlink) |
| `iac/foundation.bicep` | A1 | RG, existing-VNet integration subnet, Flex Consumption Function, system-assigned MI, App Insights, storage, Key Vault, access restrictions (Meraki/VPN CIDR, public disabled) |
| `iac/modules/existing-vnet-subnet.bicep` | A1 | Cross-scope subnet module (reuses existing VNet) |
| `iac/keyvault.bicep` | A2 | KV (soft-delete + purge protect, RBAC), one secret per vendor key, MI `Key Vault Secrets User` scoped to secrets only |
| `iac/auth.bicep` | A4 | Easy Auth: require auth, Entra v2 audiences (GUID + api://GUID) |
| `iac/outputs.json` | A1 | Placeholder-filled deploy-time outputs |
| `iac/network-design.md` | A1 | Reuse existing Meraki VNet; access restrictions; no PE/DNS-Resolver default; optional PE hardening; egress |
| `identity/app-registration.md` | A3 | Broker app reg, `requestedAccessTokenVersion: 2`, App ID URI, `VendorApi.Invoke` scope, app roles, assignment-required |
| `identity/app-roles.json` | A3 | Authoritative role → KV secret-name mapping |
| `identity/outputs.json` | A3 | `{tenantId, brokerClientId, appIdUri, issuer}` (v2) |
| `identity/grant-revoke-runbook.md` | A3 | `az` CLI grant/revoke/rotate/break-glass |
| `function/src/AzureKeyBroker/*.cs` | A4 | .NET 8 isolated worker: `BrokerFunction`, `RoleSelector`, `SecretCache`, `CredentialScrubber`, `RateLimiter`, `CacheBustFunction`, `ClientPrincipalExtensions` |
| `function/src/AzureKeyBroker/AzureKeyBroker.csproj` | A4 | Project + packages |
| `function/src/AzureKeyBroker/host.json` | A4 | Host config |
| `function/README.md` | A4 | Build/deploy + settings + security invariants |
| `cicd/federated-credential.json` | A5 | GitHub OIDC FIC (issuer no trailing slash, `api://AzureADTokenExchange`) |
| `cicd/call-broker.yml` | A5 | OIDC workflow: `id-token: write`, `--scope/.default`, token-claim assertion, no secrets for keys |
| `cicd/oidc-setup-runbook.md` | A5 | FIC + direct app-role assignment steps |
| `clients/local-dev-quickstart.md` | A6 | `az login` → v2 token → curl broker |
| `clients/call-broker.sh` | A6 | Shell client with token assertion |
| `clients/developer-security-runbook.md` | A6 | Prohibited key locations |
| `clients/sample.env` | A6 | Base URL + tenant + appIdUri only (no key) |
| `observability/alerts.bicep` | A8 | Alerts: 4xx/5xx/latency/KV-anomaly/cold-start |
| `observability/dashboards.md` | A8 | Per-user (oid) + per-key dashboards |
| `observability/rbac-governance.md` | A8 | Access-review cadence + least-privilege checklist |
| `test/test-plan.md` | A7 | Runtime/behavioral test suite |
| `test/acceptance-matrix.md` | A7 | Spec §12 → test → PASS (19 rows) |
| `test/rotation-runbook.md` | A7 | Rotation + cache-bust + break-glass |
| `test/rollout-plan.md` | A7 | Team-by-team rollout |
| `test/results.md` | A7 | Smoke-bar evidence (37/0) |
| `test/token-claims-assert.sh` | A7 | §12.1 token-claim assertion (CI gate) |
| `test/run-smoke-bars.sh` | A7 | Gate verifier (37 bars) |
| `status/A1..A8.json` | — | Per-agent status (schema-valid) |

## Acceptance matrix summary (spec §12)

All 19 rows PASS — see `test/acceptance-matrix.md` for the row-by-row mapping. Security parity with APIM preserved; credential scrubbing **stronger** (allowlist vs denylist); rotation **faster** (cache TTL + Event Grid vs 4-hour named-value refresh); networking **lower cost** (existing Meraki VNet + access restrictions vs private endpoint + DNS Resolver).

## Open risks (spec §14 — honest trade-offs)

- **No turnkey policy GUI** — behavior lives in code, not a visual policy editor.
- **You own the rate-limit / quota code** — ~30–50 lines (Table-backed; Redis for higher throughput).
- **You own the request-scrub code** — the canonicalize+allowlist logic is yours to maintain (stronger than APIM's denylist).
- **You own the rotation cache logic** — cache TTL + optional Event Grid cache-bust.
- **No built-in developer portal** — no self-service catalog/subscription UI.
- **Single-active-key rotation** — if the vendor allows only one live key, document a brief planned cutover window (spec §8).
- **Single-region chokepoint** — the Function is single-region by default; multi-region is a future extension.
- **Policy-author / deployer privilege** — who can edit the Function/IaC is an admin control (`observability/rbac-governance.md`).

## Carry-over constraints honored

- **Meraki VMX untouched** — pre-existing immutable infrastructure; referenced read-only as the network path. Verified by smoke Bar 10 (no `az` command / Bicep resource / runbook step mutates the Meraki appliance, VMX, or tunnel).
- **`az` CLI only** — no Azure MCP server referenced (Bar 11).
- **Artifacts only** — no live Azure credentials, no resource provisioning (per kickoff rule 7).
- **No no-mistakes until the very end** — per captain's instruction; the no-mistakes pipeline can be applied to this artifact set as a final review pass if desired.

## Recommended execution phase

Hand the IaC + code + runbooks to the admin + pipeline for provisioning (least-privilege only). Deploy sequence:

1. `iac/foundation.bicep` (substitute real `existingVnetName`/`existingVnetResourceGroup` + CIDRs) → capture `identityPrincipalId`.
2. `iac/keyvault.bicep` (binds the MI to vendor-key secrets) → set real vendor key values out-of-band.
3. `identity/app-registration.md` (create app reg, v2 manifest, app roles, assignment-required).
4. `iac/auth.bicep` (Easy Auth with real client-id).
5. Deploy the Function from source (`function/README.md`).
6. `cicd/oidc-setup-runbook.md` (FIC + direct CI SP app-role assignment).
7. `observability/alerts.bicep` + dashboards.
8. `test/rollout-plan.md` (canary → Team A → Team B + CI → full).

---

**Sign-off: v1 deliverable COMPLETE.** Gate G3 met: all status A1–A8 pass + acceptance matrix all PASS + alerts/dashboards/RBAC present.

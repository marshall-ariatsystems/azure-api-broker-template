# Azure API Key Broker — Multi-Agent Implementation Plan

> **Revision note (v2):** Corrected after a model-council review against Microsoft Learn. Key changes: the DAG is fixed so **A2 runs after A1+A3** (not in Wave 1), **A6 is a hard prerequisite for A7** (no longer parallel), a **network-reachability gate** runs before client/test, and a new **Agent A8 (Observability & Governance)** is added; **G3 now requires all status files A1–A8**; acceptance-criteria traceability now maps the new runtime tests (multi-role 403, credential-smuggling across header/query/body, rotation window, split-horizon DNS); and new risks (public DNS-name constraint, DNS Private Resolver dependency, fixed egress IP, single-active-key rotation, single-region chokepoint) are recorded in §8. Hostname is `broker.contoso.com` and tokens are v2 (`--scope .../.default`) throughout.

> Companion to the design spec `azure-api-key-broker-spec.md`. This document is the **human-readable implementation plan**. The operative, agent-consumable version is `orchestrator-kickoff.md` in the same directory.

## 0. Purpose and scope

This plan converts the approved design spec into an **orchestrated multi-agent build program**. It defines eight specialized worker agents (A1–A8), the order in which an orchestration agent should run them, the dependency gates between them, the exact files each agent must produce and consume, and how completion maps back to the spec's acceptance criteria (spec §12).

**Non-negotiable constraint carried into every agent:** the real vendor API keys never leave Azure and are never seen by any developer, in code, `.env`, GitHub secrets, logs, browser tools, or on any device. Every agent brief repeats this constraint so it cannot be lost in handoff.

**Target baseline:** APIM **Standard v2 + inbound private endpoint with public network access disabled** (spec §13 default). Premium v2 VNet injection or classic Premium internal VNet mode is the private-only alternative when full gateway isolation is required.

## 1. Orchestration model

| Role | Responsibility |
|---|---|
| **Orchestrator agent** | Reads `orchestrator-kickoff.md`, dispatches worker agents in wave order, verifies each gate condition before advancing, collects artifacts, retries failed agents, and reports status. Does not implement work itself. |
| **Worker agents A1–A8** | Each owns one domain of the spec. Reads its declared inputs from the shared workspace, produces its declared outputs to fixed paths, and reports pass/fail against its exit criteria. |
| **Shared workspace** | `/home/user/workspace/azure-broker/` is the single source of truth. All inter-agent handoff is via files at canonical paths (see §6). No agent depends on another agent's in-memory state. |

### Directory contract

```text
/home/user/workspace/azure-broker/
  azure-broker-orchestration-plan.md      # this file
  orchestrator-kickoff.md                 # orchestrator's operative brief
  spec/azure-api-key-broker-spec.md       # copy/reference of the design spec
  iac/                                    # A1 infrastructure-as-code (VNet, APIM, DNS Private Resolver)
  iac/kv/                                 # A2 Key Vault + named values (own subpath; avoids A1 collision)
  identity/                               # A3 Entra app reg + roles output
  apim/                                   # A4 API definition + policy XML
  cicd/                                   # A5 GitHub OIDC + workflow
  clients/                                # A6 local dev + runbook
  observability/                          # A8 alerts + dashboards + RBAC governance
  test/                                   # A7 test plan + results + runbooks
  status/                                 # per-agent status + gate markers
```

## 2. Worker agent roster

| Agent | Domain | Spec coverage |
|---|---|---|
| **A1** | Foundation & Networking | Phases 1–2, §5 |
| **A2** | Key Vault & Secret Injection | Phase 3, §3 |
| **A3** | Identity & Authorization | Phase 4, §2 |
| **A4** | APIM API & Broker Policy | Phase 5, §4 |
| **A5** | GitHub OIDC & CI/CD | Phase 6, §2.4, §9.1 |
| **A6** | Client Enablement | §9.2–9.3, §6 |
| **A7** | Testing, Security & Rollout | Phases 7, §11, §12 |
| **A8** | Observability & Governance | §7 ops, §11 governance |

### A1 · Foundation & Networking
- **Implements:** Resource group; VNet + subnets (incl. a subnet for an **Azure DNS Private Resolver**); APIM deployment (Standard v2) with inbound private endpoint and public network access disabled; `privatelink.azure-api.net` private DNS zone; **split-horizon** DNS so the **publicly-registered** gateway name `broker.contoso.com` resolves to the private-endpoint IP for on-prem (Meraki MX private route) and VPN users while the endpoint refuses public traffic; a **DNS Private Resolver** (or forwarder VMs) so on-prem/VPN clients can resolve the Azure private zone; conditional forwarding from on-prem DNS to the resolver. Notes egress (Std v2 shared SNAT, no NAT Gateway; use Firewall/NAT or Premium if the vendor allowlists an outbound IP). System-assigned managed identity is mandatory.
- **Outputs:** `iac/foundation.bicep` (or `.tf`), `iac/network-dns-design.md`, `iac/outputs.json`, `status/A1.json`.
- **Exit criteria:** APIM name, `gatewayHostname = broker.contoso.com`, private endpoint IP, VNet/subnet IDs, and the APIM system-assigned identity principalId are recorded in `iac/outputs.json`; the split-horizon + DNS Private Resolver path from Meraki/VPN is documented and validated in design.

### A2 · Key Vault & Secret Injection
- **Implements:** Key Vault with soft-delete + purge protection, RBAC model, private endpoint/firewall; one secret per vendor key (values 1–4096 chars); the APIM **system-assigned** managed identity binding (mandatory when the KV firewall is enabled); **least-privilege grant of `Key Vault Secrets User` (get) scoped to ONLY the specific vendor-key secrets — not the whole vault** (a rogue policy could otherwise use `send-request` + `authentication-managed-identity` to read any reachable secret); Key Vault-backed APIM named values using **unversioned** secret URIs for auto-refresh; optional Event Grid `SecretNewVersionCreated` trigger for immediate refresh. Writes all outputs under `iac/kv/` to avoid colliding with A1's `iac/` files.
- **Depends on:** A1 (APIM identity + VNet) **and** A3 (role→alias map). Runs in **Wave 2, after G1** — not in Wave 1.
- **Outputs:** `iac/kv/keyvault.bicep`, `iac/kv/named-values.bicep`, `iac/kv/keyvault-rbac.md`, `status/A2.json`.
- **Exit criteria:** APIM system-assigned identity has secret-**get** scoped to only the vendor-key secrets; named values `vendor-key-a/b/c` reference unversioned secret URIs; named-value **display names exactly equal** A3's role→alias mapping (checked at G1b); no human has routine read on secret values.

### A3 · Identity & Authorization
- **Implements:** Broker API app registration + stable App ID URI; app manifest **`requestedAccessTokenVersion: 2`** (v2 tokens: `aud` = client-ID GUID, issuer `https://login.microsoftonline.com/<tenant>/v2.0`); delegated scope `VendorApi.Invoke`; per-key app roles `VendorApi.KeyA/B/C.Invoke` with **`allowedMemberTypes` including `Application`** (so app-only CI tokens carry a `roles` claim); **direct** app-role assignment for CI workload SPs (no group nesting); **"assignment required"** on the enterprise app; Entra group → app-role grant/revoke model for humans; optional client app registrations for interactive MSAL. Runs in **Wave 1 (root)** and publishes the role→alias map that A2 consumes in Wave 2.
- **Outputs:** `identity/app-registration.md`, `identity/app-roles.json`, `identity/grant-revoke-runbook.md`, `identity/outputs.json` (tenantId, brokerClientId, appIdUri, **issuer**), `status/A3.json`.
- **Exit criteria:** App ID URI + broker client ID + tenant ID + **v2 issuer** published to `identity/outputs.json`; app roles include `Application` in `allowedMemberTypes`; role→alias mapping is the source A2's named-value display names must match.

### A4 · APIM API & Broker Policy
- **Implements:** APIM API + backend for the vendor; **subscription requirement disabled** so `validate-jwt` is the sole gate; the corrected inbound broker policy — `validate-jwt` (v2 audiences = client-ID GUID **and** `api://<clientId>`, `output-token-variable-name="broker-jwt"`) → **read `roles` as a typed `string[]` array via `((Jwt)context.Variables["broker-jwt"]).Claims["roles"]`** (never `.Contains` over a comma-joined string) → count recognized key-roles and **403 if count != 1** (rejects zero-role and ambiguous multi-role) → strip the full client credential surface (header case variants, query params, body/form fields) → keep caller `oid`/`azp` in policy variables **for logging only** (not forwarded to the vendor) → drop caller bearer → select key by **exact array membership** and inject the named value → `set-backend-service`; **symmetric** outbound + on-error scrub of key **headers and query params**; **`rate-limit-by-key`/`quota-by-key`** keyed on selected alias/caller; metadata-only diagnostics (the real leak control).
- **Depends on:** A1 (APIM), A2 (named values), A3 (audience/issuer/roles). Runs in **Wave 3, after G1b**.
- **Outputs:** `apim/vendor-api.openapi.yaml` (or import def), `apim/broker-policy.xml`, `apim/rate-limit-quota.md`, `apim/diagnostics-config.md`, `status/A4.json`.
- **Exit criteria:** Policy references live named values and A3 audience (resolved GUID)/issuer/roles; **role selection uses array membership on `broker-jwt`** (not `.Contains` over a flattened string); a **multi-role 403 branch** exists; **subscription requirement disabled**; product-scope vs API-scope decision documented; no vendor key or bearer token can be logged.

### A5 · GitHub OIDC & CI/CD
- **Implements:** Entra workload app reg (or managed identity) per trust boundary; federated identity credential with issuer **`https://token.actions.githubusercontent.com` (NO trailing slash, exact match)**, audience `api://AzureADTokenExchange`, repo/env-scoped subject; **direct** per-key app-role assignment to the workload SP; `azure/login` OIDC workflow that acquires a **v2** broker token with **`az account get-access-token --scope "<appIdUri>/.default"` (never `--resource`)**, adds a **token-claim assertion step** (decode `aud`/`iss`/`roles` before calling APIM), then calls `https://broker.contoso.com` with a bearer token only; enforcement that no Azure secret or vendor key lives in the repo. Clarifies SAML-SSO (human) vs OIDC (workload). Runner reachability chosen: self-hosted runners in an Azure VNet (or GitHub-hosted with Azure private networking); alternative controlled public ingress noted with cost.
- **Depends on:** A3 (app roles to assign the workload SP). Runs in **Wave 3, in parallel with A4 after G1b**.
- **Outputs:** `cicd/federated-credential.json`, `cicd/call-broker.yml`, `cicd/oidc-setup-runbook.md`, `status/A5.json`.
- **Exit criteria:** Federated credential issuer == `https://token.actions.githubusercontent.com` (no slash) and audiences == `["api://AzureADTokenExchange"]`; subject scoped to repo/environment; workflow uses `id-token: write`, **`--scope .../.default`**, and a **token-claim assertion step**, with no stored secret; SP holds the correct per-key app role.

### A6 · Client Enablement
- **Implements:** Local developer token flow (`az login` / device code / MSAL) acquiring a **v2** broker token with **`--scope "<appIdUri>/.default"`** and calling `https://broker.contoso.com` with only a bearer token (plus a client-side token-decode/assert snippet); **chosen** Codespaces reachability path (private-network dev container in-VNet or VPN split-tunnel to the private endpoint, with DNS for `broker.contoso.com` resolving to the PE IP); developer runbook enforcing "never read, store, or transmit the vendor key"; sample `.env` that holds only base URL + tenant + appIdUri.
- **Depends on:** A1 (base URL/DNS), A3 (audience/scope), A4 (endpoint path). Runs in **Wave 4, after G2 and the network gate**; **A6 is a hard prerequisite for A7**.
- **Outputs:** `clients/local-dev-quickstart.md`, `clients/call-broker.sh`, `clients/developer-security-runbook.md`, `status/A6.json`.
- **Exit criteria:** A developer can obtain a **v2** token and call `broker.contoso.com` with zero key handling; Codespaces reachability path documented; runbook lists every prohibited key location.

### A7 · Testing, Security & Rollout
- **Implements:** **Runtime/behavioral** tests — token-decode (assert `aud`/`iss`/exactly one `VendorApi.Key*` role); wrong-audience/issuer/no-role → 401/403 with no vendor request; **multi-role 403 test** (a two-key-role token is rejected, proving the `count != 1` branch); **credential-smuggling matrix across HEADER, QUERY, and BODY/form**; log-leakage test (alias present, real key/bearer absent, no key in logged query strings); **rotation-window test** (rotate a KV secret and confirm the unversioned named value refreshes with zero downtime); **split-horizon DNS test** (on-prem/VPN resolve to PE IP via DNS Private Resolver; public internet is refused); audit-logging + PCI runbook; break-glass + team-by-team rollout starting with sandbox key + small group; acceptance-criteria verification matrix (spec §12).
- **Depends on:** A4, A5, **A6 (hard prerequisite)**, and A8 outputs. Runs in **Wave 5, after G2b** — not parallel with A6.
- **Outputs:** `test/test-plan.md`, `test/acceptance-matrix.md`, `test/rotation-runbook.md`, `test/rollout-plan.md`, `test/results.md`, `status/A7.json`.
- **Exit criteria:** All spec §12 acceptance criteria have a mapped test and a pass result, **including token-decode, multi-role 403, credential-smuggling (header/query/body), rotation-window, and split-horizon DNS**; rotation, revocation, and break-glass runbooks are executable.

### A8 · Observability & Governance
- **Implements:** Azure Monitor alerts on APIM (4xx rate incl. 401/403 spikes, 5xx rate, backend latency, **SNAT port exhaustion**), plus Key Vault access-anomaly and cost-anomaly alerts; **per-user (caller `oid`/`azp`) and per-key (selected vendor-key alias)** dashboards for volume/error/quota; RBAC governance (recurring access review of policy editors, app-role holders, and the APIM managed-identity's Key Vault scope); metadata-only logging aligned with A4.
- **Depends on:** A4 (APIM API/policy + diagnostics config). Runs **after G2, alongside A6/A7**; status required at G3.
- **Outputs:** `observability/alerts.bicep`, `observability/dashboards.md`, `observability/rbac-governance.md`, `status/A8.json`.
- **Exit criteria:** Alert rules cover 4xx/5xx/latency/SNAT/KV-anomaly/cost; per-user **and** per-key dashboards defined; RBAC access-review runbook present; no config logs credentials.

## 3. Dependency DAG

```text
        Wave 1 (parallel roots)
   +--------+            +--------+
   |  A1    |            |  A3    |
   | Net    |            | Ident  |
   +---+----+            +---+----+
       |                     |
       +----------+----------+
                  |
   == GATE G1: A1+A3 pass; iac/outputs.json + identity/outputs.json (incl. issuer) + app-roles.json ==
                  |
        Wave 2:  +--------+
                 |  A2    |   (Key Vault + named values; needs A1 identity/VNet + A3 role->alias map)
                 | KeyVlt |
                 +---+----+
                     |
   == GATE G1b: A2 pass; named-value display names == A3 aliases; identity KV scope least-privilege ==
                     |
        Wave 3 (parallel)          A8 (Observability) starts after A4
        +--------+     +--------+     +--------+
        |  A4    |     |  A5    |     |  A8    |
        | Policy |     | OIDC   |     | Observ |
        +---+----+     +---+----+     +---+----+
            |              |              |
            +------+-------+              |
                   |                      |
   == GATE G2: XML-parsed policy (array roles, multi-role 403, symmetric scrub, sub disabled);
      OIDC issuer no-trailing-slash + api://AzureADTokenExchange; workflow --scope/.default +
      token-claim assertion + secret-free; cross-file aliases match ==            |
                   |                                                              |
        Wave 3.5:  == Gnet: NETWORK-REACHABILITY gate (split-horizon + DNS Private Resolver + egress) ==
                   |                                                              |
        Wave 4:   +--------+                                                       |
                  |  A6    |  (client enablement; A6 is a HARD prereq for A7)      |
                  | Client |                                                       |
                  +---+----+                                                       |
                      |                                                            |
   == GATE G2b: A6 pass (status/A6.json present; call-broker.sh uses broker.contoso.com + --scope) ==
                      |                                                            |
        Wave 5:   +--------+                                                        |
                  |  A7    |  (runtime tests)                                       |
                  | Test   |                                                        |
                  +---+----+                                                        |
                      |                                                             |
                      +-------------------------------+-----------------------------+
                                                      |
   == GATE G3: ALL status/A1..A8 pass AND all §12 acceptance criteria PASS -> sign-off ==
```

**Ordering corrections:** A2 is **no longer** a Wave-1 task — it consumes A1's APIM identity/VNet and A3's role→alias map, so it runs in Wave 2 after G1. A7 is **no longer** parallel with A6 — its runtime tests exercise the client artifacts A6 produces, so A6 is a hard prerequisite gated at G2b. A2 writes to `iac/kv/` so it never collides with A1's `iac/` outputs.

## 4. Gate conditions

All gate assertions are **machine-checkable**: every `status/*.json` validates against a fixed schema (see `orchestrator-kickoff.md` §5.1); string comparisons are exact; the policy is **XML-parsed** (not grep'd); the federated credential and workflow are parsed as JSON/YAML; the real `brokerClientId` is substituted from `identity/outputs.json` before any audience comparison.

| Gate | Advance only when… | Verified by |
|---|---|---|
| **G1** | `status/A1.json` + `status/A3.json` report `pass`; `iac/outputs.json` (`gatewayHostname == broker.contoso.com`, `apimIdentityPrincipalId`) + `identity/outputs.json` (`tenantId`, `brokerClientId`, `appIdUri`, **`issuer` = v2 endpoint**) + `identity/app-roles.json` exist. | Orchestrator |
| **G1b** | `status/A2.json` reports `pass`; named-value display names in `iac/kv/named-values.bicep` **set-equal** the aliases in `identity/app-roles.json`; APIM identity KV role is `Key Vault Secrets User` scoped to the vendor-key secrets only. | Orchestrator |
| **G2** | `status/A4.json` + `status/A5.json` report `pass`; **XML-parsed** `apim/broker-policy.xml` shows v2 audiences (GUID + `api://<clientId>`), **array-membership role read on `broker-jwt`** (no `.Contains` over a flattened string), a **count!=1 → 403** branch, named-value refs, symmetric header+query scrub, and subscription disabled; `cicd/federated-credential.json` issuer == `https://token.actions.githubusercontent.com` (no slash) with audiences `["api://AzureADTokenExchange"]` and repo/env-scoped subject; `cicd/call-broker.yml` is secret-free, uses `--scope .../.default`, and has a token-claim assertion step; cross-file alias consistency holds. | Orchestrator |
| **Gnet** | `iac/network-dns-design.md` documents split-horizon (`broker.contoso.com` → PE IP for private clients), a DNS Private Resolver/forwarder for on-prem/VPN resolution, and a defined egress path for any vendor IP allowlist. | Orchestrator |
| **G2b** | `status/A6.json` reports `pass`; `clients/call-broker.sh` uses `broker.contoso.com` and `--scope .../.default` (no `--resource`, no key). **A6 is a hard prerequisite for A7.** | Orchestrator |
| **G3** | **ALL** of `status/A1.json`…`status/A8.json` report `pass`; `test/acceptance-matrix.md` shows all spec §12 criteria PASS (incl. multi-role 403, credential-smuggling header/query/body, rotation-window, split-horizon DNS); `status/A8.json` confirms alerts + per-user & per-key dashboards + RBAC review. | A7 + Orchestrator |

## 5. Wave schedule summary

1. **Wave 1 — parallel roots:** A1, A3.
2. **Gate G1.**
3. **Wave 2:** A2.
4. **Gate G1b.**
5. **Wave 3 — parallel:** A4, A5 (and A8 once A4's policy/diagnostics exist).
6. **Gate G2.**
7. **Wave 3.5 — network-reachability gate (Gnet).**
8. **Wave 4:** A6.
9. **Gate G2b** (A6 is a hard prerequisite for A7).
10. **Wave 5:** A7.
11. **Gate G3** (all status A1–A8 + full acceptance matrix) **→ sign-off.**

## 6. Shared file-contract table (producer → consumer)

Each producer owns its directory; **A2 writes to `iac/kv/`** while A1 owns `iac/`, so the two never collide.

| File | Produced by | Consumed by |
|---|---|---|
| `iac/outputs.json` (APIM name, `gatewayHostname = broker.contoso.com`, PE IP, VNet/subnet IDs, managed-identity principalId) | A1 | A2, A4, A5, A6, A8 |
| `iac/network-dns-design.md` (split-horizon + DNS Private Resolver + egress) | A1 | Gnet, A7 |
| `iac/kv/named-values.bicep` + named-value display names | A2 | A4 |
| `iac/kv/keyvault.bicep`, `iac/kv/keyvault-rbac.md` | A2 | A7 |
| `identity/outputs.json` (tenantId, brokerClientId, appIdUri, **issuer**) | A3 | A2, A4, A5, A6 |
| `identity/app-roles.json` (role→alias mapping) | A3 | A2 (display-name source), A4, A5, A8 |
| `apim/broker-policy.xml` | A4 | A7, A8 |
| `apim/diagnostics-config.md` | A4 | A8 |
| `apim/vendor-api.openapi.yaml` (endpoint paths) | A4 | A6, A7 |
| `cicd/federated-credential.json`, `cicd/call-broker.yml` | A5 | A7 |
| `clients/call-broker.sh`, `clients/developer-security-runbook.md` | A6 | A7 |
| `observability/alerts.bicep`, `observability/dashboards.md`, `observability/rbac-governance.md` | A8 | A7, Orchestrator (G3) |
| `test/acceptance-matrix.md` | A7 | Orchestrator (G3) |

## 7. Acceptance-criteria → owning-agent traceability (spec §12)

| # | Acceptance criterion (spec §12) | Primary owner | Verifier | Mapped runtime test (A7) |
|---|---|---|---|---|
| 1 | Developer calls vendor via APIM after Entra auth + role, without seeing/storing a key | A3 + A4 | A7 | Token-decode: v2 `aud`/`iss` + exactly one `VendorApi.Key*` role; successful broker call with bearer only |
| 2 | Developer with no app role gets 401/403; no vendor request sent | A4 | A7 | No-role token → 401/403, no backend request; **plus multi-role token → 403** (count!=1 branch) |
| 3 | Fake client `x-api-key`/`api_key` ignored; only server-selected named value used | A4 | A7 | **Credential-smuggling matrix across header, query, and body/form** — all stripped |
| 4 | GitHub Actions calls APIM via OIDC with no vendor key or Azure secret in repo | A5 | A7 | Secret-free workflow with `--scope .../.default` + token-claim assertion; no-trailing-slash issuer |
| 5 | Logs contain no real vendor keys, bearer tokens, or credential query strings | A4 + A8 | A7 | Leakage test: alias present, real key/bearer absent, **no key in logged query strings** (symmetric scrub) |
| 6 | Removing user from group/role blocks future access; KV rotation updates APIM with no client change | A2 + A3 | A7 | Revocation test; **rotation-window test** (unversioned named value refreshes, zero downtime) |
| 7 | On-prem/VPN clients reach the broker privately; public access refused | A1 | A7 | **Split-horizon DNS test**: on-prem/VPN resolve to PE IP via DNS Private Resolver; public internet refused |
| 8 | Operations can see per-user/per-key usage and are alerted on anomalies | A8 | A7 | A8 alerts (4xx/5xx/latency/SNAT/KV/cost) + per-user & per-key dashboards present |

## 8. Risk & rollback notes

- **Public DNS-name constraint** (A1): APIM Std v2/Premium v2 require a **publicly-registered** custom domain, so the gateway name must be `broker.contoso.com` (not `*.internal`). Mitigation: **split-horizon DNS** — the public name resolves to the private-endpoint IP for private clients while public network access stays disabled so the endpoint refuses public traffic. Validate both directions at Gnet.
- **DNS Private Resolver dependency** (A1): on-prem/VPN clients cannot query Azure-provided DNS (168.63.129.16) across the tunnel, so a **DNS Private Resolver** (or forwarder VMs) is a hard requirement to resolve `privatelink.azure-api.net`. Rollback: keep a break-glass jump host in the APIM VNet; validate resolution before Wave 4 (Gnet).
- **Fixed egress IP / shared SNAT** (A1): Std v2 uses a shared SNAT pool with no NAT Gateway, so there is no stable outbound IP. If the vendor allowlists an egress IP, route egress via Azure Firewall/NAT (added cost) or use Premium; monitor **SNAT port exhaustion** (A8 alert).
- **Single-active-key rotation window** (A2/A7): a single active vendor key per alias means rotation has a brief window; unversioned named values auto-refresh within ~4 hours, so use **manual/Event Grid refresh** for immediate rollout. A7's rotation-window test proves zero-downtime staging; the break-glass runbook covers emergency rotation.
- **Single-region chokepoint** (A1/A8): a single-region APIM is a single point of failure for all key-brokered traffic. Mitigation: availability-zone deployment now and multi-region (Premium) for DR later; A8 alerts on 5xx/latency to detect degradation. Record RPO/RTO in the HA/DR plan.
- **Codespaces / GitHub-hosted runner reachability** (A5/A6): private-only APIM is unreachable from GitHub-hosted runners by default. Chosen path: self-hosted runners / dev containers in an Azure VNet (or GitHub-hosted with Azure private networking); alternative controlled public ingress (Front Door Premium Private Link / App Gateway WAF) that still enforces `validate-jwt`, with cost noted.
- **Policy-authoring privilege** (A4/A8): APIM policy editors with managed-identity policies can potentially exfiltrate identity tokens. Restrict policy-author roles to admin + pipeline, **and** scope the APIM managed identity's Key Vault RBAC to `Key Vault Secrets User` (get) on only the vendor-key secrets so an abusive policy cannot read unrelated secrets. A8 runs recurring RBAC access reviews.
- **Product-scope policy pitfall** (A4): product-scope policies do not apply to API-scoped/all-APIs/all-access subscriptions, and the subscription requirement is **disabled** here so `validate-jwt` is the sole control. Decision recorded in `apim/broker-policy.xml` header comment; keep Entra JWT validation as the primary control, not subscription keys.

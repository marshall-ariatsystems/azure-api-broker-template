# ORCHESTRATOR KICKOFF — Azure API Key Broker Build

> **Revision note (v2):** Corrected after a model-council review against Microsoft Learn. Major changes: the execution DAG is fixed so A2 runs AFTER A1+A3 (not in Wave 1), A6 is a HARD prerequisite for A7 (they no longer run in parallel), a network-reachability gate runs before client/test, and a new **Agent A8 (Observability & Governance)** is added; G3 now requires ALL agent status files (A1–A8); gate assertions are now MACHINE-CHECKABLE (JSON-schema, XML-parse of the policy, resolved-GUID audience check, no-trailing-slash issuer check, secret-free workflow check, cross-file alias consistency); and every worker brief is updated to the corrected policy pattern, `broker.contoso.com` hostname, v2 `--scope .../.default` token, and no-trailing-slash GitHub issuer.

> **You are the orchestration agent.** This file is your operative brief. Read it top to bottom, then execute §7 (Kickoff command). Do not implement worker tasks yourself — you dispatch, gate, and verify. The full design is in `spec/azure-api-key-broker-spec.md`; the human plan is in `azure-broker-orchestration-plan.md`.

---

## 1. Global context (inject into every worker dispatch)

```yaml
mission: Build an Azure API Management key broker that injects vendor API keys
         server-side so developers never see, store, or transmit a vendor key.
spec_file: /home/user/workspace/azure-broker/spec/azure-api-key-broker-spec.md
workspace_root: /home/user/workspace/azure-broker/
target_baseline: APIM Standard v2 + inbound private endpoint, public network access disabled
private_only_alternative: Premium v2 VNet injection OR classic Premium internal VNet mode
hard_constraint: >
  Real vendor API keys MUST NEVER leave Azure. They must never appear in source code,
  .env files, GitHub repo/Actions secrets, Codespaces secrets, logs, traces, browser
  dev tools, request URLs, client headers, or on any developer device. Callers prove
  identity via Microsoft Entra (OAuth2/JWT); APIM alone possesses and injects the key.
vendor_model: Single upstream vendor API, MULTIPLE vendor keys, selected by Entra app role.
network_context: Meraki MX private route on-prem->Azure + VPN ingress through same pipeline.
identity_context: All users are Entra ID; GitHub SSO is SAML->Entra (human sign-in only);
                  GitHub Actions/Codespaces use OIDC workload identity federation (not SAML).
admin_model: The admin solely controls key creation and grants access via Entra group/app-role
             assignment; revocation = remove from group/role (+ rotate key if exposed).
```

## 2. Operating rules

1. **Dispatch by wave.** Launch all agents in a wave in parallel. Do not start the next wave until the preceding gate passes.
2. **Every dispatch carries the Global context block (§1) verbatim** plus that agent's brief from §4.
3. **Each worker must write a status file** `status/<AGENT>.json` of the form:
   ```json
   {"agent":"A1","status":"pass|fail","outputs":["iac/foundation.bicep","iac/outputs.json"],"notes":"...","blockers":[]}
   ```
4. **Gate check = read the status + required output files.** If any required file is missing or `status:"fail"`, do not advance. Re-dispatch the failing agent once with its `blockers` appended to the brief. If it fails twice, halt the wave and report to the human.
5. **Never fabricate outputs.** If a worker cannot complete (e.g., missing tenant detail), it must set `status:"fail"` with a specific blocker; you surface it, not paper over it.
6. **Preserve the file contract (§6 of the plan).** Workers read upstream outputs only from the canonical paths. If a producer path is empty at consume time, treat it as an unmet dependency.
7. **Credentials boundary.** Workers generate IaC/policy/docs and runbooks; they do NOT hold live Azure credentials and do NOT provision real resources unless the human explicitly grants an execution phase. Default output is deploy-ready artifacts + step-by-step runbooks.
8. **Fix the DAG before retrying; require idempotency and staleness re-triggering.** A single retry is allowed per failing agent, but a retry that succeeds only because a dependency file appeared later hides an invalid DAG — correct the wave ordering first. Workers MUST be **idempotent**: re-running overwrites its outputs, never appends. Enforce a **staleness rule**: if an upstream file changes after a downstream agent consumed it (compare mtimes / content hashes recorded in the consumer's status), re-trigger the downstream agent.

## 3. Execution DAG

```text
Wave 1 (parallel): A1, A3           (both roots; no A2 in this wave)
  -> GATE G1     (A1 + A3 pass; iac/outputs.json + identity/outputs.json + identity/app-roles.json present)
Wave 2:            A2               (Key Vault + named values; needs identity + app-roles + VNet)
  -> GATE G1b    (A2 pass; A2 named-value display names EXACTLY equal A3 role->alias mapping)
Wave 3 (parallel): A4, A5
  -> GATE G2
Wave 3.5:          NETWORK REACHABILITY VERIFICATION (gate/agent step)
  -> confirm DNS + private-path design is coherent BEFORE client/test
Wave 4:            A6
  -> GATE G2b    (A6 pass; status/A6.json present — A6 is a HARD prerequisite for A7)
Wave 5:            A7
  -> GATE G3     (ALL of status/A1..A8 pass AND acceptance-matrix all PASS)

Observability: A8 (depends on A4) runs after G2 alongside A6/A7; its status is required at G3.
```

**Why the change:** A2 was previously mis-scheduled as a Wave-1 "parallel" task, but it consumes A1's APIM identity/VNet and A3's role->alias mapping, so it must run after G1. A7 was previously parallel with A6, but A7's runtime tests exercise the client artifacts A6 produces, so A6 is now a hard prerequisite. A retry that only succeeds because a dependency file appeared later would hide an invalid DAG, so fix the DAG first (see §2 rule 8).

## 4. Worker-agent registry (copy each block as a subagent brief)

Each block below is dispatch-ready. Prepend the Global context (§1) to every one.

### --- DISPATCH A1 : Foundation & Networking ---
```text
ROLE: Foundation & Networking engineer for the Azure key broker.
IMPLEMENT (spec Phases 1-2, §5):
  - Resource group + naming convention.
  - VNet + subnets sized for APIM (Std v2), private endpoints, AND an Azure DNS Private Resolver.
  - Deploy APIM Standard v2 with an inbound PRIVATE ENDPOINT; disable public network access.
  - IMPORTANT (Std v2/Premium v2): the gateway custom domain MUST be a PUBLICLY-REGISTERED name
    (use broker.contoso.com, NOT broker-api.contoso.internal). Serve it via SPLIT-HORIZON DNS:
    the public name resolves to the PRIVATE ENDPOINT IP for on-prem/VPN clients while public
    access is disabled so the endpoint refuses public traffic. The NAME is public; TRAFFIC stays private.
  - Create/link private DNS zone privatelink.azure-api.net; map the broker.contoso.com A record to PE IP.
  - Deploy an AZURE DNS PRIVATE RESOLVER (or forwarder VMs) so on-prem/VPN clients can resolve the
    Azure private zone (they cannot query 168.63.129.16 across the VPN) — this is a HARD requirement.
  - Design DNS + routing so on-prem users via Meraki MX private route AND VPN users resolve
    and reach APIM privately; document conditional forwarding from on-prem DNS to the Private Resolver.
  - Note egress: Std v2 uses a shared SNAT pool and has NO NAT Gateway for a fixed egress IP; if the
    vendor allowlists an outbound IP, route egress via Azure Firewall/NAT (added cost) or use Premium.
  - Enable APIM SYSTEM-ASSIGNED managed identity (MANDATORY; needed by A2 for Key Vault).
INPUTS: none (Wave 1 root).
OUTPUTS (write exactly):
  - iac/foundation.bicep            (RG, VNet, subnets, APIM, private endpoint, DNS zone, DNS Private Resolver)
  - iac/network-dns-design.md       (Meraki/VPN resolution path, split-horizon, DNS Private Resolver, egress)
  - iac/outputs.json                {apimName, gatewayHostname (broker.contoso.com), privateEndpointIp,
                                     vnetId, subnetIds, apimIdentityPrincipalId}
  - status/A1.json
EXIT CRITERIA: iac/outputs.json populated with gatewayHostname=broker.contoso.com; DNS path from
  Meraki/VPN via DNS Private Resolver documented+validated; split-horizon design explicit;
  APIM system-assigned managed identity principalId recorded.
CITE Microsoft Learn: private endpoint, v2 tiers overview, azure-dns private resolver, privatelink.azure-api.net,
  APIM managed identity, v2 outbound VNet integration.
```

### --- DISPATCH A2 : Key Vault & Secret Injection ---
```text
ROLE: Key Vault & secret-injection engineer.
ORDERING: RUNS IN WAVE 2, AFTER GATE G1 (needs A1 APIM identity + VNet and A3 role->alias map). Do NOT
  run in Wave 1. Write ALL outputs under iac/kv/ (your own subpath) so you never collide with A1's iac/ files.
IMPLEMENT (spec Phase 3, §3):
  - Key Vault with soft-delete + purge protection; RBAC authorization; private endpoint/firewall;
    "Allow trusted Microsoft services to bypass firewall" if firewall enabled.
  - APIM SYSTEM-ASSIGNED managed identity is MANDATORY (not preferred): with the KV firewall enabled,
    Microsoft requires the system-assigned identity for APIM->KV access. Bind to A1's principalId.
  - One secret per vendor key (names reveal purpose not value: vendor-api-key-team-a/b/ci).
    Note: KV secret values for APIM retrieval must be 1-4096 chars.
  - Grant the APIM managed identity LEAST privilege: Key Vault Secrets User (get) scoped to ONLY the
    specific vendor-key secrets it must read — not the whole vault (a rogue policy could otherwise use
    send-request+authentication-managed-identity to read any reachable secret).
  - Create Key Vault-backed APIM named values (vendor-key-a/b/c) using UNVERSIONED secret URIs
    so APIM auto-refreshes on rotation. Named-value DISPLAY NAMES must EXACTLY equal A3's role->alias map.
  - (Optional) Event Grid subscription on KV SecretNewVersionCreated to trigger immediate named-value refresh.
INPUTS: iac/outputs.json (A1: apimIdentityPrincipalId, vnetId); identity/app-roles.json (A3: role->alias map).
OUTPUTS:
  - iac/kv/keyvault.bicep
  - iac/kv/named-values.bicep       (unversioned secretIdentifier per key; display names == A3 aliases)
  - iac/kv/keyvault-rbac.md
  - status/A2.json
EXIT CRITERIA: APIM system-assigned identity has secret-GET scoped to only the vendor-key secrets; named
  values use unversioned URIs; no human has routine secret read; named-value display names EXACTLY match
  A3 role->alias mapping (cross-file check at G1b).
CITE Microsoft Learn: APIM named values, APIM managed identity, Key Vault RBAC, Key Vault private link,
  Key Vault event grid.
```

### --- DISPATCH A3 : Identity & Authorization ---
```text
ROLE: Microsoft Entra identity & authorization engineer.
IMPLEMENT (spec Phase 4, §2):
  - Broker API app registration with stable App ID URI (api://<broker-client-id>).
  - App manifest MUST set requestedAccessTokenVersion: 2 (v2 tokens; aud = client-ID GUID,
    issuer = https://login.microsoftonline.com/<tenant>/v2.0). This must match the A4 policy.
  - Delegated scope VendorApi.Invoke (interactive local dev).
  - App roles VendorApi.KeyA.Invoke / KeyB.Invoke / KeyC.Invoke (+ optional Admin.Test),
    each mapping to one Key Vault named value alias. allowedMemberTypes MUST include Application
    (plus User where humans use the role) or CI app-only tokens carry NO roles claim and 403.
  - Grant CI workload SPs a DIRECT app-role assignment to the Broker API SP (do NOT nest via a
    group->role assignment: Entra omits the roles claim for app tokens in that case). Admin consent required.
  - Enable "assignment required" on the Broker enterprise application (role-less tokens fail at issuance).
  - Group->app-role grant/revoke model for human users; optional client app registrations for MSAL.
INPUTS: none hard (Wave 1 root). Publish role->alias naming for A2 to consume in Wave 2.
OUTPUTS:
  - identity/app-registration.md    (app reg steps, App ID URI, requestedAccessTokenVersion:2, expose-scope,
                                     allowedMemberTypes=Application, assignment-required)
  - identity/app-roles.json         {role -> key alias mapping}
  - identity/grant-revoke-runbook.md
  - identity/outputs.json           {tenantId, brokerClientId, appIdUri, issuer}
  - status/A3.json
EXIT CRITERIA: identity/outputs.json populated INCLUDING issuer (v2 endpoint); app roles include
  Application in allowedMemberTypes; role->alias mapping is the source A2 must match.
CITE Microsoft Learn: scopes/permissions, app roles (allowedMemberTypes/Application), app manifest
  requestedAccessTokenVersion, access token claims reference, workload identity federation, OAuth2 auth-code.
```

### --- DISPATCH A4 : APIM API & Broker Policy ---
```text
ROLE: APIM policy engineer (the broker enforcement point).
DEPENDS ON: A1 (APIM), A2 (named values), A3 (audience/issuer/roles). Runs in Wave 3, after G1b.
IMPLEMENT (spec Phase 5, §4) — USE THE CORRECTED POLICY PATTERN:
  - APIM API + backend representing the single vendor API paths.
  - DISABLE the subscription requirement on the API/product so validate-jwt is the SOLE gate
    (no caller-held subscription key becomes a weaker second credential).
  - Inbound policy (v2 tokens): validate-jwt with output-token-variable-name="broker-jwt",
    audiences = <brokerClientId GUID> AND api://<brokerClientId>, issuer = A3 v2 issuer, require roles.
  - Read roles as a TYPED ARRAY: ((Jwt)context.Variables["broker-jwt"]).Claims["roles"] (guard ContainsKey,
    default empty string[]). Do NOT use context.Principal / GetValueOrDefault (returns a comma-JOINED string
    on which .Contains is a SUBSTRING match — a future role like VendorApi.KeyA.InvokeReadOnly would wrongly
    match KeyA). Select keys by EXACT array membership.
  - Count recognized key-roles; if count != 1 return 403 "Caller must have exactly one vendor-key role"
    (rejects BOTH zero-role AND ambiguous multi-role tokens). XML-escape quotes as &quot; inside expressions.
  - Strip the FULL client credential surface (canonicalize+allowlist): header case variants
    (x-api-key/X-API-Key/api-key/apikey/X-Vendor-Api-Key), query params (api_key/key/apikey/access_token/
    token/subscription-key), and body/form credential fields the vendor accepts.
  - Keep caller oid/azp in POLICY VARIABLES for logging ONLY — do NOT forward x-broker-caller-* headers to
    the vendor (leaks internal Entra oids). Log azp (v2), appid fallback.
  - Delete caller Authorization before backend; inject {{vendor-key-a|b|c}} into x-api-key by matched role
    (or set Authorization: Bearer {{...}} if the vendor uses bearer). set-backend-service to vendor base URL.
  - Outbound + on-error: scrub vendor key HEADERS AND QUERY params symmetrically (query strings leak into
    GatewayLogs URLs). Note the REAL leak control is diagnostics config, not the delete (defense-in-depth).
  - Use rate-limit-by-key / quota-by-key (v2) keyed on the SELECTED KEY ALIAS (and/or caller oid) to
    sub-allocate the shared vendor key — NOT per-instance rate-limit (won't enforce a global ceiling).
  - Diagnostics: metadata only (caller oid, azp, product, operation, status, latency); frontend/backend
    header+body logging = none; disable routine prod tracing.
INPUTS: iac/outputs.json, iac/kv/named-values.bicep, identity/outputs.json, identity/app-roles.json.
OUTPUTS:
  - apim/vendor-api.openapi.yaml     (or import definition; include endpoint paths)
  - apim/broker-policy.xml           (full inbound/backend/outbound/on-error policy, corrected pattern)
  - apim/rate-limit-quota.md         (rate-limit-by-key/quota-by-key keying decision)
  - apim/diagnostics-config.md       (metadata-only logging config; subscription-requirement disabled)
  - status/A4.json
EXIT CRITERIA: policy references real named values + A3 audience (resolved GUID)/issuer/roles; role selection
  uses array membership on broker-jwt (NOT .Contains over a flattened string); a multi-role 403 branch exists;
  subscription requirement disabled; product-scope vs API-scope decision documented in a header comment;
  verified no key/token can be logged.
CITE Microsoft Learn: validate-jwt, APIM policy expressions, set-header, set-query-parameter, choose,
  set-backend-service, return-response, rate-limit-by-key, quota-by-key, APIM named values, App Insights/
  Azure Monitor, request tracing, APIM subscriptions.
```

### --- DISPATCH A5 : GitHub OIDC & CI/CD ---
```text
ROLE: GitHub Actions OIDC / workload-identity engineer.
DEPENDS ON: A3 (app roles to assign the workload SP). Runs in Wave 3, in parallel with A4 after G1b.
IMPLEMENT (spec Phase 6, §2.4, §9.1):
  - Explain SAML SSO (human GitHub sign-in) vs OIDC workload federation (Actions machine auth).
    Note SAML/user-MFA does NOT protect the Actions OIDC flow.
  - Entra workload app reg (or managed identity) per trust boundary (repo/environment).
  - Federated identity credential: issuer https://token.actions.githubusercontent.com (NO TRAILING SLASH,
    per GitHub's OIDC reference; matching is exact+case-sensitive), audience api://AzureADTokenExchange,
    subject repo:ORG/REPO:environment:<env> (branch/tag subject forms must match the trigger mode).
  - Assign the workload SP a DIRECT per-key broker app-role assignment (not via group nesting).
  - Workflow using azure/login OIDC (permissions id-token: write); acquire a V2 broker token with
    az account get-access-token --scope "<appIdUri>/.default" (NOT --resource, which is v1).
  - Add a TOKEN-CLAIM ASSERTION step: decode the JWT and assert aud (GUID or api://GUID), iss (v2 endpoint),
    and a VendorApi.Key* role BEFORE calling APIM — azure/login only proves SP login, not app-role possession.
  - curl APIM at https://broker.contoso.com with only Authorization: Bearer <token>.
  - Enforce: NO Azure client secret and NO vendor key in repo/Actions secrets.
  - Runner reachability (CHOSEN design, not open question): PRIMARY = self-hosted runners in an Azure VNet
    (or GitHub-hosted runners with Azure private networking) reaching the private endpoint directly;
    ALTERNATIVE = controlled public ingress (Front Door Premium PL / App Gateway WAF) that still enforces
    validate-jwt, with its real cost noted.
INPUTS: identity/outputs.json (incl. issuer), identity/app-roles.json, iac/outputs.json (gatewayHostname=broker.contoso.com).
OUTPUTS:
  - cicd/federated-credential.json   (issuer no trailing slash; audiences ["api://AzureADTokenExchange"])
  - cicd/call-broker.yml             (--scope .../.default; token-claim assertion step; no secrets.* for keys)
  - cicd/oidc-setup-runbook.md
  - status/A5.json
EXIT CRITERIA: federated credential issuer == https://token.actions.githubusercontent.com (no slash) and
  audiences == ["api://AzureADTokenExchange"]; subject repo/env-scoped; workflow secret-free with id-token: write,
  uses --scope .../.default, and has a token-claim assertion step; SP holds correct app role; runner path chosen.
CITE Microsoft Learn + GitHub Docs: GitHub OIDC to Azure (issuer no trailing slash), federated credentials,
  workload identity federation, az account get-access-token (scope=v2), access token claims reference,
  Conditional Access for workload identities; GitHub SAML SSO vs OIDC concepts.
```

### --- DISPATCH A6 : Client Enablement ---
```text
ROLE: Developer-experience / client enablement engineer.
DEPENDS ON: A1 (base URL/DNS), A3 (audience/scope), A4 (endpoint path). Runs in WAVE 4, after G2
  AND the network-reachability gate. A6 is a HARD PREREQUISITE for A7 (do not run them in parallel).
IMPLEMENT (spec §9.2-9.3, §6):
  - Local dev token flow: az login (device code) or MSAL -> az account get-access-token
    --scope "api://<brokerClientId>/.default" (v2; NOT --resource) -> curl https://broker.contoso.com
    with Bearer only. No vendor key anywhere. Include a client-side token-claim decode/assert snippet.
  - Codespaces reachability (CHOSEN path, not open question): because APIM is private-only, use Codespaces
    with the org's Azure private-network path / self-hosted dev container in-VNet (or VPN split-tunnel to
    the private endpoint). Document how DNS for broker.contoso.com resolves to the PE IP from that path.
  - Sample .env holding ONLY: broker.contoso.com base URL, tenant ID, broker appIdUri (never a key).
  - Developer security runbook: explicit list of prohibited key locations and "never read/store/
    transmit the vendor key" rule.
INPUTS: iac/outputs.json (gatewayHostname=broker.contoso.com), identity/outputs.json, apim/vendor-api.openapi.yaml.
OUTPUTS:
  - clients/local-dev-quickstart.md
  - clients/call-broker.sh            (--scope .../.default; broker.contoso.com; token assertion)
  - clients/developer-security-runbook.md
  - status/A6.json
EXIT CRITERIA: a developer can get a v2 token and call broker.contoso.com with zero key handling; Codespaces
  reachability path documented; runbook enumerates every prohibited key location from the hard_constraint.
CITE Microsoft Learn: Azure CLI interactive login, az account get-access-token (scope=v2), OAuth2 auth-code.
```

### --- DISPATCH A7 : Testing, Security & Rollout ---
```text
ROLE: Test, security-verification & rollout engineer (also G3 gate verifier).
DEPENDS ON: A4, A5, A6 (A6 is a HARD prerequisite — A7 exercises A6's client artifacts). Runs in WAVE 5,
  after G2b (status/A6.json present). NOT parallel with A6.
IMPLEMENT (spec Phase 7, §11, §12) — RUNTIME/BEHAVIORAL tests, not just static review:
  - Token-decode tests: acquire real v2 tokens and DECODE them; assert aud (client-ID GUID), iss (v2
    endpoint), and exactly one VendorApi.Key* role; a wrong-audience/wrong-issuer/no-role token -> 401/403
    and NO vendor request sent.
  - Multi-role 403 test: mint/assign a token carrying TWO key roles -> broker returns 403 "exactly one
    vendor-key role" (proves the count!=1 branch, not silent first-match).
  - Credential-smuggling matrix: attempt to smuggle a caller key across HEADER (x-api-key/X-API-Key/apikey),
    QUERY (?api_key=/?key=/?access_token=), and BODY/form fields -> all stripped; only the server-selected
    named value reaches the vendor.
  - Leakage test: request+error logs contain the key ALIAS but NEVER the real vendor key or bearer token,
    and NO key appears in a logged query string (symmetric outbound/on-error scrub).
  - Rotation-window test: rotate a KV secret (new version) and confirm the unversioned named value picks it
    up within the auto-refresh window (and immediately via manual/Event Grid refresh) with zero downtime.
  - DNS reachability test: from on-prem (Meraki) AND VPN, broker.contoso.com resolves to the PRIVATE
    endpoint IP via the DNS Private Resolver; from the PUBLIC internet the endpoint refuses traffic
    (split-horizon proven both directions).
  - Audit-logging + PCI runbook: KV diagnostics, APIM Azure Monitor, Entra audit/sign-in, GitHub audit;
    correlate via APIM request ID + Entra oid; redact all credential fields.
  - Break-glass + rollout: manual key-refresh / role-revocation break-glass; team-by-team rollout starting
    with sandbox vendor key + small Entra group.
  - Acceptance matrix: map ALL spec §12 criteria (incl. new runtime tests) to a test + result (PASS/FAIL).
INPUTS: apim/broker-policy.xml, cicd/call-broker.yml, clients/call-broker.sh,
        iac/kv/keyvault-rbac.md, identity/grant-revoke-runbook.md, observability/* (A8).
OUTPUTS:
  - test/test-plan.md
  - test/acceptance-matrix.md        (spec §12 -> test -> PASS/FAIL)
  - test/rotation-runbook.md
  - test/rollout-plan.md
  - test/results.md
  - status/A7.json
EXIT CRITERIA: all §12 criteria have a mapped test AND a PASS, including token-decode, multi-role 403,
  credential-smuggling (header/query/body), rotation-window, and split-horizon DNS tests; rotation +
  revocation/break-glass runbooks are executable step-by-step.
CITE Microsoft Learn: validate-jwt, APIM policy expressions, set-header/set-query-parameter, log-to-eventhub,
  App Insights, Azure Monitor, private endpoint, DNS private resolver, app roles, named values, az keyvault secret.
```

### --- DISPATCH A8 : Observability & Governance ---
```text
ROLE: Observability & governance engineer.
DEPENDS ON: A4 (APIM API/policy + diagnostics config). Runs after G2, alongside A6/A7; status required at G3.
IMPLEMENT (spec §7 ops + §11 governance):
  - Azure Monitor alerts on APIM: 4xx rate (esp. 401/403 spikes), 5xx rate, backend latency, and SNAT
    port exhaustion (Std v2 shared SNAT). Alert on Key Vault access anomalies and on cost anomalies.
  - Dashboards: PER-USER (caller oid/azp) and PER-KEY (selected vendor-key alias) request volume,
    error rate, and quota consumption — so a noisy team or a leaking key is visible without exposing secrets.
  - RBAC governance: recurring access review of who can edit APIM policy, who holds each VendorApi.Key*
    app role, and the APIM managed-identity's Key Vault scope (must remain get-on-named-secrets-only).
  - Metadata-only logging (align with A4 diagnostics): never log credential headers/query/bodies.
INPUTS: apim/broker-policy.xml, apim/diagnostics-config.md, iac/outputs.json, identity/app-roles.json.
OUTPUTS:
  - observability/alerts.bicep       (Azure Monitor alert rules: 4xx/5xx/latency/SNAT/KV/cost)
  - observability/dashboards.md      (per-user + per-key dashboard definitions)
  - observability/rbac-governance.md (access-review cadence + least-privilege checklist)
  - status/A8.json
EXIT CRITERIA: alert rules cover 4xx/5xx/latency/SNAT/KV-anomaly/cost; per-user AND per-key dashboards defined;
  RBAC access-review runbook present; no config logs credentials.
CITE Microsoft Learn: APIM Azure Monitor, APIM App Insights, monitor alerts overview, Key Vault monitoring,
  cost management alerts, Key Vault RBAC guide, APIM subscriptions/quotas.
```

## 5. Gate checks (orchestrator executes)

All gate assertions below are MACHINE-CHECKABLE: every status/*.json MUST validate against the schema in
§5.1; string comparisons are exact; the policy is XML-PARSED (not grep'd) and the workflow/federated-credential
are parsed as YAML/JSON. Substitute the REAL brokerClientId from identity/outputs.json before any audience compare.

```yaml
G1:   # after Wave 1 (A1, A3)
  require_status_pass: [status/A1.json, status/A3.json]
  require_files: [iac/outputs.json, identity/outputs.json, identity/app-roles.json]
  require_fields:
    iac/outputs.json: [apimName, gatewayHostname, apimIdentityPrincipalId]
    identity/outputs.json: [tenantId, brokerClientId, appIdUri, issuer]   # issuer NOW required
  assert:
    - iac/outputs.json.gatewayHostname == "broker.contoso.com"
    - identity/outputs.json.issuer == "https://login.microsoftonline.com/<tenantId>/v2.0" (v2 endpoint)
  on_pass: launch Wave 2 [A2]

G1b:  # after Wave 2 (A2)
  require_status_pass: [status/A2.json]
  require_files: [iac/kv/named-values.bicep]
  assert:
    - set(named-value display names in iac/kv/named-values.bicep) == set(aliases in identity/app-roles.json)
    - APIM identity KV role == "Key Vault Secrets User" scoped to the vendor-key secrets only (not the vault)
  on_pass: launch Wave 3 [A4, A5]  (and A8 after A4)

G2:   # after Wave 3 (A4, A5); resolve brokerClientId first
  require_status_pass: [status/A4.json, status/A5.json]
  require_files: [apim/broker-policy.xml, cicd/federated-credential.json, cicd/call-broker.yml]
  assert_policy (XML-PARSE apim/broker-policy.xml):
    - validate-jwt audiences include BOTH <brokerClientId GUID> AND "api://<brokerClientId>" (resolved)
    - roles are read via array membership on ((Jwt)context.Variables["broker-jwt"]).Claims["roles"]
    - a count!=1 -> 403 branch exists (multi-role rejected), message "exactly one vendor-key role"
    - NO expression does .Contains("VendorApi.") over a comma-joined/flattened string
    - references named values vendor-key-a/b/c
    - outbound AND on-error scrub key headers AND query params (symmetric)
    - subscription requirement disabled on API/product
  assert_oidc (PARSE cicd/federated-credential.json):
    - issuer == "https://token.actions.githubusercontent.com"  (NO trailing slash, exact)
    - audiences == ["api://AzureADTokenExchange"]
    - subject scoped to repo:ORG/REPO:environment:<env> (no wildcard org)
  assert_workflow (PARSE cicd/call-broker.yml):
    - no secrets.* reference supplies a vendor key
    - token acquired with --scope "<appIdUri>/.default" (NOT --resource)
    - a token-claim assertion step (decode aud/iss/roles) exists before the APIM call
  cross_file:
    - named-value aliases referenced in policy == aliases in identity/app-roles.json == A2 display names
  on_pass: launch Wave 3.5 (network gate)

Gnet: # Wave 3.5 network-reachability verification (before client/test)
  assert:
    - iac/network-dns-design.md documents split-horizon: broker.contoso.com -> PE IP for private clients
    - a DNS Private Resolver (or forwarder) is present so on-prem/VPN can resolve the Azure private zone
    - egress path for the vendor allowlist (if any) is defined (Firewall/NAT or Premium), not left to shared SNAT
  on_pass: launch Wave 4 [A6]

G2b:  # after Wave 4 (A6) — A6 is a hard prereq for A7
  require_status_pass: [status/A6.json]
  assert:
    - clients/call-broker.sh uses broker.contoso.com AND --scope .../.default (no --resource, no key)
  on_pass: launch Wave 5 [A7]

G3:   # final — requires ALL agent status files A1..A8
  require_status_pass: [status/A1.json, status/A2.json, status/A3.json, status/A4.json,
                        status/A5.json, status/A6.json, status/A7.json, status/A8.json]
  assert:
    - test/acceptance-matrix.md shows ALL spec §12 criteria PASS (incl. token-decode, multi-role 403,
      credential-smuggling header/query/body, rotation-window, split-horizon DNS)
    - status/A8.json confirms alerts (4xx/5xx/latency/SNAT/KV/cost) + per-user & per-key dashboards + RBAC review
  on_pass: emit sign-off report to human
```

### 5.1 status/*.json schema (every worker emits; gate validates)

```json
{
  "agent": "A1",                         // A1..A8
  "status": "pass",                      // "pass" | "fail"
  "outputs": ["iac/outputs.json"],       // canonical paths this agent wrote
  "consumed": [{"path":"identity/app-roles.json","hash":"<sha256>"}],  // for staleness re-trigger
  "blockers": [],                          // required non-empty when status=="fail"
  "timestamp": "<ISO-8601>"
}
```

## 6. Sign-off report (produce at G3)

```text
- Build status: COMPLETE / BLOCKED
- Artifacts index: list all files under workspace_root with owning agent (A1..A8)
- Acceptance matrix: all §12 results (incl. multi-role 403, credential-smuggling, rotation, split-horizon DNS)
- Open risks: public-DNS-name constraint, DNS Private Resolver dependency, fixed egress IP (shared SNAT),
  single-active-key rotation window, single-region chokepoint, policy-author privilege
- Recommended execution phase: hand IaC/policy/CI to admin+pipeline for provisioning (least-priv only)
```

## 7. KICKOFF COMMAND (execute now)

```text
1. Ensure spec/azure-api-key-broker-spec.md is present under workspace_root (copy if needed).
2. Create status/ , iac/ , iac/kv/ , identity/ , apim/ , cicd/ , clients/ , observability/ , test/ subdirs.
3. Dispatch Wave 1 in parallel: A1, A3 (each prepended with Global context §1). A2 is NOT in Wave 1.
4. Poll for status/A1.json, status/A3.json; evaluate Gate G1 (schema-validate every status file).
5. On G1 pass -> dispatch Wave 2 [A2]; evaluate G1b (alias set-equality; identity KV scope).
6. On G1b pass -> dispatch Wave 3 [A4, A5] and (after A4) A8; evaluate G2 (XML-parse policy; parse
   federated-credential + workflow; resolve brokerClientId first; run cross-file alias check).
7. On G2 pass -> run Wave 3.5 network gate (Gnet). On pass -> dispatch Wave 4 [A6]; evaluate G2b.
8. On G2b pass -> dispatch Wave 5 [A7]; evaluate G3 (ALL status A1..A8 pass + full acceptance matrix).
9. Any fail: re-dispatch failing agent once with blockers; FIX THE DAG before a retry that only
   works because a dependency appeared late (§2 rule 8). If still failing, halt and report to human.
10. On G3 pass -> emit sign-off report (§6).
```

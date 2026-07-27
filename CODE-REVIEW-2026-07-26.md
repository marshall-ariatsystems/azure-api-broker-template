# Full Code Review — tessera-api-broker

- **Date:** 2026-07-26 (tree state as of ~23:50Z)
- **Type:** Full-repository review — logical inconsistencies, uncalled/dead functions, reused/duplicated functions
- **Method:** Four independent read-only reviewers (function-node, clients/bridge, infra/tooling/IaC, cross-cutting export/call-graph and contract sweep), findings deduplicated and every cross-reviewer contradiction re-verified directly against source. **No edits were made to any reviewed file.**
- **Scope:** `function-node/`, `clients/`, `admin-ui/`, `tools/`, `providers/`, `iac/`, `.github/`, `registration-packages/`, `broker-adapters/`, `broker-protocol/`, `broker-agent/`. `_archive/` and `_directives/` treated as evidence, not code.
- **Moving-target caveat:** the autonomous directive executor was building during the review window — ED-V005-002 BUILT-GREEN 23:23Z, ED-V009-001 BUILT-GREEN 23:34Z, ED-V005-001 repaired to BUILT-GREEN 23:46Z. Findings reflect the tree after those builds.

**Verdict: BLOCK-level.** Totals after deduplication: **2 CRITICAL / 13 HIGH / 12 MEDIUM / 10 LOW.**

---

## 1. Critical

### C1 — CJS bundle entry guard always fires; the artifact auto-executes on load
`clients/bridge/dist/broker-bridge.cjs:396,615`. esbuild rewrites `import.meta` to an empty object, so the guard `if (!import_meta2.url || invokedHref === import_meta2.url) main()` is unconditionally true — `require()`ing the bundle runs `main()` and parses argv immediately. The ESM source guard (`clients/bridge/broker-bridge.mjs:130`) is correct; the defect is exclusive to the built artifact that the SEA binary wraps. This is the same seam ED-V007-002's authoring probes flagged (there it manifested as a silent no-op); either way the bundle's entry behavior does not match source intent. Fix direction: `require.main === module` semantics in CJS output, or an esbuild `--define` for `import.meta.url`.

### C2 — Production infrastructure hardcoded as defaults
`clients/broker_client.py:46-50`. The real Function App FQDN (`func-broker-cxapi-….azurewebsites.net`), the private VNet IP (`10.0.0.10`), and the Entra app GUID scope (`api://ce485d55-…/.default`) ship as fallback literals. Not secrets, but together they are reconnaissance material and leak internal topology. All three should be required env vars with no defaults. Related MEDIUM: the module monkeypatches `socket.getaddrinfo` process-wide at import time — irreversible for any co-resident library.

---

## 2. High — logical inconsistencies

### H1 — Empty-groups tokens get 403 even when explicitly granted
`function-node/src/broker.js:225,232` → `function-node/src/connection-grants.js:26`. Both OIDC branches spread `groups: []` into the grant-identity call because the key exists; `grantList` throws on empty arrays; the catch at `broker.js:316-321` silently converts that throw into `{allowed: false}`. A user listed in `subjects` whose token carries no group claims is denied. No test covers this path.

### H2 — ES256 is advertised but can never verify
`function-node/src/oidc-identity-adapter.js:26,32`. The header check accepts ES256, but `crypto.verify('sha256', …)` is handed the JWT's raw `r‖s` compact signature while Node expects DER for EC keys — verification always returns false. Fail-closed, but any EC-key IdP under `AUTH_MODE=oidc` fails opaquely with no diagnostic path.

### H3 — `generic-oidc` assurance cannot express the only realistic FIDO2 claim
`function-node/src/generic-oidc-authority.js:6` uses strict equality (`claims[claim] !== equals`), so `amr` (always an array, e.g. `['hwk','user']`) can never match — hardware-key assurance either locks everyone out or is silently unenforceable. The `oidc` adapter handles the array case correctly (`oidc-identity-adapter.js:35-36`); the two modes disagree. This is exactly the seam ED-V009-001 built `assurance-policy.js` to replace — but that module is not wired (see §4).

### H4 — Grant parse errors are indistinguishable from denials
`function-node/src/broker.js:308-324` — an empty catch maps malformed `CONNECTION_GRANTS_JSON` to the same 403/`grant=denied` as an intentional denial, with zero log signal. Operators cannot distinguish "grants document unparseable" from "caller intentionally denied."

### H5 — Three divergent OIDC validators
Bridge `clients/bridge/oidc-validation.mjs` checks `iat` future-skew (60 s, line 30) and requires HTTPS `authorization_endpoint`/`token_endpoint` in discovery (lines 23-24); server `function-node/src/generic-oidc-validation.js:8-9` checks neither (only `jwks_uri`), so it would accept a discovery doc with an HTTP `token_endpoint`; `oidc-identity-adapter.js:9-13` alone has a JWKS cache (the generic path re-fetches JWKS per request — a real perf/availability cost) and alone accepts ES256 (see H2). Same logical contract, three behaviors.

### H6 — Credential-header blocklists disagree across the bridge/broker boundary
Bridge `clients/bridge/request-policy.mjs:3-9` vs broker `function-node/src/credential-scrubber.js:11-16`: `client_id`, `client_secret`, `x-api-secret`, `x-key-id`, `x-secret`, `key` are caught server-side but pass the bridge; `proxy-authorization`/`proxy-authenticate` (RFC 7230 hop-by-hop) are stripped by neither bridge list.

### H7 — Two incompatible registration-package wire formats coexist
Top-level `registration-packages/render.mjs` (`tessera-registration/v1`: `format/version/signingKeyId/payload`, base64url signatures, signs the whole signed-subset) vs the newly built `function-node/src/registration-packages.js` (`formatVersion/package/signature`, standard base64, signs only the `package` sub-object). They cannot verify each other's output. Their secret scanners also diverge: `secret=`, `offline_access`, and any-length Bearer are caught only by the legacy one; PEM headers and 16+-char Bearer only by the new one (`render.mjs:2-3` vs `registration-packages.js:5-6`). One schema must be declared authoritative and the other retired.

### H8 — `slugForRole` duplicated verbatim
`function-node/src/broker.js:81-85` vs `function-node/src/azure-reference-adapter.js:5-9`. The broker's route table (`SLUG_TO_ROLE`) and the adapter's connection IDs derive from independent copies; drift in one silently desynchronizes routing from authorization.

### H9 — `SECRET_CACHE_TTL_SECONDS` is deployed but ignored
`iac/foundation.bicep:477` sets it with a comment implying effect; `function-node/src/broker.js:156` hardcodes `5 * 60 * 1000` and never reads the env var. An operator shortening the TTL after an emergency rotation would see no effect.

### H10 — Release workflows pin non-existent action versions
`.github/workflows/release-bridge.yml:33,129` and `.github/workflows/release-client.yml:39,119` use `actions/checkout@v6` and `actions/download-artifact@v5`; neither major version exists — the pipeline fails at runtime on the first real tag.

### H11 — Committed (HEAD) bridge test suite is stale
The four deleted-in-worktree tests (`init/launcher/run-preset/packaged.test.mjs` at HEAD) exercise the removed `--config`/`broker.env` API; any CI run against committed state fails. The working tree has the fixed/untracked replacements — deletions and new files must be staged together. Partially superseded by the executor's 23:46Z ED-V005-001 reconciliation, but the commit-boundary problem stands until staged.

### H12 — admin-ui FORBIDDEN guard is dead by operator precedence
`admin-ui/server.mjs:36`: `!allowed.has(key) || FORBIDDEN.test(key) && !allowed.has(key)` — the second clause is a strict subset of the first, so a forbidden-named key added to any allow-set would sail through. Note `credential` is deliberately in some allow-sets and matches FORBIDDEN — fixing this needs a design decision, not just parentheses.

### H13 — Engines say Node ≥18; the SEA artifact requires the build Node
`clients/bridge/package.json:9` (`>=18`) vs CI building the SEA blob on Node 24 (`release-bridge.yml:36`) — a downloaded binary won't load on Node 18/20. `function-node` correctly declares `>=22`.

---

## 3. Medium

- **Double policy evaluation:** `function-node/src/hosted-authority.js:40` calls `policy.allows()` twice per decision — harmless today (pure policy), doubled side effects (audit, quota) for any future stateful policy.
- **Prefix-only grant subjects accepted:** `function-node/src/connection-grants.js:22` — `user:` / `workload:` with empty local part pass validation. Admin-ui's `normalizeGrant` (`admin-ui/server.mjs:8,30`: lowercase, NFC, 127-char local) is strictly tighter than the broker's parser (256 chars, any case) — `user:ALICE` is broker-valid but console-unwritable.
- **`AUTH_MODE=oidc` unreachable through IaC:** `broker.js:212` branch exists but `iac/foundation.bicep:465` allows only `entra|generic-oidc` and never sets `OIDC_ISSUER`/`OIDC_AUDIENCE`.
- **Weaker of two OIDC login stacks is the shipped one:** `clients/bridge/public-oidc.mjs` (shipped via `broker-bridge.mjs:6`) uses `server.on` (double-settle noise on browser retries), string `!==` state compare, no `refresh_token` rejection, 120 s timeout — while unshipped `oidc-session.mjs`/`oidc-pkce.mjs` do `server.once`, `timingSafeEqual`, refresh-token refusal, 300 s.
- **`brokerProbe` accepted but unused:** `admin-ui/server.mjs:62` destructures it, never references it.
- **admin-ui `npm start` silently non-functional:** `admin-ui/server.mjs:167-169` boots a server that 401s every API call with no diagnostic output.
- **Invalid `main` field:** `function-node/package.json:5` — `"main": "src/*.js"` is a glob, not a path (harmless to the Functions runtime, misleading to tooling).
- **Bridge test glob misses suites on disk:** `clients/bridge/package.json` test script matches only `stateless-runtime-*` and `public-oidc*` — `oidc-pkce.test.mjs`, `oidc-session.test.mjs`, `routing-policy.test.mjs` exist on disk and never run under `npm test`.
- **Registration scanner divergence detail** (see H7): a package with `secret=…` or `offline_access` in a display field passes the new signing-boundary scanner but fails the legacy one.
- **`broker_client.py` DNS pinning:** module-import-time, process-wide, un-undoable `socket.getaddrinfo` patch (`clients/broker_client.py:58-66`).
- **Assurance test brittleness:** `function-node/test/runtime-assurance-integration.test.js:24` hardcodes `Retry-After: '60'`, valid only because T0 is minute-aligned.
- **admin-ui `kind` not allow-listed server-side:** `admin-ui/server.mjs:85-87` accepts any ≤128-char string for identity-integration `kind`.

---

## 4. Uncalled / dead functions — inventory

### Genuinely dead (no caller anywhere, production or test)
| Symbol | File |
|---|---|
| `verifyIdToken` | `function-node/src/generic-oidc-validation.js` |
| `parseOidcConfiguration` (contains an unreachable throw at `cli.mjs:37`) | `clients/bridge/cli.mjs:28` |
| `PRESETS` export | `clients/bridge/cli.mjs` |
| `MAX_DISCOVERY_BYTES` export | `clients/bridge/broker-bridge.mjs` |
| `INHERITED_ENVIRONMENT_KEYS` export | `clients/bridge/launcher.mjs` |
| `CREDENTIAL_HEADERS` re-export | `clients/bridge/request-policy.mjs` |
| `pkceChallenge` export | `clients/bridge/public-oidc.mjs` (used internally only) |
| `normalizeOidcClaims` export | `function-node/src/oidc-identity-adapter.js` (internal-only) |
| `inspectRegistrationPackage` | `function-node/src/registration-packages.js` |
| `brokerProbe` parameter | `admin-ui/server.mjs:62` |

### Dead-in-production, tested-only — NOT explained by directive staging
- **`clients/bridge/routing.mjs`** (`routeBrokerPath`, `validateRoutingMode`) — the strict/named routing and vendor-slug enforcement it implements is entirely absent from the live proxy loop (`broker-bridge.mjs:47` appends the raw path); `BROKER_ROUTING_MODE` is read nowhere in production.
- **`clients/bridge/oidc-session.mjs` + `oidc-pkce.mjs`** — the better-hardened parallel OIDC stack; never imported by any shipped entrypoint (verified: `broker-bridge.mjs` imports `public-oidc.mjs`, which imports `oidc-validation.mjs`; nothing imports `oidc-session.mjs` outside tests).
- **`registration-packages/render.mjs`** (top-level, legacy schema) — superseded by the new function-node module (H7) but still present with its own test tree.

### Staged-by-directive (test-only today; integration explicitly deferred to later EDs — "staged," not dead)
Built green by the vertical executor on 2026-07-26 and fixture-proven by design; the live broker still runs the old seams they were built to replace (see H3/H7 for measurable divergence already present):
- `function-node/src/registration-packages.js`, `registration-renderers.js` (ED-V005-002, GREEN 23:23Z)
- `function-node/src/assurance-policy.js`, `assurance-audit.js`, `token-lifecycle.js`, `static-key-rotation.js`, `request-rate-limits.js` (ED-V009-001, GREEN 23:34Z)

### Dead files / directories
- `broker-protocol/broker-profile.schema.json` — zero references repo-wide
- `broker-agent/` — placeholder README only
- `iac/foundation.bicep:236` — comment references non-existent `function-config.bicep` (actual file is `iac/auth.bicep`)

---

## 5. Reused / duplicated functions

| Logic | Sites | Delta / risk |
|---|---|---|
| `slugForRole` | `broker.js:81` / `azure-reference-adapter.js:5` | identical bodies — drift hazard (H8) |
| Full OIDC/JWT validation | bridge `oidc-validation.mjs` / `generic-oidc-validation.js` / `oidc-identity-adapter.js` | materially divergent: iat, discovery depth, JWKS cache, alg list (H2, H5) |
| PKCE login flow | `public-oidc.mjs` (shipped) / `oidc-session.mjs`+`oidc-pkce.mjs` (unshipped) | unshipped stack is stricter on every axis (§3) |
| Registration sign/verify + secret scan | `function-node/src/registration-packages.js` / `registration-packages/render.mjs` | incompatible schemas, divergent scanners (H7) |
| Credential-name regexes | `admin-ui/server.mjs:9` / `registration-packages.js:5` / `credential-scrubber.js` | three patterns, three coverages |
| base64url decode | `oidc-validation.mjs:4` / `generic-oidc-validation.js:5` | equivalent (latter adds `String()` coercion) |
| `fetchJson` (256 KiB HTTPS JSON) | `oidc-validation.mjs:9` / `generic-oidc-validation.js:7` | semantically identical; maintenance cost only |
| PKCE challenge | `oidc-pkce.mjs:13` (`'ascii'` hint) / `public-oidc.mjs:6` (UTF-8 default) | identical for actual inputs; independent implementations |
| Deep-`freeze` helper | `registration-packages.js:8` / `registration-renderers.js:3` | byte-identical; renderers already import packages |
| Rate limiting | `rate-limiter.js` (wired, Table-backed) / `request-rate-limits.js` (staged, in-memory) | intentional pair awaiting integration decision |
| Loopback host sets | `broker-bridge.mjs:12` (only `127.0.0.1`) / `broker-adapters/presets.mjs:5` (`127.0.0.1`, `::1`, `localhost`) | presets broader than the bridge's own bind rule |
| `HOP_BY_HOP_HEADERS` | `broker.js:150` / `request-policy.mjs:7` | same concept, different membership (H6) |

---

## 6. Verified clean

- `iac/auth.json` is a faithful compile of `iac/auth.bicep` — parameters, defaults, API version, conditionals, and outputs all match; the unused `genericOidc*` parameters in auth.bicep are an intentional consistent-surface choice, not drift.
- `providers/azure/vendor-profiles.json` is a reference catalog — not consumed by `broker.js` at runtime (routing uses `ROLE_SECRET_MAP`), so no consistency defect is possible; the `datto-rmm` profile self-documents its unimplemented `oauth-authorization-code` mode.
- `tools/vertical-progress.mjs` handles both `ED-NNN` and `ED-VNNN-NNN` id formats, REOPENED lines, and append-only last-state resolution correctly.
- Bridge security invariants hold with test evidence: credential-header strip (`request-policy.mjs:3-22`), loopback-only bind (`broker-bridge.mjs:12,35`), exact-allowlist child environment, `{ brokerBase }`-only discovery body. One gap: `proxy-authorization` forwarding (H6).
- `session.mjs` RAM-only singleton lifecycle is correct, including `clear` on SIGINT/SIGTERM.

---

## 7. Priority fix order (recommendation — no edits made)

1. **C2** — strip the hardcoded FQDN/IP/GUID defaults (one file, real exposure).
2. **H1** — the empty-groups 403 silently denies legitimately-granted users in both OIDC modes.
3. **C1 + H13 + H10** — the distribution path has three independent ways to fail on the first real release tag (entry guard, engines mismatch, phantom action versions).
4. **H7 + H3** — declare the authoritative registration schema; wire (or explicitly schedule) the staged assurance module. Both are fixture-to-production seams where the directive-built contract and the live code already disagree.
5. **H11 + test-glob** — stage the coherent test set so committed state and CI reflect what is actually on disk.

Items 2–4 map naturally onto the integration EDs the verticals already anticipate.

## 8. Remediation build specs

### NinjaOne integration path

The operational assessment of `docs/ninjaone-integration-frictions.md` found that its core
frictions remain valid after the current build, with four material gaps: connection grants are
not represented in the role-to-route explanation; Entra-only scope guidance is presented as
universal despite generic/public OIDC modes; clients lack a safe authenticated preflight and
broker-generated correlation ID; and Python ships deployment topology defaults.

The implementation-ready remediation scope, acceptance criteria, and delivery order are in
[NinjaOne integration remediation build spec](spec/ninjaone-integration-remediation-build-spec.md).
It addresses C2, H1/H4/H9, the OIDC-mode distinctions behind H5, and the client-side rate-limit
and configuration gaps without exposing a vendor credential or introducing tenant-specific
configuration into source.

---

*Reviewers: four independent read-only agents (function-node; clients/bridge; admin-ui/tools/IaC/providers; cross-cutting export graph & contracts), synthesized and contradiction-checked 2026-07-26. Severity totals: 2 CRITICAL / 13 HIGH / 12 MEDIUM / 10 LOW.*

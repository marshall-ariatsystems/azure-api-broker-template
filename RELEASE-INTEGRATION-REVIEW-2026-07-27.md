---
status: issues_found
review_type: deep_release_integration
reviewed: 2026-07-26T00:00:00-05:00
files_reviewed: 97
findings:
  critical: 5
  warning: 4
  info: 0
  total: 9
advisory_only: true
---

# Release and Integration Review — V-010 / V-011 / V-012

**Status:** Advisory only; this review is not a build gate.

I traced the shared SDK policy boundary, bridge CJS/SEA release path, broker authentication and grant paths, registration rendering, NinjaOne chain, and Python/Node/.NET client seams. I also ran the currently configured bridge and broker tests, the Node and Python client tests, and a .NET build; all passed. Those results do not cover the integration gaps below.

## Blockers

### CR-01: Registration packages trust an attacker-supplied signing key

**Files:** `function-node/src/registration-packages.js:43-47`, `function-node/src/registration-renderers.js:4-7`, `function-node/test/registration-callgraph.test.js:12-16`

`verifyRegistrationPackage()` accepts an omitted `options.trustedPublicKeySpki`. The renderers call it with whatever optional `options` their caller supplies, and the shipped call-graph test deliberately calls `renderGenericOidcSetup(raw)` with no trust anchor. Consequently, an attacker can generate an Ed25519 keypair, sign an otherwise valid package containing its issuer/audience/claim mapping, and get a package reported as valid and rendered into broker OIDC settings.

**Impact:** The registration format's signature proves only self-consistency, not authorization of the signer. Importing a package can redirect broker trust to an attacker-controlled issuer.

**Fix direction:** Make an approved public-key fingerprint/SPKI mandatory for every render/import path; obtain it from deployment-owned configuration or a pinned key registry, not the document. Keep the no-anchor path only for explicitly labelled inspection that cannot produce deployable settings. Add a test signing with a second key and asserting every renderer rejects it.

### CR-02: Preflight has no HTTP endpoint, so all client preflight adapters are disconnected from the broker

**Files:** `function-node/src/preflight.js:38-61`, `function-node/src/broker.js:516-543`, `clients/node/broker-preflight.mjs:36-40`, `clients/broker_preflight.py:42-46`, `clients/dotnet/BrokerPreflight.cs:19-28`

The Function registers only `broker` and `health`; it never imports `preflight.js` or registers a preflight route. The three client helpers merely accept an injected `invokePreflight` function and none constructs or invokes a real broker endpoint.

**Impact:** A released client cannot perform the documented/expected authenticated NinjaOne authorization preflight. The existing tests prove the pure helper contracts only, not an end-to-end request, authentication, routing, grant decision, or response shape.

**Fix direction:** Register an authenticated `preflight` HTTP route that obtains the platform/OIDC principal, invokes `runPreflight` with the production role map and grants source, and returns the redacted result. Implement each client adapter's actual request/token integration (or remove the feature claim), then add an HTTP-level integration test for allow, role denial, route denial, and grant denial.

### CR-03: Retry/preflight and configuration validation are not integrated into the shipped request clients

**Files:** `clients/node/ninja-client.mjs:32-39,58-75`, `clients/node/broker-retry.mjs:44-79`, `clients/broker_client.py:38-52`, `clients/dotnet/Program.cs:29-67`, `clients/dotnet/BrokerPreflight.cs:6-17`

The Node client calls `fetch` directly and never imports `requestWithRetry` or the preflight module. The Python client calls `requests.Session.request` directly and never imports its preflight module. The .NET client builds a URI from presence-only environment variables and never calls `BrokerPreflight.LoadConfig`; therefore its production request path accepts non-HTTPS/malformed `BROKER_BASE` values that the standalone helper rejects. Repository references to retry/preflight helpers are tests and their defining modules, not the production request paths.

**Impact:** The remediation's retry and preflight behavior is not delivered to consumers of the actual clients; .NET can also send an Entra bearer token to a misconfigured non-HTTPS base URL.

**Fix direction:** Route all production client construction through one validated configuration object, require HTTPS/no credentials/no fragment, and have the documented request API invoke the bounded retry and preflight contracts. Add integration tests that exercise the public client entry points, rather than testing injected helper seams in isolation.

### CR-04: `Cache-Control: max-age=0` is converted into a five-minute JWKS cache

**Files:** `function-node/src/generic-oidc-validation.js:10`, `function-node/src/oidc-identity-adapter.js:10-13`

Both validators use `maxAge || 300`. A valid `max-age=0` becomes the 300-second default instead of a zero-second TTL. The broker will continue accepting a removed/revoked signing key for up to five minutes despite the issuer explicitly disabling caching.

**Impact:** Key revocation and emergency rotation cannot take effect at the requested cache boundary in either OIDC mode.

**Fix direction:** Distinguish an absent/invalid directive from a parsed zero: e.g. use the default only when the regex has no match, then clamp the parsed number (including zero). Add parity tests for `max-age=0`, absent cache-control, and the upper TTL cap in both validators.

### CR-05: Python callers can overwrite the broker bearer header

**Files:** `clients/broker_client.py:41-42`

`headers.update(kwargs.pop("headers", {}))` runs after the client creates its Entra `Authorization` header. A caller-supplied `headers={"Authorization": ...}` replaces it.

**Impact:** This violates the client boundary that owns broker authentication and can send arbitrary bearer material to the broker endpoint. It can also turn a valid authenticated call into an authentication failure in a way callers cannot diagnose safely.

**Fix direction:** Merge caller headers first, then assign `Authorization` last; reject credential-shaped headers rather than silently accepting them. Add a regression test for case-insensitive `Authorization`, `x-api-key`, and proxy credential headers.

## Warnings

### WR-01: Release workflows do not execute the full security and integration test inventory

**Files:** `clients/bridge/package.json:14`, `.github/workflows/release-bridge.yml:61-79`, `.github/workflows/release-client.yml:45-65`, `clients/bridge/test/header-policy-bridge.test.mjs:19-39`, `clients/bridge/test/routing-policy.test.mjs:7-37`

The bridge `npm test` command explicitly lists a subset of bridge tests and omits, among others, header-policy, routing-policy, OIDC PKCE/session, and packaged tests (the workflow runs only one packaged test separately). The client release workflow builds and smoke-tests the .NET executable but runs neither the Node/Python client tests nor the Function tests.

**Impact:** The release can publish despite regressions in the shared header boundary, routing, client retry/preflight helpers, broker OIDC/grants, or registration logic. Passing tests observed during this review are local evidence only and are not release evidence.

**Fix direction:** Add a release verification job that runs `node --test test/*.test.mjs` for the bridge, `npm --prefix function-node test`, Node client tests, Python unittest/pytest, and .NET tests/build. Make package smoke tests artifact-based on each target platform.

### WR-02: Release action "pins" and the SBOM image remain mutable tags

**Files:** `.github/workflows/release-bridge.yml:32-34,111,127,129,142`, `.github/workflows/release-client.yml:39,41,102,118,120,133`, `clients/bridge/scripts/verify-release-actions.mjs:24-41`, `clients/bridge/test/stateless-runtime-release-pins.test.mjs:15-25`

The verifier calls `owner/action@vMAJOR` a pin and tests only an offline major allow-list. Major tags can move. The client SBOM step additionally pulls `anchore/syft:v1.20.0`, another mutable tag, with release-job write and attestation permissions.

**Impact:** A changed upstream tag can alter a release build without a repository change, undermining the support/pinning claim and supply-chain reproducibility.

**Fix direction:** Pin every GitHub Action and container image to a reviewed immutable commit/image digest; retain a human-readable version comment. Update the verifier to require and allow-list those immutable identifiers.

### WR-03: The macOS artifact architecture is asserted by name, not established by the build host

**Files:** `.github/workflows/release-bridge.yml:24-26,99-114`, `clients/bridge/scripts/package-sea.mjs:17-37`

The workflow labels the macOS artifact `osx-arm64`, but runs on the moving `macos-latest` label and packages with its current `process.execPath`. SEA output is host-architecture-specific; neither the runner selection nor an architecture assertion proves that the binary is arm64.

**Impact:** A release can publish an x64 binary under the arm64 filename, or fail when the moving runner image changes.

**Fix direction:** Use an explicitly ARM64 runner/image for `osx-arm64` (and a separate x64 matrix entry when supported), and assert the packaged binary architecture with a platform-appropriate inspection command before upload.

### WR-04: A retired registration schema remains at the old format and is not guarded against use

**Files:** `registration-packages/registration-package.schema.json:4-10`, `function-node/src/registration-packages.js:31-36`, `function-node/test/registration-callgraph.test.js:12-19`

The surviving schema specifies `tessera-registration/v1` with a legacy `format/version/signingKeyId/payload/signature` shape, while the authoritative parser expects `formatVersion/package/signature`. The call-graph test only checks that the new source text does not contain the legacy string; it does not detect this on-disk schema.

**Impact:** Tooling or operators that discover `registration-packages/registration-package.schema.json` can validate and produce a format the released parser rejects, defeating format retirement operationally.

**Fix direction:** Delete the retired schema if no consumer needs it, or replace it with the authoritative format and add a test that no legacy registration schema/files remain in distributable paths.

## Verification performed

- `npm --prefix clients/bridge test` — 34 passing tests.
- `npm --prefix function-node test` — 74 passing tests.
- `node --test clients/node/test/*.test.mjs` — 7 passing tests.
- `python3 -m unittest clients.test_broker_config clients.test_broker_preflight` — 7 passing tests.
- `dotnet build clients/dotnet/NinjaBrokerClient.csproj --no-restore` — succeeded with 0 warnings/errors.

These are useful regression signals but do not invalidate the findings: they do not execute a real preflight route (none is registered), do not require a registration trust anchor, and do not exercise public client request paths through retry/preflight/config validation.

## Remediation verification — 2026-07-27

All five critical findings and four warnings above have been remediated. This
section preserves the original findings as the audit record rather than editing
them out of history.

| Finding | Remediation |
|---|---|
| CR-01 | Registration rendering and verification now require a deployment-owned, pinned Ed25519 SPKI trust anchor. Self-signed packages remain inspectable but cannot be deployed. |
| CR-02 | A credential-free, authenticated route is registered at `GET /api/broker/preflight/{routeSlug}`. It performs role and grant proof without Key Vault, vendor, OAuth, quota, or other downstream work. The shipped clients require an explicit lowercase route slug. |
| CR-03 | Node, Python, and .NET public client paths now use validated broker configuration; Node/Python public paths invoke authenticated preflight and bounded GET/HEAD `429` retry behavior. |
| CR-04 | Both JWKS validators preserve `Cache-Control: max-age=0`; only missing or invalid directives receive the default TTL. |
| CR-05 | Python rejects credential-shaped caller headers and assigns its broker-owned Authorization header after caller-header processing. |
| WR-01 | Both release workflows now require a `verify-integration` job covering bridge, broker, Node, Python, and .NET checks before release. |
| WR-02 | GitHub Actions are pinned to reviewed immutable commit SHAs and Syft is pinned to an immutable image digest. |
| WR-03 | macOS ARM artifacts use `macos-14` and a `file` architecture assertion before upload. |
| WR-04 | The distributable registration schema is authoritative and legacy renderer/schema fixtures are removed and guarded by tests. |

Verification after remediation:

- `npm test --prefix clients/bridge` — 34 passing.
- `npm test --prefix function-node` — 79 passing.
- `node --test clients/node/test/*.test.mjs` — 9 passing.
- `python3 -m unittest clients.test_broker_config clients.test_broker_preflight clients.test_broker_client_integration` — 9 passing.
- `dotnet build clients/dotnet/NinjaBrokerClient.csproj --no-restore --nologo -v q` — succeeded with 0 warnings/errors.
- `node clients/bridge/scripts/verify-release-actions.mjs` and `git diff --check` — passed.

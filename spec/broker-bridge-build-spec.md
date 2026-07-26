# Broker Product Package Build Specification

## Purpose

Deliver a product package that centralizes access to API keys. A remotely hosted broker stores
vendor credentials and injects them only after a configured identity provider has authenticated the
caller and the broker has confirmed that the caller may use the named connection.

The local `broker-bridge` package is a signed, stateless compatibility client. It lets existing
applications keep their familiar endpoint and API-key environment-variable structure, but it holds
no usable vendor credential and persists no product data. It authenticates with the configured
identity provider, holds access tokens in memory only, and calls the hosted broker.

This product answers one authorization question:

> May this authenticated identity use this broker-held API-key connection?

It does not infer, translate, or enforce vendor-side API permission scopes. The vendor API key's
own permissions remain the vendor's responsibility.

## Design goal — the secure path is the easy path

An authorized person or workload installs one signed package, authenticates with its organization’s
identity provider, and starts its application through the bridge. It does not receive, copy,
configure, or rotate a vendor key.

- Existing base-URL and API-key environment-variable shapes continue to work.
- A harmless compatibility placeholder such as `broker-managed` replaces a real vendor key.
- The local package handles browser sign-in, ephemeral token acquisition and refresh, loopback
  proxying, broker discovery, and application launch.
- Administrators manage connections and access grants in a plain-language GUI.
- A person with no grant receives a denial; a person whose grant is revoked immediately loses the
  ability to use that connection.
- Errors recommend the shortest useful remediation without exposing identity-provider, secret-store,
  or vendor internals.

**Decision rule:** remove a user step without weakening the security invariants. Normal use must not
require a terminal, `.env` file, cloud resource names, or knowledge of vendor OAuth.

## Product architecture

```text
signed local package (stateless)
  ├── browser sign-in to configured IdP
  ├── in-memory access token only
  ├── loopback compatibility proxy and application launcher
  └── credential-placeholder stripping
                 │
                 ▼
remotely hosted broker
  ├── IdP token validation and assurance validation
  ├── identity → connection access-grant check
  ├── remote secret-provider retrieval and server-side injection
  ├── rate limits, audit events, and health
  └── vendor API
```

The hosted broker is an identity-provider application/resource server. The local package either
uses the identity provider's supported direct browser sign-in model or is registered as an OAuth/OIDC
public client. Public clients use Authorization Code with PKCE and have no client secret.

The same signed local package works across identity providers. Identity-provider-specific onboarding
is delivered as a verified marketplace integration when available, an importable private registration
package when it is not, and a generic OIDC fallback.

## Core contracts

### Connection

A **connection** is a named broker-held vendor credential plus non-secret routing and injection
metadata. It is stored only by the hosted broker and its remote secret provider. A connection may
represent a static API key or a client-credential pair used by the broker to mint short-lived vendor
tokens. No connection credential is returned to a local package or application.

### Identity provider integration

An **identity provider integration** defines the issuer, audience/resource, signing-key discovery,
redirect URIs, accepted identity/group/workload claims, and required authentication assurance. The
first product contract is standard OIDC/OAuth using Authorization Code with PKCE. Provider presets
are usability additions, not alternative authorization models.

### Access grant

An **access grant** attaches an identity, group, or workload identity from an identity provider to a
connection. The hosted broker evaluates this grant before every request. It does not inspect a
vendor request to decide whether a vendor operation is allowed.

### Registration package

An **identity-provider registration package** is a signed, non-secret, provider-specific setup
artifact for an organization that has not already registered the broker application. It supplies
only registration metadata and policy templates, including:

- redirect URIs and broker discovery metadata;
- resource/audience and requested claims or group mappings;
- the identity assurance requirement, including the FIDO2-only policy contract;
- initial administrator/access-grant bootstrap; and
- links or instructions to create the hosted broker tenant.

It must never contain a vendor credential, client secret for the local package, refresh token, or
customer-specific API key. A marketplace listing is a prebuilt registration package delivered through
an identity provider’s application catalog.

### Stateless local package

The local package is a signed executable containing the bridge, application adapters, and static
defaults. It may hold discovery configuration and OAuth tokens in process memory for its current
run only. It must not persist API credentials, connection profiles, refresh tokens, identity sessions,
or other product state to disk, the OS credential store, browser storage under its control, or a local
database.

### Application adapter

An adapter maps an application's normal configuration shape to the loopback bridge. It may set a
local base URL and `broker-managed`, but it must never accept, generate, or persist a vendor
credential. OpenAI, Anthropic, and generic HTTP are the initial adapters.

## Product boundary

| Component | Responsibility |
|---|---|
| Local package | Stateless browser sign-in, in-memory token refresh, compatibility proxy, launcher, and placeholder filtering. |
| Identity provider | Authenticate users/workloads and issue broker-audience tokens under the organization’s assurance policy. |
| Hosted broker | Validate identity, check identity-to-connection access, retrieve/inject remote credentials, rate-limit, and audit. |
| Remote secret provider | Store vendor credentials and make them available only to the hosted broker. |
| Admin GUI | Connect an IdP, create connections, grant/revoke access, and display health/audit information. |
| Vendor API | Enforce its own API-key permissions. It does not receive caller identity or broker access tokens. |

The existing Azure/Entra/Key Vault broker is a reference hosted-broker provider. Its Entra
role-to-secret mapping is a migration path to the provider-neutral identity-to-connection access
grant model, not the public product vocabulary.

## Security invariants

- Never write, accept as local configuration, log, or forward a real vendor API key on the client.
- A compatibility value such as `broker-managed` is a non-secret placeholder only.
- The local package persists no connection data, tokens, secrets, or identity session state.
- Bind the loopback proxy to `127.0.0.1` by default; never default to `0.0.0.0`.
- Authenticate only through the selected identity provider; do not implement a separate vendor
  authentication flow on the client.
- Use PKCE and no client secret for a local public OAuth/OIDC client.
- The hosted broker is the only authority that decides whether an identity may use a connection.
- Do not implement vendor operation or vendor permission-scope enforcement in the broker.
- Remove caller-supplied credential-shaped headers before forwarding to the hosted broker.
- Do not forward the caller’s identity token, identity claims, or broker tokens to the vendor.
- FIDO2-only use is a product release gate. The system must preserve the IdP assurance evidence
  necessary to enforce it, even while detailed FIDO2 mechanics are implemented later.

## Phase 1 — Provider-neutral contracts and hosted-broker migration

Define the public data model for identity-provider integrations, connections, access grants, and
audit events. Add a hosted-broker authorization interface that evaluates:

```text
authenticated identity + requested connection → allow or deny
```

Migrate the Azure reference provider from its internal role-to-secret representation to an adapter
that implements this interface. Preserve the existing Key Vault retrieval, credential scrubbing,
rate limiting, and vendor injection behavior behind the new contract.

**Acceptance criteria**

- A named connection has no vendor credential in product-visible metadata or local responses.
- The broker can allow and deny a request solely from identity-to-connection access grants.
- Existing Azure role mappings can be represented as migration-compatible access grants.
- No code path evaluates vendor API operations or invents vendor permission scopes.

## Phase 2 — Identity-provider integration and registration packages

Implement standards-based OIDC/OAuth authentication for the hosted broker and local package.
Support Authorization Code with PKCE for the local public client, token issuer/audience/signature
validation at the hosted broker, and normalized identities, groups, and workload claims.

Ship three onboarding choices:

1. **Verified marketplace integration** for identity providers that support an application catalog.
2. **Private registration package** generated or downloaded for an organization-specific IdP setup.
3. **Generic OIDC** form for a standards-compliant provider without a preset.

The package/setup GUI must explain the setup in identity language: connect identity provider, choose
who administers access, and require hardware-key assurance. It must not expose cloud resource names
or require a user to create a local client secret.

**Acceptance criteria**

- A generic OIDC integration can authenticate a local public client without a persisted client secret.
- A registration package contains no secrets and can be inspected before import.
- Marketplace and private-registration paths produce equivalent broker claims/audience behavior.
- Identity, group, and workload claims can be used as access-grant subjects.
- Token-validation failures return an actionable sign-in/remediation response without leaking token data.

## Phase 3 — Connection access, token lifecycle, limits, and audit

Make identity-to-connection access the mandatory hosted-broker gate. The broker must validate every
incoming token, resolve the requested connection, evaluate its grants, then retrieve/inject the
credential only when allowed.

Retain and formalize existing reliability behavior:

- Per-identity and per-connection rate limits return `429` and a meaningful `Retry-After`.
- The default failure mode for unavailable rate-limit storage is deny/fail-closed; any alternative is
  an explicit administrator policy.
- OAuth client-credential vendor tokens remain hosted, cached until shortly before expiry, refreshed
  before expiry, and re-minted once after an upstream `401`.
- A static bearer/API key is a static credential and is rotated remotely; it is not “refreshed.”
- The local package refreshes broker tokens in memory before expiry and honors `Retry-After` without
  blindly retrying non-idempotent calls.
- Audit events identify the connection and calling identity without recording vendor keys, bearer
  tokens, request credentials, or sensitive request/response contents.

**Acceptance criteria**

- Removing a grant causes the next request to be denied without rotating the connection credential.
- A rate-limited call returns `429` plus `Retry-After`; a compliant client does not retry early.
- Vendor OAuth expiry and one upstream `401` recovery are covered by integration tests.
- Neither local logs nor audit events contain vendor or broker access tokens.

## Phase 4 — Stateless compatibility bridge

Deliver the loopback bridge and launcher as a stateless client of the hosted broker. Configuration is
received during the current authenticated session from signed discovery/bootstrap metadata; it is not
written as `broker.env` or another persistent local profile. Command invocation may accept a broker
discovery URL or organization identifier for that run.

The bridge derives runtime-only application settings. For the OpenAI adapter:

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:8079/openai/v1
OPENAI_API_KEY=broker-managed
```

Add the command surface:

```text
broker-bridge serve --broker <discovery-url>
broker-bridge run --broker <discovery-url> -- <application> [args...]
```

`run` signs in when required, starts the bridge, waits for `/_bridge/health`, launches the child
process with compatibility settings, forwards termination signals, returns the child exit status,
clears in-memory state, and stops the bridge on exit. `serve` retains long-running sidecar behavior
for the lifetime of the process only.

**Acceptance criteria**

- A fixture application receives only a loopback URL and non-secret placeholder.
- Restarting the local package requires fresh discovery/authentication and finds no persisted product state.
- A failing child process returns its original exit status.
- Ctrl-C stops child and bridge without leaving a listener or persistent token/profile behind.
- Health-check timeout and identity failures produce actionable errors.

## Phase 5 — Adapters and credential filtering

Provide standard adapters:

| Adapter | Base URL variable | Placeholder key variable |
|---|---|---|
| `openai` | `OPENAI_BASE_URL` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_API_KEY` |
| `generic` | `VENDOR_BASE_URL` | `VENDOR_API_KEY` |

Every adapter uses `broker-managed`. Support explicit runtime-only environment mappings for
non-standard SDKs, but reject a mapping that supplies a credential-shaped or real credential value.

Before forwarding, strip credential-shaped headers case-insensitively, including `x-api-key`,
`api-key`, `apikey`, `api_key`, `subscription-key`, `access_token`, `token`, and application-supplied
`authorization`. Keep normal request headers and bodies intact. Never forward hop-by-hop or platform
headers.

**Acceptance criteria**

- Presets and explicit mappings set only endpoints and non-secret placeholders.
- Placeholder Bearer and API-key values never reach the hosted broker.
- Filtering has adversarial tests for casing and alternate credential-header names.
- The local URL always names an authorized broker connection route.

## Phase 6 — Admin GUI

Build a GUI for the hosted product, not an Azure administration console. Its primary screens are:

1. **Connect identity provider:** install marketplace integration, import/apply registration package,
   or use generic OIDC.
2. **Connections:** name a connection, select credential type, enter a credential write-only into
   the remote secret provider, and validate non-secret connectivity.
3. **Access:** choose users, groups, or workload identities that may use each connection; revoke
   access with confirmation.
4. **Health and usage:** show broker health, authentication/assurance status, rate-limit outcomes,
   token-mint/refresh health, and per-identity connection use without exposing credentials.

Use product language such as “who can use this connection?” Do not require normal administrators to
understand Key Vault, app roles, Function Apps, or vendor OAuth. Provider-specific diagnostics belong
in an explicitly advanced support view.

**Acceptance criteria**

- An administrator can complete identity setup, create a connection, and grant a group access without a terminal or local config file.
- Credential values are write-only and never appear in the GUI, response, log, or audit event.
- A revoked group/user/workload loses access on the next broker request.
- The GUI makes clear that it controls access to a key, not vendor API permissions.

## Phase 7 — FIDO2 assurance gate

Implement the FIDO2-only access requirement as an identity-assurance validation at the hosted broker
and in registration-package/preset policy. The concrete mechanism varies by identity provider, but
the broker must accept only tokens or session evidence meeting the organization’s configured
hardware-key requirement.

Do not substitute a local password, local secret, or silently weaker MFA method. Detailed provider
mechanics and UX may evolve, but a release cannot claim FIDO2-only operation without an end-to-end
test against supported providers.

**Acceptance criteria**

- The registration package documents/configures the required FIDO2 assurance policy.
- The hosted broker denies a valid identity token that lacks required assurance evidence.
- A supported IdP integration with a FIDO2 hardware key can complete the full connection-use flow.

## Phase 8 — Signed package, tests, and release automation

Package the bridge as the user-facing binary for Linux x64, macOS ARM64, and Windows x64. Use a
bundled CommonJS entrypoint with Node SEA where reliable; otherwise ship a signed OS-native archive
with its bundled runtime. The artifact may embed static defaults but must not embed tenant secrets,
vendor credentials, or persistent customer profiles.

Each release contains:

- platform archive;
- SHA-256 checksums;
- CycloneDX SBOM;
- artifact provenance attestation; and
- platform signing where configured.

Required automated coverage includes registration-package secret scanning, generic OIDC/PKCE flow,
token expiry/refresh, FIDO2-assurance rejection, grant/revocation, rate-limit behavior, credential
filtering, stateless restart, launcher lifecycle, and packaged smoke tests.

**Acceptance criteria**

- `broker-bridge --version` runs on each supported platform without a separately installed Node runtime.
- A clean-machine test installs the package, signs in, starts an authorized app, and finds no persisted product data after exit.
- The release artifact contains no vendor credential, refresh token, local client secret, or customer-specific profile.
- Release artifacts are signed where configured, checksumed, SBOM-backed, provenance-attested, and pass smoke tests before publication.

## Delivery gates

The first product package is complete only when:

1. An administrator can configure an IdP through a marketplace integration, registration package, or generic OIDC path.
2. An administrator can create a remote connection and grant a user, group, or workload access without exposing its credential.
3. An authorized user can run a common SDK through the stateless local package with no real vendor key in its environment, source, or local storage.
4. An unauthorized or revoked identity cannot use the connection, while the vendor key remains unchanged and remote.
5. Rate limits, token expiry/refresh, audit redaction, and credential filtering are verified end to end.
6. FIDO2-only assurance is enforced for every released supported IdP integration.
7. Release artifacts meet signing, checksum, SBOM, provenance, and clean-machine validation requirements.

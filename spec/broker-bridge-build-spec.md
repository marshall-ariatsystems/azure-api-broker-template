# Broker Bridge Build Specification

## Purpose

Deliver `broker-bridge` as the plug-and-play local agent for organization-approved API brokers. It must let an existing application retain its familiar endpoint and API-key environment-variable structure while ensuring that no usable vendor credential reaches the client machine.

The first provider implementation authenticates with Microsoft Entra through `DefaultAzureCredential` (normally an existing `az login` session). The product core proxies only through an approved broker and binds only to loopback by default.

## Design goal — security as the easiest path

The secure workflow must be shorter and more familiar than copying a vendor API key. Users should authenticate once with their organization's identity provider (`az login` for the first Azure provider), then start their existing application through the bridge with its normal environment-variable and SDK conventions.

The bridge should be nearly invisible to an application developer:

- Existing base-URL and API-key environment-variable shapes continue to work.
- A harmless compatibility placeholder such as `broker-managed` replaces a real vendor key.
- The bridge handles identity-token acquisition and refresh, loopback proxying, broker routing, and vendor-key isolation.
- Administrators grant or revoke access through their identity provider rather than distributing replacement vendor keys or requiring application code changes.
- Errors must recommend the shortest remediation, for example `az login` for Azure, instead of exposing provider internals.

**Decision rule:** prefer the option that removes a user step without weakening the security invariants below. A user who can follow `broker-bridge init` and `broker-bridge run -- <application>` should not need to understand Key Vault, vendor OAuth, or broker internals.

## Core product architecture

`broker-bridge` is a product core, not an Azure-template helper. The core is provider- and vendor-agnostic: it identifies the caller, loads an approved broker profile, starts a loopback proxy, launches an application, and ensures that the application never receives a usable vendor credential.

```text
broker agent core
├── broker profile and discovery contract
├── local loopback proxy and process launcher
├── credential-placeholder filtering
├── diagnostics, updates, and release verification
├── identity providers
│   └── Microsoft Entra / DefaultAzureCredential (first implementation)
├── application adapters
│   ├── OpenAI environment convention
│   ├── Anthropic environment convention
│   └── generic HTTP environment convention
└── broker providers
    └── Azure Key Broker / Entra / Key Vault (reference implementation)
```

The core must not contain vendor-specific credential handling or Azure-specific authorization rules. Providers supply broker authentication and policy; adapters translate familiar application conventions into the core's local endpoint and harmless placeholder credential.

## Core contracts

### Broker profile

A broker profile is non-secret metadata that tells the agent where and how to reach an approved broker. It contains the broker URL, identity-provider parameters, supported vendor routes, adapter hints, minimum agent version, and profile identity. It may be embedded in an organization distribution, stored locally after first use, or obtained from a trusted broker discovery document.

The current Azure profile uses `BROKER_BASE` and `BROKER_SCOPE`. Those are provider-specific inputs, not universal product requirements.

### Application adapter

An adapter maps an application's normal configuration shape to the local agent. It may set a base URL and a harmless value such as `broker-managed`, but it must never accept or generate a vendor credential. OpenAI, Anthropic, and generic HTTP are the first adapters.

### Broker provider

A provider verifies the caller identity and enforces broker-side authorization. The Azure provider uses Entra roles, Key Vault, managed identity, quota enforcement, and audit logging. Future providers can use another identity system without changing the agent or adapters.

## Product boundary

| Component | Responsibility |
|---|---|
| Broker agent core | Local compatibility proxy, lifecycle, credential-placeholder stripping, profile handling, and application launch. |
| Application adapter | Familiar SDK/environment-variable conventions for a supported application ecosystem. |
| Broker provider | Identity validation, authorization, server-side vendor credential retrieval/injection, quotas, and audit logging. |
| Application | Uses its normal SDK/environment configuration. It never receives a real vendor API key. |

The supported product direction is a signed `broker-bridge` executable plus provider implementations. The Azure/Entra/Key Vault broker in this repository is the first reference provider; `broker-client` remains a lower-level tooling option.

## Repository refactor target

The current repository remains a working Azure reference implementation while the product boundaries are made explicit. The intended future structure is:

```text
broker-agent/             # universal local executable
broker-adapters/          # OpenAI, Anthropic, generic HTTP, future adapters
broker-protocol/          # broker profile and discovery contract
providers/azure/          # Entra + Azure Key Broker reference provider
examples/azure-template/  # deployment template and walkthroughs
```

This is a logical refactor target, not an immediate file move. Preserve the current Azure deployment while extracting stable contracts and tests first.

## Security invariants

- Never write, accept as configuration, log, or forward a real vendor API key on the client.
- A compatibility value such as `broker-managed` is a non-secret placeholder only.
- Bind to `127.0.0.1` by default; never default to `0.0.0.0`.
- Acquire broker access tokens through the selected identity provider; do not implement a separate vendor authentication flow on the client.
- Remove caller-supplied credential-shaped headers before the bridge calls the broker.
- Preserve the broker as the only authority for vendor routing and authorization.

## Phase 1 — Keyless compatibility configuration

The first implementation uses the Azure profile contract below. A future generic broker profile supersedes the Azure-specific naming while preserving the keyless configuration guarantee.

Define an external, untracked `broker.env` contract containing only routing and identity configuration:

```dotenv
BROKER_BASE=https://broker.example.com/api/broker
BROKER_SCOPE=api://<broker-app-id>/.default
BROKER_VENDOR=openai
```

The bridge must derive runtime-only application settings. For the OpenAI preset:

```dotenv
OPENAI_BASE_URL=http://127.0.0.1:8079/openai/v1
OPENAI_API_KEY=broker-managed
```

`broker-managed` must not be accepted as a vendor credential or written to any persistent application configuration.

**Acceptance criteria**

- A generated configuration template contains no vendor key field.
- Configuration validation identifies missing `BROKER_BASE` and `BROKER_SCOPE` before the bridge starts.
- Configuration files are ignored by Git.

## Phase 2 — Application launcher

Add the command surface:

```text
broker-bridge serve --config broker.env
broker-bridge run --config broker.env -- <application> [args...]
```

`run` must start the bridge, wait for `/_bridge/health`, launch the child process with the compatibility environment, forward termination signals, return the child's exit status, and stop the bridge on exit.

`serve` retains the existing long-running proxy behavior for container/sidecar use.

**Acceptance criteria**

- A fixture application receives the injected compatibility environment.
- A failing child process returns its original exit status.
- Ctrl-C stops both child and bridge without leaving a listener behind.
- Health-check timeout produces an actionable error.

## Phase 3 — Vendor presets and explicit mapping

Provide standard presets:

| Preset | Base URL variable | Placeholder key variable |
|---|---|---|
| `openai` | `OPENAI_BASE_URL` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_BASE_URL` | `ANTHROPIC_API_KEY` |
| `generic` | `VENDOR_BASE_URL` | `VENDOR_API_KEY` |

Every preset uses `broker-managed` as the placeholder. Support explicit environment mapping for SDKs with non-standard variable names:

```text
broker-bridge run --preset openai \
  --set MY_VENDOR_URL=http://127.0.0.1:8079/openai/v1 \
  --set MY_VENDOR_KEY=broker-managed \
  -- <application>
```

**Acceptance criteria**

- Presets set only endpoint and non-secret placeholder values.
- Explicit mappings cannot set a value matching a configured or credential-shaped vendor key.
- The local URL always contains a broker vendor slug.

## Phase 4 — Compatibility and credential stripping

Extend bridge request filtering beyond `Authorization`. Before forwarding to the broker, remove credential-shaped headers case-insensitively, including:

- `x-api-key`, `api-key`, `apikey`, `api_key`
- `subscription-key`
- `access_token`, `token`
- `authorization`

Keep normal request headers and bodies intact. Do not let placeholder credentials trigger rejection in the broker.

**Acceptance criteria**

- Bearer and API-key style placeholders never reach the broker.
- The bridge does not forward hop-by-hop or `x-ms-*` platform headers.
- Header filtering has adversarial tests for casing and alternate credential-header names.

## Phase 5 — Bridge binary packaging

Package the bridge, rather than the direct client, as the user-facing binary. Build one artifact per platform:

```text
bin/broker-bridge-linux-x64/
bin/broker-bridge-osx-arm64/
bin/broker-bridge-win-x64/
```

Use a bundled CommonJS entrypoint with Node Single Executable Application (SEA) packaging. Bundle dependencies before SEA injection because a SEA main script cannot load ordinary third-party modules directly. Embed static defaults, but keep `broker.env` external and editable.

If Azure Identity cannot be packaged reliably as a single executable, release a signed OS-native archive containing the bridge and its bundled Node runtime instead. Do not silently ship a partially functional binary.

**Acceptance criteria**

- `broker-bridge --version` runs on each supported platform without a separately installed Node runtime.
- `broker-bridge serve --config fixture.env` starts and serves health.
- An `az login` identity can acquire a broker token from the packaged build.
- The binary and extracted runtime do not contain a vendor credential.

## Phase 6 — Automated test coverage

Add unit and integration coverage for the configuration parser, presets, launcher lifecycle, credential filtering, and packaged bridge smoke tests.

Required scenarios:

1. `run` launches a fixture application and supplies compatibility values.
2. Placeholder Bearer and `x-api-key` values are stripped.
3. Missing or expired Azure login produces a clear remediation message.
4. The bridge remains loopback-only by default.
5. Child exit status and termination handling are preserved.
6. A packaged executable can run its health and launch smoke tests.

## Phase 7 — Release automation

Extend release automation to build, test, and publish bridge artifacts for Linux x64, macOS ARM64, and Windows x64.

Each release must contain:

- Platform archive
- SHA-256 checksums
- CycloneDX SBOM
- GitHub artifact provenance attestation
- Optional Windows Authenticode signature when signing secrets are configured

Run packaging smoke tests before release publication. Tagged releases publish; manual workflow runs produce test artifacts only.

## Phase 8 — First-run documentation and UX

Provide a minimal first-run experience:

```text
az login
broker-bridge init --preset openai
broker-bridge run --config broker.env -- <application>
```

`init` creates a keyless template, explains the broker base URL, scope, and vendor slug, and links to role-assignment guidance. It must never prompt for a vendor API key.

Document container sidecar use separately from local executable use. State clearly that production workloads should use managed identity where available.

## Delivery gates

The feature is complete only when:

1. A common SDK can run through the bridge with no real vendor key in its environment or source.
2. The bridge has stripped every supplied placeholder credential before forwarding.
3. A packaged executable successfully uses `az login` to call an authorized broker endpoint.
4. Release artifacts are signed where configured, checksumed, SBOM-backed, and provenance-attested.
5. Tests cover both local developer launch and headless/managed-identity deployment paths.

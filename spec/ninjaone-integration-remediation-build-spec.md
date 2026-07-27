# NinjaOne integration remediation build spec

## Purpose

Turn the documented NinjaOne operational frictions into an explicit, tenant-neutral
integration path. This is a remediation slice; it must not embed a real tenant, app ID,
hostname, private IP, credential, vendor OAuth token, or Key Vault secret value.

The security boundary remains fixed: a caller proves its Tessera identity; the broker
authorizes the caller and retrieves/injects the NinjaOne credential server-side. A client
never receives a vendor credential, Key Vault secret value, or reusable vendor token.

## Scope

### 1. Explicit NinjaOne onboarding contract

- Add a `ninjaone` provider profile describing only public, non-secret fields: route slug,
  authentication mode, expected broker audience/scope shape, and required registration-package
  handoff kind.
- Require deployment-time `ROLE_SECRET_MAP` and connection-grant configuration for the
  NinjaOne route. No source-code default may name a NinjaOne hostname, secret slot, private IP,
  app ID, or scope.
- Document the full authorization chain:

  ```text
  caller identity -> enterprise-app role -> NinjaOne route -> connection grant
                  -> Key Vault secret slot -> broker-managed vendor request
  ```

- Reject an onboarding configuration missing any of the role, route, connection-grant, or
  server-side secret-slot links with a field-specific, non-secret diagnostic.

### 2. Safe authenticated preflight

- Add an authenticated broker preflight endpoint that performs no Key Vault, vendor, OAuth, or
  mutation work. It verifies the caller's identity and returns only:
  `status`, `correlationId`, caller subject type, selected route (when authorized), and
  categorical authorization result.
- Generate a broker correlation ID when the caller does not supply one; return it and include it
  in safe broker logs. Never return raw token claims, roles, grant documents, vendor URL, secret
  name, credential, or authorization header.
- Provide a shared client preflight helper for Node, .NET, and Python. It must acquire the
  appropriate broker token, call preflight, surface status/correlation ID, and never print the
  bearer token.

### 3. Client configuration and rate-limit behavior

- Make `BROKER_BASE`/`BROKER_SCOPE` (or their documented equivalents) required, trimmed,
  and validated as non-secret values in every shipped client. Remove the Python client's
  hardcoded host, private IP, and scope defaults and eliminate import-time global DNS patching.
- Treat `Retry-After` as authoritative. Clients may use bounded jittered retry only for
  explicitly idempotent reads; they must never automatically retry writes without an
  idempotency contract and status check.
- When a request is rate-limited, expose HTTP status, parsed `Retry-After`, and correlation ID
  to the caller without exposing response credentials or vendor internals.

### 4. Documentation alignment

- Update `docs/ninjaone-integration-frictions.md` to label Entra scope guidance as
  `AUTH_MODE=entra` specific and to cover generic/public OIDC separately.
- Add the connection-grant layer to the role/route explanation.
- State that `/api/health` is authenticated by default; client authorization proof uses the
  authenticated preflight endpoint, while unauthenticated availability probes require an
  explicit deployment allow-list decision.
- State that NinjaOne is not supported until its provider profile, deployment mapping, and
  connection grant are configured.

## Out of scope

- Browser-based vendor OAuth implementation, real tenant registration, secret provisioning,
  deployment, and any change that exposes a vendor credential to a client.
- Weakening Easy Auth/OIDC audience validation, arbitrary route access, or unauthenticated
  management APIs.

## Acceptance criteria

1. A NinjaOne profile is tenant-neutral and contains no credential-shaped fields or values.
2. A configured caller with the required role and connection grant receives an authenticated
   preflight success with a correlation ID; it causes zero Key Vault and vendor calls.
3. A caller missing the role or grant receives a categorical denial with a correlation ID and
   zero Key Vault/vendor calls.
4. Node, .NET, and Python preflight helpers reject malformed configuration without printing a
   token or credential. Python has no deployment defaults and no process-wide DNS monkeypatch.
5. Read-only retry honors `Retry-After`; writes are attempted once by default.
6. Tests cover Entra and generic/public OIDC configuration distinctions, route/grant denials,
   redaction, correlation propagation, and preflight no-side-effect ordering.

## Delivery order

1. Remove client deployment defaults and add configuration validation.
2. Add broker correlation/preflight boundary and no-side-effect tests.
3. Add tenant-neutral NinjaOne profile plus deployment validation.
4. Add client helpers and rate-limit handling.
5. Update operational documentation and run the full client/broker suite.

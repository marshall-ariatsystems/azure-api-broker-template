# NinjaOne integration frictions and mitigations

This note records the recurring operational friction observed when a client
application reaches NinjaOne through Tessera. It is intentionally tenant-neutral:
use placeholders in commands and never add a real tenant ID, application ID,
hostname, user, token, or vendor credential to this file.

The intended trust boundary remains unchanged:

```text
client workload or user identity
  -> Entra access token for Tessera
  -> Tessera role and vendor mapping
  -> Key Vault-held NinjaOne credential
  -> NinjaOne API
```

The client receives only NinjaOne responses. It never receives the NinjaOne
credential, a Key Vault secret value, or a reusable vendor OAuth token.

## 1. Resource scope is missing from the client application

### Symptom

Azure CLI or another caller receives `AADSTS650057` while requesting a Tessera
token. The error states that the requested `api://...` resource is not listed in
the client application's requested permissions.

### Cause

The broker application registration has not exposed a delegated API scope, the
calling application has not been granted that permission, or consent has not
completed. A successful Azure sign-in is not enough: the token request still
needs permission for the broker resource.

### Mitigation

1. In the broker app registration, expose the delegated scope used by the broker
   API (for example, `VendorApi.Invoke`).
2. Add that delegated permission to the caller application and grant the
   required consent.
3. Acquire a token for the broker resource, for example
   `api://<BROKER_CLIENT_ID>/.default` when the application is configured for
   that resource flow.
4. Decode only token *claims* during diagnostics; never paste or store a token.

Do not solve this by weakening Easy Auth audiences or allowing an arbitrary
resource. A missing permission is an identity-configuration problem.

## 2. App registration, enterprise application, and Key Vault roles are confused

### Symptom

An administrator can see the NinjaOne secret in Key Vault but a caller still
receives `403`, or the caller has a broker role but the expected vendor route is
not available.

### Cause

These are separate control planes:

| Control plane | Owns |
|---|---|
| App registration | API identifier, delegated scope, app roles, token version |
| Enterprise application | User/group/application assignment to an app role |
| Key Vault | Secret value and Function managed-identity read access |
| Tessera vendor map | App-role-to-vendor/secret route mapping |

Granting a human Key Vault access does not grant a Tessera route. Conversely,
assigning an enterprise-app role does not grant direct secret read access—and it
should not.

### Mitigation

Document each NinjaOne vendor route as one explicit mapping:

```text
Tessera app role -> vendor slug -> Key Vault secret slot -> caller assignment
```

Assign callers through the enterprise application. Keep the vendor secret
readable only by the broker Function's managed identity.

## 3. Vendor OAuth flow is mistaken for broker authorization

### Symptom

Configuration discussions mix a vendor callback URI, a NinjaOne machine-to-machine
credential, and the caller's Entra authorization to Tessera.

### Cause

There are two independent auth paths:

1. **Caller to Tessera:** Entra token plus broker app-role authorization.
2. **Tessera to NinjaOne:** broker-held NinjaOne credential or vendor OAuth
   provider.

A client-credentials flow does not use a browser redirect URI. If a vendor
integration needs an authorization-code callback, that callback belongs to the
broker's vendor-provider onboarding path, not to Teams, Computer, an MCP client,
or a workstation running a tool.

### Mitigation

Record the NinjaOne auth mode before onboarding it. Keep all vendor-flow details
inside the Tessera provider configuration and Key Vault. Client configuration
should contain only the broker URL, broker audience/scope, and vendor route name.
For `AUTH_MODE=entra`, apply the Entra-specific scope, consent, and admin-consent
guidance; for `generic/public OIDC`, use that provider's discovery and scope
guidance instead. The caller-to-Tessera path resolves through the
connection-grant layer: holding the enterprise-app role is necessary but not
sufficient, because a connection-grant record for `<vendor-route>` is also
required.

## 4. The runtime cannot acquire the same Entra token as an interactive shell

### Symptom

`az login` succeeds for an administrator, but a service, container, remote
desktop host, or scheduled process cannot call Tessera.

### Cause

The caller's runtime identity differs from the interactive shell identity. A
credential chain may not have access to the Azure CLI cache, may run under a
different account, or may lack the assigned enterprise-app role.

### Mitigation

Add a non-secret startup preflight to every client integration:

1. identify the active credential source without logging token material;
2. acquire a token for the broker audience;
3. call the authenticated preflight as the authorization-proof path;
4. report only caller identity, expected role/route, HTTP status, and correlation
   ID.

Do not make a live remediation or script action the first proof that a client is
authorized. An unauthenticated health probe is permitted only after a documented
explicit allow-list decision.

## 5. Secret/configuration formatting fails opaquely

### Symptom

An otherwise correct client fails authentication after a pasted configuration
value contains a leading/trailing space, newline, wrong field format, or an
incorrect vendor slug.

### Mitigation

- Validate required non-secret settings at startup: broker base URL, expected
  audience/scope, vendor slug, and transport mode.
- Trim configuration values where doing so is unambiguous; reject malformed
  values with a field-specific error.
- Never echo a secret, authorization header, bearer token, or full connection
  string in a diagnostic or chat log.
- Prefer a broker preflight result over making operators infer failure from a
  downstream NinjaOne error.

## 6. Retry behavior must respect broker limits

### Symptom

Read-heavy discovery operations can receive `429` with `Retry-After`.

### Mitigation

- Treat `Retry-After` as authoritative.
- Use bounded retry with jitter for idempotent reads only.
- Do not automatically retry writes, script execution, or ticket updates unless
  the operation has an idempotency contract and an execution-status check.
- Surface rate-limit state to the caller so an agent does not spin on retries.

## Implementation checklist for a NinjaOne client

- [ ] Entra token audience/scope is configured and consented.
- [ ] Caller is assigned the exact enterprise-app role mapped to the NinjaOne
      vendor route.
- [ ] Broker Function managed identity, not the caller, reads the Key Vault
      secret.
- [ ] Client has no NinjaOne key, vendor OAuth secret, or Key Vault read role.
- [ ] Startup preflight uses a harmless endpoint and produces a correlation ID.
- [ ] `429` handling honors `Retry-After` and retries only safe reads.
- [ ] Diagnostics redact secrets, bearer tokens, and customer-specific IDs.

## Related documents

- [Sysadmin guide](SYSADMIN-GUIDE.md) — deployment, identity, caller assignment,
  and operational troubleshooting.
- [Automation and key control](automation-and-key-control.md) — credential
  boundaries and brokered automation.
- [Vendor integration matrix](vendor-integration-matrix.md) — supported vendor
  routing modes.
- [NinjaOne operator guide](ninjaone-operator-guide.md) — tenant-neutral
  authentication, authorization-chain, preflight, and health-probe guidance.

# NinjaOne operator guide

This guide describes the tenant-neutral broker contract for NinjaOne. Use the
placeholders shown here when documenting or configuring an environment; do not
put tenant identifiers, credentials, or vendor endpoints in client settings or
operator output.

## Authentication modes: Entra vs generic OIDC

Choose the documented authentication mode before onboarding the route. With
`AUTH_MODE=entra`, configure the Entra broker audience/scope and complete the
app-registration consent and any required admin-consent steps. Those
scope/consent instructions are Entra-specific.

For `generic/public OIDC`, use the issuer discovery and scope guidance supplied
for that provider instead. It is a distinct path from Entra: do not assume
Entra consent or app-registration steps apply to generic/public OIDC.

## Authorization chain and connection grants

The authorization chain is:

```text
caller identity -> enterprise-app role -> NinjaOne route -> connection grant
```

Holding the enterprise-app role is necessary but not sufficient. The route also
requires an explicit connection-grant record for `<vendor-route>`; it is a
separate layer after the role-to-route mapping. The broker, rather than the
caller, uses its managed identity for the server-side vendor credential.

## Authenticated preflight

Use the authenticated preflight as the authorization-proof path. Acquire the
broker token for `api://<broker-app-id>/.default`, then call the authenticated
preflight at `https://<broker-host>/api/broker/preflight/<vendor-route>`. Surface only the HTTP status and
`<correlation-id>` to the operator; never include a credential or token in the
result.

Do not make a live remediation or script action the first proof that a client
is authorized. The preflight establishes authorization without using it as an
opportunity to perform remediation.

## Supported-state prerequisites

NinjaOne is unsupported until its provider profile, deployment mapping, and
connection-grant record all exist for `<vendor-route>`. A missing link fails
closed and is reported as missing configuration, not silently treated as an
authorization denial.

## Unauthenticated health probes and the allow-list

The default authorization-proof path is the authenticated preflight. An
unauthenticated availability or health probe is permitted only when the
deployment makes and documents an explicit allow-list decision. Do not treat an
unauthenticated probe as a substitute for the authenticated authorization
check.

## Operator checklist

- [ ] Select the auth mode and apply its matching scope/consent guidance.
- [ ] Verify the role, `<vendor-route>`, and connection-grant record chain.
- [ ] Verify the provider profile and deployment mapping before enabling the route.
- [ ] Run authenticated preflight and retain only HTTP status and `<correlation-id>`.
- [ ] Document any exceptional unauthenticated probe as an explicit allow-list decision.

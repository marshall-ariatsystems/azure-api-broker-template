# Managed-service vendor integration matrix

These are broker targets, not client integrations. An application still talks only to its local
`broker-bridge`, receives `broker-managed` where a familiar SDK expects a key, and never receives
the value the broker uses with the vendor.

| Target | Broker route | Vendor auth held server-side | Current integration path |
|---|---|---|---|
| Microsoft Graph | `graph` | Entra workload token for `https://graph.microsoft.com/.default` | Supported by `entra` injection; grant Graph application permissions to the Function workload identity. |
| NinjaOne | `ninjaone` | OAuth client ID and secret | Use `oauth2cc` after the NinjaOne tenant region, OAuth token URL, and scope are supplied during onboarding. |
| IT Glue | `itglue` | API key injected as `x-api-key` | Supported now by header injection; choose the global, EU, or AU API base URL during onboarding. |
| Meraki Dashboard API v1 | `meraki` | Dashboard API key as a Bearer token, or an OAuth token | Broker-held API-key mode works now. Prefer an organization-scoped OAuth token provider when available. |
| Datto RMM | `datto-rmm` | API key and API secret exchanged through Datto OAuth | Needs an authorization-code/refresh-token provider; do not force Datto RMM into the client-credentials path. |
| CIPP API | `cipp` | Entra app client ID and secret | Use `oauth2cc` against the tenant's Entra token endpoint with the CIPP API scope. |

## Onboarding rule

Use `cicd/onboard-vendor.sh` only with environment-supplied secret material. The command writes a
Key Vault secret, adds an Entra app role, and updates the broker role map; no credential belongs in a
bridge profile, application `.env`, source file, log, or command-line argument.

For the supported injection modes, see [`cicd/onboarding-runbook.md`](../cicd/onboarding-runbook.md).
The non-secret machine-readable source of this table is
[`providers/azure/vendor-profiles.json`](../providers/azure/vendor-profiles.json).

## Vendor notes

- [Microsoft Graph application authentication](https://learn.microsoft.com/graph/auth-v2-service) uses an Entra access token and the `Authorization: Bearer` header. The broker should acquire it with its workload identity rather than store a Graph key.
- [IT Glue authentication](https://api.itglue.com/developer) requires `x-api-key`; the broker injects it and strips any caller copy.
- [Meraki Dashboard API v1 authorization](https://developer.cisco.com/meraki/api-v1/authorization/) supports app-scoped OAuth and admin-scoped API keys. Current v1 requests use `Authorization: Bearer`, not the retired v0-only header convention.
- [Datto RMM API authentication](https://rmm.datto.com/help/en/Content/2SETUP/APIv2.htm) uses OAuth and account-specific API credentials. Its authorization-code flow is not interchangeable with `oauth2cc`.
- [CIPP API setup and authentication](https://docs.cipp.app/api-documentation/setup-and-authentication) uses an Entra client-credentials token for the configured API client and scope.

<!-- execution-directive -->
Status: APPROVED
Gated-Paths:
  - spec/broker-bridge-build-spec.md

# Identity-provider product package specification update

## Objective

Update the Broker Bridge build specification to describe the agreed first-product architecture:

- The local package is stateless. It stores no API credentials, connection profiles, refresh tokens,
  or other persistent product data.
- The local package authenticates directly with the configured identity provider, or is registered
  there as a public OIDC client using PKCE and no client secret.
- A remotely hosted broker holds vendor credentials and centralizes one authorization decision:
  whether an authenticated identity may use a named API-key connection. It does not implement or
  infer vendor API permission scopes.
- When no application registration exists, administrators receive an identity-provider-specific,
  non-secret registration package. Marketplace integrations are an additional distribution path,
  not a product dependency.
- FIDO2-only access is an eventual release gate. The specification must reserve the identity
  assurance contract while deferring implementation detail.

## Required specification changes

1. Replace local `broker.env` as the product source of truth with ephemeral discovery/bootstrap
   configuration that contains no persisted credentials or tokens.
2. Add first-class concepts for identity providers, API-key connections, and identity-to-connection
   access grants.
3. Define IdP onboarding: verified marketplace integration, private registration package, and
   generic OIDC fallback.
4. Specify token, authorization, rate-limit, and audit behavior under the new identity-to-connection
   gate.
5. Recast product phases and acceptance criteria around a signed stateless local package and hosted
   broker, while preserving existing bridge compatibility where it remains useful.

## Out of scope

- Local hosting and local persistent secret storage.
- Vendor API permission-scope enforcement.
- Detailed FIDO2 implementation mechanics.

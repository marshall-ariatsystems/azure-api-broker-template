# Tessera build SDK

Small, dependency-free contracts shared across Tessera build surfaces. It is intentionally
not a product API or a vendor adapter.

- `requireObject` and `rejectUnknownKeys`: fail-closed JSON-schema primitives.
- `normalizeIssuer` and `requireHttpsIssuer`: issuer canonicalization and validation.
- `canonicalJson`: stable JSON serialization for signatures and fixtures.
- `deepFreeze`: immutable fixture/result construction.

CommonJS services use `require('../../sdk')`; ESM consumers use
`import sdk from '../../sdk/index.js'`. Keep this package side-effect free and add a helper only
after it has at least two production consumers.

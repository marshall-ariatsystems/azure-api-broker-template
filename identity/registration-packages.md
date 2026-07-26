# Registration packages

A registration package is an inspectable `formatVersion: 1` envelope containing non-secret metadata and policy only. Its content has `id`, `displayName`, `discovery`, `redirectUris`, `resource`, `claims`, `assurance`, and `bootstrap`. The envelope carries an Ed25519 signature over canonical JSON (object keys sorted at every level).

Before import, an operator uses `inspectRegistrationPackage` to inspect every requested content field, the signature state, and the signing-key fingerprint. A secret-like field fails validation; packages never carry client secrets, tokens, or credentials.

The same package supports marketplace catalog installation, a private registration document, and generic OIDC setup. These three paths converge on the same hosted-broker token and claim contract.

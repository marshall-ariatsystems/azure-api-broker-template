# Azure reference provider

This is the boundary for the first broker provider: Microsoft Entra authentication, the Azure
Functions broker, Key Vault secret retrieval and injection, quotas, audit logging, and Azure IaC.

The active implementation remains in `function-node/`, `iac/`, `identity/`, and `observability/`.
Product-core code must depend on the profile contract, not Azure-specific authorization semantics.

[`vendor-profiles.json`](vendor-profiles.json) records the non-secret integration shape for
Microsoft Graph, Salesforce, IT Glue, Meraki, Datto RMM, and CIPP. It is the source for onboarding
work; it must never grow into a credential store.

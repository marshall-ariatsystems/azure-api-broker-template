# Azure reference provider

This is the boundary for the first broker provider: Microsoft Entra authentication, the Azure
Functions broker, Key Vault secret retrieval and injection, quotas, audit logging, and Azure IaC.

The active implementation remains in `function-node/`, `iac/`, `identity/`, and `observability/`.
Product-core code must depend on the profile contract, not Azure-specific authorization semantics.

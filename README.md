# Azure API Broker Template

A white-label Azure API-key broker with an Entra-governed operator console. Applications call the broker instead of upstream vendors; the broker checks the caller’s enterprise-app role and exact connection grant, reads the mapped credential from Key Vault through managed identity, and injects it server-side.

Vendor credentials never need to be distributed to laptops, repositories, CI systems, or calling applications.

## What is included

- Entra enterprise applications for broker invocation and administration
- user, group, and workload connection grants
- write-only credential rotation into Azure Key Vault
- endpoint allow/deny policy, credential scrubbing, quotas, and redacted audit events
- an accessible, responsive control plane adapted from the `api_gadget` interface
- safe runtime branding with validated names, URLs, logos, and color tokens
- versioned `/api/v1` management contracts and versioned policy documents
- independent broker and admin/UI deployments
- a scale-to-zero Azure Functions Essentials profile

## Deploy

Prerequisites are Azure CLI, Azure Developer CLI, Node.js 22, and permission to create Entra applications, service principals, Azure role assignments, and the planned resources.

```bash
azd auth login
azd init --template marshall-ariatsystems/azure-api-broker-template
azd env set AZURE_LOCATION eastus2
azd env set AZURE_TAG_COST_CENTER '<cost center>'
azd env set AZURE_TAG_OWNER '<owner>'
azd env set AZURE_TAG_WORKLOAD 'api-broker'
azd env set AZURE_TAG_ENVIRONMENT 'production'
azd up
```

The preprovision hook validates the selected account, Flex Consumption Node.js 22 support, required tags, and resource-provider registration without changing Azure provider state. It idempotently reconciles two Entra applications without creating client credentials. Bicep then provisions the Azure resources and AZD deploys the two Function packages.

Open the emitted `AZURE_ADMIN_URL`. The deploying user receives the `Broker.Operator` role on the admin enterprise application.

### Portal button

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fmarshall-ariatsystems%2Fazure-api-broker-template%2Fmain%2Finfra%2Fazuredeploy.json)

The portal path is the one-click deployment path. It provisions the infrastructure, creates the broker and admin Entra applications through Microsoft Graph Bicep, assigns the supplied operator object ID to `Broker.Operator`, configures Easy Auth, and deploys the versioned Function packages from the release assets. The first screen asks for the target resource group, environment, tags, and operator object ID. The deploying identity must have Azure deployment permissions plus the least-privileged Microsoft Graph permissions required to create applications, service principals, and the app-role assignment.

The package URI parameters default to the current release assets. For a private fork or an internal release, override `brokerPackageUri` and `adminPackageUri` with public or SAS-backed ZIP URLs. Set either parameter to an empty string when an infrastructure-only deployment is intentional. `azd up` remains the developer-oriented path and continues to run the preflight checks before provisioning.

## Day-two updates

Application updates do not repeat tenant setup:

```bash
azd deploy admin   # management API and embedded frontend
azd deploy broker  # request broker only
```

Run `azd provision` only for an intentional infrastructure revision. Stored-policy releases use a plan/apply migration:

```bash
node deploy/migrate.mjs plan \
  --account "$(azd env get-value AZURE_STORAGE_ACCOUNT_NAME)" --release v0.2.0
node deploy/migrate.mjs apply \
  --account "$(azd env get-value AZURE_STORAGE_ACCOUNT_NAME)" --release v0.2.0
```

The migration snapshots non-secret policy documents and never reads Key Vault. See [UPGRADES.md](docs/UPGRADES.md).

## Authorization model

A connection is usable only when both gates pass:

1. The token contains the connection’s `VendorApi.<Vendor>.Invoke` app role.
2. The caller’s user, group, or workload identifier appears in that connection’s policy grant.

Administration similarly requires successful Entra authentication and the `Broker.Operator` app role. Assign connection roles and admin roles to users, groups, or service principals in the corresponding Entra enterprise application. Group-overage tokens fail closed; prefer app-role assignments to Entra groups rather than broad raw group claims.

For each new vendor connection, reconcile its enterprise-app role before assigning callers:

```bash
node scripts/identity/connection-role.mjs plan --vendor example-vendor
node scripts/identity/connection-role.mjs apply --vendor example-vendor
```

Assign the resulting app role to an Entra user, group, or service principal, then add the same principal to the connection grant in the console. The UI displays both the role and policy-grant boundary.

## Credential boundary

- The admin identity can create new Key Vault secret versions but the API never returns their values.
- The broker identity reads mapped Key Vault credentials to inject them upstream.
- Callers receive only upstream responses.
- Branding and application updates keep connection IDs and Key Vault secret names stable.
- No application client secret is created by deployment automation.

The Essentials template currently scopes broker secret read access at the vault level so newly added connections work without reprovisioning RBAC. Tenants needing per-secret RBAC should use the controlled connection-provisioning workflow before production onboarding.

## Cost model

The default profile uses:

- two Flex Consumption Function Apps with zero always-ready instances;
- one Storage account for Functions packages, policy, quota, and audit tables;
- one Standard Key Vault; and
- one shared Log Analytics workspace and Application Insights component.

It excludes APIM, NAT Gateway, App Configuration, dedicated plans, VNets, and private endpoints. The default maximum burst is 15 cores across both apps, below the standard regional Flex Consumption allowance. Monitoring ingestion and retention remain usage-sensitive. See [COSTS.md](docs/COSTS.md).

## Repository map

| Path | Responsibility |
|---|---|
| `function-node/` | broker runtime and request security |
| `admin-function/` | versioned operator API and embedded frontend |
| `clients/bridge/` | keyless local compatibility bridge |
| `infra/` | Essentials AZD/Bicep deployment |
| `scripts/identity/` | idempotent Entra reconciliation |
| `deploy/migrate.mjs` | policy schema plan/apply and snapshots |
| `iac/` | retained private-network reference implementation |

The untracked experimental `minimal-proxy/` design is deliberately excluded because Function keys and app-setting vendor secrets do not satisfy the Entra and Key Vault trust boundary.

## Verify

```bash
npm --prefix function-node test
npm --prefix admin-function test
npm --prefix deploy test
az bicep build --file infra/main.bicep --stdout >/dev/null
node --check scripts/preflight.mjs
node --check scripts/identity/reconcile.mjs
node --check scripts/identity/connection-role.mjs
node --check deploy/migrate.mjs
```

Before provisioning into an Azure environment, run subscription-scope validation and what-if. No deployment should proceed with policy, RBAC, provider, or capacity errors.

## Security

Report vulnerabilities according to [SECURITY.md](SECURITY.md). Generated AZD environment state, deployment outputs, credentials, tokens, and tenant-specific identifiers must not be committed.

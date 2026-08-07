# Deploy Tessera

Tessera deploys a private API broker, Entra-protected Admin UI, Key Vault, policy store, audit storage, and the operator management CLI from one tenant-neutral configuration file.

The deployment creates no vendor credential, vendor role, or access grant. Those are explicit post-deployment operator actions.

## Prerequisites

- Node.js 22 or newer, Azure CLI, npm, and zip.
- An Azure identity that can create a resource group and resources, assign Azure RBAC roles, and create Microsoft Entra application registrations and enterprise applications.
- A selected Azure region with Azure Functions Flex Consumption, Private Link, Key Vault, App Configuration, Storage, and Application Insights available.
- A non-overlapping RFC 1918 address range, split into three separate subnets: broker integration, private endpoints, and Admin integration.
- At least one explicit public CIDR for the operator console. Tessera rejects an allow-all CIDR.

## Quick start

Copy the configuration example outside the repository or give it an ignored filename. Fill only your own deployment inputs.

```bash
cp deploy/config.example.json tessera.production.json
node deploy/tessera.mjs doctor --config tessera.production.json
node deploy/tessera.mjs deploy --config tessera.production.json
```

The deploy command writes a local, mode-0600 state file under `.tessera/`. It contains resource identifiers and public endpoint metadata only; it never contains a Key Vault value, refresh token, Azure client secret, or connection string.

## What the deployer does

1. Verifies the selected Azure subscription, required Azure CLI tools, and resource-provider registration.
2. Creates an isolated VNet and the resource group selected in the input file.
3. Creates separate Entra applications for the broker and operator console, including the operator role and browser sign-in support.
4. Deploys the broker foundation and private dependencies with managed identities and least-privilege roles.
5. Deploys the management Function, its App Configuration policy store, empty policy documents, and its separate identity.
6. Packages both Node Functions, deploys them, and restores the broker’s private-only network posture.
7. Saves redacted deployment outputs for subsequent CLI management commands.

## Operator CLI

Use the generated state file for operator commands:

```bash
node deploy/tessera.mjs outputs --state .tessera/production.json
node deploy/tessera.mjs key plan --state .tessera/production.json --vendor example-vendor --name production --type api_key
node deploy/tessera.mjs vendor add --state .tessera/production.json --id example-vendor --name "Example Vendor" --auth api-key
node deploy/tessera.mjs vendor provision --state .tessera/production.json --id example-vendor --name "Example Vendor" --auth api-key --base-url https://api.example.invalid --secret-file ./vendor-credential.txt
node deploy/tessera.mjs principal set --state .tessera/production.json --id user:<object-id> --name "Operator Name"
node deploy/tessera.mjs grant --state .tessera/production.json --connection azure:example-vendor --kind user --subject user:<object-id>
```

`key plan` is intentionally non-mutating. `vendor provision` is the explicit bootstrap action: it adds the broker app role, writes the credential from a local file (never a command-line argument), gives the broker managed identity read access scoped to that secret, and creates the non-secret vendor/profile mapping. The Admin UI then provides the write-only credential rotation and access-management workflow.

## Network and deployment gotchas

- Flex Consumption uses OneDeploy, a deployment storage container, and system-assigned identity. The ZIP must be named `released-package.zip`; generic Web Apps deployment endpoints return HTTP 415. The deployer uses a short-lived user-delegation URL passed in a mode-0600 parameter file and removes the staging blob after publish.
- Storage firewall changes are eventually consistent. The deployer briefly enables its deployment transport, waits for propagation, and restores public access to Disabled/default action Deny even when package staging fails.
- Publish before attaching a Function App Private Endpoint. If both OneDeploy and Azure Functions Core Tools stall after upload, inspect the Microsoft.Web deployment operation for a gateway timeout, restore the temporary network restrictions, and retry only after the Azure service-side operation is no longer active. Do not start a competing publish against the same app.
- Private Endpoint and Function integration cannot use the same subnet. Private DNS must be resolvable from each operator and workload network.
- App Configuration key-values are a data-plane operation even when declared in ARM. Tessera enables its endpoint only long enough to bootstrap empty policy documents, with local authentication disabled, then turns public access off before application deployment.
- The broker is private-only after deployment. The deployer momentarily enables its deployment endpoint while the existing CIDR restriction remains in effect, then restores private-only access.
- The Admin UI uses Entra sign-in and a CIDR allow-list. It is not intended to be publicly discoverable or unauthenticated.
- Browser sign-in needs the Entra application to permit ID-token issuance; API calls use an access token with the `user_impersonation` scope.
- Azure RBAC and private DNS propagation can take time. Re-run `doctor` and inspect Azure deployment operation output before changing policy settings.
- Do not commit `.tessera/`, local configuration files, deployment parameter files, or generated package archives.

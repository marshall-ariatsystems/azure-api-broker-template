// iac/keyvault.bicep
// A2 — Key Vault secrets + least-privilege RBAC for the Function managed identity.
//
// Design owner: spec §6 (Key storage and injection), §6.1 (least-privilege MI), §8 (rotation).
//
// Function broker vs APIM: there are NO APIM named values. The broker Function reads the real vendor
// key directly from Key Vault via SecretClient + system-assigned MI. The MI holds
// `Key Vault Secrets User` scoped to ONLY the vendor-key secrets (not the whole vault).
//
// LEAST-PRIVILE CONTROL (spec §6.1, council fix): RBAC is scoped to the specific vendor-key
// secrets, not the whole vault, so even a compromised broker cannot read unrelated secrets.
//
// Inputs are emitted to generated local deployment state: keyVaultName and identityPrincipalId.
// Inputs (from A3 identity/app-roles.json): the roleToSecretName mapping (source of secret names).
//
// Microsoft Learn citations:
// - Key Vault secrets: https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets
// - Key Vault RBAC guide: https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide
// - Key Vault as Event Grid source (rotation cache-bust): https://learn.microsoft.com/en-us/azure/key-vault/general/event-grid-overview
// - Built-in roles: https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles

@description('Existing Key Vault name (created in foundation.bicep).')
param keyVaultName string

@description('Function app system-assigned managed identity principalId from generated local deployment state.')
param functionPrincipalId string

@description('Names of the vendor secrets used by the enabled broker routes.')
param vendorSecretNames array

@secure()
@description('Object mapping every vendorSecretNames entry to its value. Supply only at deployment time.')
param vendorSecretValues object

// ----------------------------------------------------------------------------
// Existing Key Vault (created in foundation.bicep)
// ----------------------------------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// ----------------------------------------------------------------------------
// Vendor-key secrets. Names are derived from the route map enabled for this
// deployment; values are secure deployment parameters and are intentionally
// neither committed nor written to application settings or deployment output.
// ----------------------------------------------------------------------------
resource vendorSecrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [for secretName in vendorSecretNames: {
  parent: kv
  name: secretName
  properties: {
    value: vendorSecretValues[secretName]
    contentType: 'text/plain'
  }
}]

// ----------------------------------------------------------------------------
// LEAST-PRIVILEGE RBAC: Key Vault Secrets User scoped to ONLY the vendor-key secrets.
// spec §6.1: "grant the Function's system-assigned identity Key Vault Secrets User
//   scoped to ONLY the specific vendor-key secrets — not the whole vault."
// Built-in role definition id for 'Key Vault Secrets User':
//   4633458b-17da-40b1-a1bf-6a0c6012aae7
// https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#key-vault-secrets-user
// ----------------------------------------------------------------------------
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource rbacVendorSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (secretName, i) in vendorSecretNames: {
  name: guid(kv.id, functionPrincipalId, secretName, 'secrets-user')
  scope: vendorSecrets[i] // SCOPED TO THE SECRET — not the vault (least privilege)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}]

// ----------------------------------------------------------------------------
// (Optional) Event Grid subscription on SecretNewVersionCreated — busts the
// Function cache immediately on rotation (spec §8 — faster than APIM's 4h refresh).
// Wires to the CacheBust function endpoint.
// Implemented as a runbook step in identity/grant-revoke-runbook.md.
// so the admin controls the wiring (no surprise subscriptions).
// https://learn.microsoft.com/en-us/azure/key-vault/general/event-grid-tutorial
// ----------------------------------------------------------------------------

output keyVaultName string = kv.name
output vendorSecretNames array = vendorSecretNames
output functionPrincipalId string = functionPrincipalId
output roleAssigned string = 'Key Vault Secrets User (scoped to vendor-key secrets only)'

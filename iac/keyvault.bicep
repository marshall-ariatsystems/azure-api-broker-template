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
// Inputs (from A1 iac/outputs.json): keyVaultName, identityPrincipalId, identityTenantId.
// Inputs (from A3 identity/app-roles.json): the roleToSecretName mapping (source of secret names).
//
// Microsoft Learn citations:
// - Key Vault secrets: https://learn.microsoft.com/en-us/azure/key-vault/secrets/about-secrets
// - Key Vault RBAC guide: https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide
// - Key Vault as Event Grid source (rotation cache-bust): https://learn.microsoft.com/en-us/azure/key-vault/general/event-grid-overview
// - Built-in roles: https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles

@description('Existing Key Vault name (created in foundation.bicep).')
param keyVaultName string

@description('Function app system-assigned managed identity principalId (from iac/outputs.json).')
param functionPrincipalId string

// ----------------------------------------------------------------------------
// Existing Key Vault (created in foundation.bicep)
// ----------------------------------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// ----------------------------------------------------------------------------
// Vendor-key secrets — one per role, names reveal purpose not value (spec §6.1).
// Values are PLACEHOLDERS: the admin sets the REAL vendor key out-of-band (never in IaC).
// The IaC only creates the secret slot so RBAC scoping can bind to it.
// ----------------------------------------------------------------------------
resource secretTeamA 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'vendor-api-key-team-a'
  properties: {
    value: 'REPLACE-WITH-REAL-VENDOR-KEY-A-OUT-OF-BAND' // PLACEHOLDER — admin sets real value; never commit a real key
    contentType: 'text/plain'
  }
}

resource secretTeamB 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'vendor-api-key-team-b'
  properties: {
    value: 'REPLACE-WITH-REAL-VENDOR-KEY-B-OUT-OF-BAND'
    contentType: 'text/plain'
  }
}

resource secretCi 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'vendor-api-key-ci'
  properties: {
    value: 'REPLACE-WITH-REAL-VENDOR-KEY-CI-OUT-OF-BAND'
    contentType: 'text/plain'
  }
}

resource secretCanary 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: 'vendor-api-key-canary'
  properties: {
    value: 'REPLACE-WITH-REAL-VENDOR-KEY-CANARY-OUT-OF-BAND'
    contentType: 'text/plain'
  }
}

// ----------------------------------------------------------------------------
// LEAST-PRIVILEGE RBAC: Key Vault Secrets User scoped to ONLY the vendor-key secrets.
// spec §6.1: "grant the Function's system-assigned identity Key Vault Secrets User
//   scoped to ONLY the specific vendor-key secrets — not the whole vault."
// Built-in role definition id for 'Key Vault Secrets User':
//   4633458b-17da-40b1-a1bf-6a0c6012aae7
// https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#key-vault-secrets-user
// ----------------------------------------------------------------------------
var keyVaultSecretsUserRoleId = '4633458b-17da-40b1-a1bf-6a0c6012aae7'

resource rbacTeamA 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, functionPrincipalId, secretTeamA.name, 'secrets-user')
  scope: secretTeamA // SCOPED TO THE SECRET — not the vault (least privilege)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource rbacTeamB 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, functionPrincipalId, secretTeamB.name, 'secrets-user')
  scope: secretTeamB
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource rbacCi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, functionPrincipalId, secretCi.name, 'secrets-user')
  scope: secretCi
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource rbacCanary 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, functionPrincipalId, secretCanary.name, 'secrets-user')
  scope: secretCanary
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ----------------------------------------------------------------------------
// (Optional) Event Grid subscription on SecretNewVersionCreated — busts the
// Function cache immediately on rotation (spec §8 — faster than APIM's 4h refresh).
// Wires to the CacheBust function endpoint.
// Implemented as a runbook step in identity/grant-revoke-runbook.md.
// so the admin controls the wiring (no surprise subscriptions).
// https://learn.microsoft.com/en-us/azure/key-vault/general/event-grid-tutorial
// ----------------------------------------------------------------------------

output keyVaultName string = kv.name
output vendorSecretNames array = [secretTeamA.name, secretTeamB.name, secretCi.name, secretCanary.name]
output functionPrincipalId string = functionPrincipalId
output roleAssigned string = 'Key Vault Secrets User (scoped to vendor-key secrets only)'

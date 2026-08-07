param location string
@minLength(2)
@maxLength(20)
param environmentName string
param tags object
param brokerClientId string
param adminClientId string
param tenantId string
param brokerMaximumInstances int
param adminMaximumInstances int
param alwaysReadyInstances int

var suffix = uniqueString(resourceGroup().id, environmentName)
var prefix = 'apib-${environmentName}'
var storageName = take(replace('${prefix}${suffix}', '-', ''), 24)
var vaultName = take('${prefix}-${suffix}-kv', 24)
var brokerName = take('${prefix}-${suffix}-broker', 60)
var adminName = take('${prefix}-${suffix}-admin', 60)
var entraIssuer = '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
var blobOwnerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
var tableContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
var queueContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
var secretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
var secretsOfficerRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  #disable-next-line BCP334
  name: storageName
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: { defaultAction: 'Allow', bypass: 'AzureServices' }
  }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = { parent: storage, name: 'default' }
resource brokerPackages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = { parent: blobService, name: 'brokerpackages', properties: { publicAccess: 'None' } }
resource adminPackages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = { parent: blobService, name: 'adminpackages', properties: { publicAccess: 'None' } }
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = { parent: storage, name: 'default' }
resource policyTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = { parent: tableService, name: 'brokerPolicy' }
resource quotaTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = { parent: tableService, name: 'brokerRateLimits' }
resource auditTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = { parent: tableService, name: 'brokerAudit' }

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-${suffix}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-${suffix}-insights'
  location: location
  tags: tags
  kind: 'web'
  properties: { Application_Type: 'web', IngestionMode: 'LogAnalytics', WorkspaceResourceId: workspace.id }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

resource brokerPlan 'Microsoft.Web/serverfarms@2024-04-01' = { name: '${brokerName}-plan', location: location, tags: tags, kind: 'functionapp', sku: { name: 'FC1', tier: 'FlexConsumption' }, properties: { reserved: true } }
resource adminPlan 'Microsoft.Web/serverfarms@2024-04-01' = { name: '${adminName}-plan', location: location, tags: tags, kind: 'functionapp', sku: { name: 'FC1', tier: 'FlexConsumption' }, properties: { reserved: true } }

resource broker 'Microsoft.Web/sites@2024-04-01' = {
  name: brokerName
  location: location
  tags: union(tags, { 'azd-service-name': 'broker' })
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: brokerPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: { minTlsVersion: '1.2', ftpsState: 'Disabled', http20Enabled: true }
    functionAppConfig: {
      runtime: { name: 'node', version: '22' }
      scaleAndConcurrency: {
        maximumInstanceCount: brokerMaximumInstances
        instanceMemoryMB: 2048
        alwaysReady: alwaysReadyInstances == 0 ? [] : [{ name: 'http', instanceCount: alwaysReadyInstances }]
      }
      deployment: { storage: { type: 'blobContainer', value: '${storage.properties.primaryEndpoints.blob}${brokerPackages.name}', authentication: { type: 'SystemAssignedIdentity' } } }
    }
  }
}
resource admin 'Microsoft.Web/sites@2024-04-01' = {
  name: adminName
  location: location
  tags: union(tags, { 'azd-service-name': 'admin' })
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: adminPlan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    siteConfig: { minTlsVersion: '1.2', ftpsState: 'Disabled', http20Enabled: true }
    functionAppConfig: {
      runtime: { name: 'node', version: '22' }
      scaleAndConcurrency: {
        maximumInstanceCount: adminMaximumInstances
        instanceMemoryMB: 2048
        alwaysReady: alwaysReadyInstances == 0 ? [] : [{ name: 'http', instanceCount: alwaysReadyInstances }]
      }
      deployment: { storage: { type: 'blobContainer', value: '${storage.properties.primaryEndpoints.blob}${adminPackages.name}', authentication: { type: 'SystemAssignedIdentity' } } }
    }
  }
}

resource brokerSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: broker
  name: 'appsettings'
  properties: {
    KEYVAULT_URI: vault.properties.vaultUri
    POLICY_STORAGE_ACCOUNT: storage.name
    POLICY_TABLE_NAME: policyTable.name
    POLICY_KEY_PREFIX: 'broker'
    POLICY_CACHE_TTL_SECONDS: '15'
    RATE_LIMIT_STORAGE_ACCOUNT: storage.name
    RATE_LIMIT_TABLE_NAME: quotaTable.name
    RATE_LIMIT_FAIL_MODE: 'closed'
    QUOTA_CALLER_PER_MIN: '60'
    QUOTA_KEY_PER_MIN: '600'
    BROKER_AUDIT_STORAGE_ACCOUNT: storage.name
    BROKER_AUDIT_TABLE_NAME: auditTable.name
    SECRET_CACHE_TTL_SECONDS: '300'
    ROLE_SECRET_MAP: '{}'
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
    AzureWebJobsStorage: ''
    AzureWebJobsStorage__accountName: storage.name
    AzureWebJobsStorage__credential: 'managedidentity'
  }
}
resource adminSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: admin
  name: 'appsettings'
  properties: {
    KEYVAULT_URI: vault.properties.vaultUri
    POLICY_STORAGE_ACCOUNT: storage.name
    POLICY_TABLE_NAME: policyTable.name
    POLICY_KEY_PREFIX: 'broker'
    AUDIT_STORAGE_ACCOUNT: storage.name
    AUDIT_TABLE_NAME: auditTable.name
    OPERATOR_ROLE: 'Broker.Operator'
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
    AzureWebJobsStorage: ''
    AzureWebJobsStorage__accountName: storage.name
    AzureWebJobsStorage__credential: 'managedidentity'
  }
}

resource brokerAuth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: broker
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: { requireAuthentication: true, unauthenticatedClientAction: 'Return401', excludedPaths: [] }
    httpSettings: { requireHttps: true, forwardProxy: { convention: 'NoProxy' } }
    identityProviders: { azureActiveDirectory: { enabled: true, registration: { openIdIssuer: entraIssuer, clientId: brokerClientId }, validation: { allowedAudiences: [brokerClientId, 'api://${brokerClientId}'], defaultAuthorizationPolicy: { allowedApplications: [], allowedPrincipals: {} } } } }
  }
}
resource adminAuth 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: admin
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: { requireAuthentication: true, unauthenticatedClientAction: 'RedirectToLoginPage', excludedPaths: [] }
    httpSettings: { requireHttps: true, forwardProxy: { convention: 'NoProxy' } }
    identityProviders: { azureActiveDirectory: { enabled: true, registration: { openIdIssuer: entraIssuer, clientId: adminClientId }, validation: { allowedAudiences: [adminClientId, 'api://${adminClientId}'], defaultAuthorizationPolicy: { allowedApplications: [], allowedPrincipals: {} } } } }
  }
}

resource brokerBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(storage.id, broker.id, 'blob'), scope: storage, properties: { roleDefinitionId: blobOwnerRole, principalId: broker.identity.principalId, principalType: 'ServicePrincipal' } }
resource brokerTable 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(storage.id, broker.id, 'table'), scope: storage, properties: { roleDefinitionId: tableContributorRole, principalId: broker.identity.principalId, principalType: 'ServicePrincipal' } }
resource brokerQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(storage.id, broker.id, 'queue'), scope: storage, properties: { roleDefinitionId: queueContributorRole, principalId: broker.identity.principalId, principalType: 'ServicePrincipal' } }
resource brokerSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(vault.id, broker.id, 'secrets-user'), scope: vault, properties: { roleDefinitionId: secretsUserRole, principalId: broker.identity.principalId, principalType: 'ServicePrincipal' } }
resource adminBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(storage.id, admin.id, 'blob'), scope: storage, properties: { roleDefinitionId: blobOwnerRole, principalId: admin.identity.principalId, principalType: 'ServicePrincipal' } }
resource adminTable 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(storage.id, admin.id, 'table'), scope: storage, properties: { roleDefinitionId: tableContributorRole, principalId: admin.identity.principalId, principalType: 'ServicePrincipal' } }
resource adminQueue 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(storage.id, admin.id, 'queue'), scope: storage, properties: { roleDefinitionId: queueContributorRole, principalId: admin.identity.principalId, principalType: 'ServicePrincipal' } }
resource adminSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = { name: guid(vault.id, admin.id, 'secrets-officer'), scope: vault, properties: { roleDefinitionId: secretsOfficerRole, principalId: admin.identity.principalId, principalType: 'ServicePrincipal' } }

output brokerName string = broker.name
output brokerUrl string = 'https://${broker.properties.defaultHostName}'
output adminName string = admin.name
output adminUrl string = 'https://${admin.properties.defaultHostName}/console'
output storageAccountName string = storage.name
output keyVaultName string = vault.name

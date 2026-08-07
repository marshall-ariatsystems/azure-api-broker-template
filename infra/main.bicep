targetScope = 'subscription'

@description('Resource group that contains one broker environment.')
param resourceGroupName string
param location string
@minLength(2)
@maxLength(20)
param environmentName string
param tags object
param brokerClientId string
param adminClientId string
param tenantId string = tenant().tenantId
@description('Maximum broker burst instances. A 2 GiB instance is one core.')
@minValue(1)
@maxValue(1000)
param brokerMaximumInstances int = 10
@description('Maximum admin burst instances. A 2 GiB instance is one core.')
@minValue(1)
@maxValue(1000)
param adminMaximumInstances int = 5
@description('Always-ready instances. Zero keeps the Essentials profile scale-to-zero.')
@minValue(0)
param alwaysReadyInstances int = 0

resource rg 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module resources 'resources.bicep' = {
  name: 'api-broker-${environmentName}'
  scope: rg
  params: {
    location: location
    environmentName: environmentName
    tags: tags
    brokerClientId: brokerClientId
    adminClientId: adminClientId
    tenantId: tenantId
    brokerMaximumInstances: brokerMaximumInstances
    adminMaximumInstances: adminMaximumInstances
    alwaysReadyInstances: alwaysReadyInstances
  }
}

output brokerName string = resources.outputs.brokerName
output brokerUrl string = resources.outputs.brokerUrl
output adminName string = resources.outputs.adminName
output adminUrl string = resources.outputs.adminUrl
output storageAccountName string = resources.outputs.storageAccountName
output keyVaultName string = resources.outputs.keyVaultName
output AZURE_BROKER_NAME string = resources.outputs.brokerName
output AZURE_BROKER_URL string = resources.outputs.brokerUrl
output AZURE_ADMIN_NAME string = resources.outputs.adminName
output AZURE_ADMIN_URL string = resources.outputs.adminUrl
output AZURE_STORAGE_ACCOUNT_NAME string = resources.outputs.storageAccountName
output AZURE_KEY_VAULT_NAME string = resources.outputs.keyVaultName

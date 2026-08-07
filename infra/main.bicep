targetScope = 'subscription'

extension 'br:mcr.microsoft.com/bicep/extensions/microsoftgraph/v1.0:1.0.0'

@description('Resource group that contains one broker environment.')
param resourceGroupName string
param location string
@minLength(2)
@maxLength(20)
param environmentName string
param tags object
param tenantId string = tenant().tenantId
@description('Object ID of the first operator to receive the Broker.Operator app role.')
param operatorObjectId string
@description('Public or SAS URL for the broker Function package. Leave empty to provision infrastructure only.')
param brokerPackageUri string = 'https://github.com/marshall-ariatsystems/azure-api-broker-template/releases/download/v0.3.0/broker.zip?download=1'
@description('Public or SAS URL for the admin Function package. Leave empty to provision infrastructure only.')
param adminPackageUri string = 'https://github.com/marshall-ariatsystems/azure-api-broker-template/releases/download/v0.3.0/admin.zip?download=1'
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

var suffix = uniqueString(resourceId('Microsoft.Resources/resourceGroups', resourceGroupName), environmentName)
var prefix = 'apib-${environmentName}'
var adminName = take('${prefix}-${suffix}-admin', 60)
var brokerUniqueName = 'api-broker-${resourceGroupName}-${environmentName}-broker'
var adminUniqueName = 'api-broker-${resourceGroupName}-${environmentName}-admin'
var operatorRoleId = guid(tenant().tenantId, resourceGroupName, environmentName, 'Broker.Operator')

resource brokerApplication 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: brokerUniqueName
  displayName: 'Azure API Broker ${environmentName}'
  signInAudience: 'AzureADMyOrg'
}

resource brokerServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: brokerApplication.appId
}

resource adminApplication 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: adminUniqueName
  displayName: 'Azure API Broker Admin ${environmentName}'
  signInAudience: 'AzureADMyOrg'
  appRoles: [
    {
      allowedMemberTypes: ['User']
      description: 'Administer API broker connections, grants, branding, and write-only credential rotation.'
      displayName: 'Broker operator'
      id: operatorRoleId
      isEnabled: true
      value: 'Broker.Operator'
    }
  ]
  web: {
    redirectUris: [
      'https://${adminName}.azurewebsites.net/.auth/login/aad/callback'
    ]
    implicitGrantSettings: {
      enableIdTokenIssuance: true
      enableAccessTokenIssuance: false
    }
  }
}

resource adminServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: adminApplication.appId
}

resource operatorAssignment 'Microsoft.Graph/appRoleAssignedTo@v1.0' = {
  appRoleId: operatorRoleId
  principalId: operatorObjectId
  resourceDisplayName: adminApplication.displayName
  resourceId: adminServicePrincipal.id
}

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
    brokerClientId: brokerApplication.appId
    adminClientId: adminApplication.appId
    tenantId: tenantId
    brokerMaximumInstances: brokerMaximumInstances
    adminMaximumInstances: adminMaximumInstances
    alwaysReadyInstances: alwaysReadyInstances
    brokerPackageUri: brokerPackageUri
    adminPackageUri: adminPackageUri
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
output BROKER_CLIENT_ID string = brokerApplication.appId
output ADMIN_CLIENT_ID string = adminApplication.appId
output BROKER_APPLICATION_OBJECT_ID string = brokerApplication.id
output ADMIN_APPLICATION_OBJECT_ID string = adminApplication.id
output BROKER_SERVICE_PRINCIPAL_ID string = brokerServicePrincipal.id
output ADMIN_SERVICE_PRINCIPAL_ID string = adminServicePrincipal.id

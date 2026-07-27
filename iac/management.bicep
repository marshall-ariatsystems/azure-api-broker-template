// Private Azure-native operator layer for the existing Tessera broker.
// It deliberately has a separate managed identity from the broker: this identity
// can write Key Vault secrets and broker policy, but cannot read secret values.

param location string = resourceGroup().location
param namingSuffix string
param vnetName string
param integrationSubnetCidr string = '10.60.3.0/24'
@description('Existing private-endpoint subnet created by the foundation deployment.')
param privateEndpointSubnetName string
@allowed(['Enabled', 'Disabled'])
@description('Admin public endpoint posture. Enabled is safe only with one or more explicit operator CIDRs; the script rejects an empty allow-list in that mode.')
param adminPublicNetworkAccess string = 'Enabled'
@description('Explicit IPv4/IPv6 CIDRs allowed to reach the Entra-protected Admin UI. A deny-all rule is always appended.')
param operatorAllowedCidrs array = []
@allowed(['Enabled', 'Disabled'])
@description('App Configuration public endpoint posture. The deployer uses Enabled only while ARM creates the initial empty policy documents, then sets Disabled before application use.')
param appConfigPublicNetworkAccess string = 'Enabled'
param storageAccountName string
param keyVaultName string
param appInsightsConnectionString string
param brokerPrincipalId string
@description('Object ID of the interactive deployer. Used only to bootstrap empty policy documents through Entra data-plane access.')
param deployerPrincipalId string

var prefix = 'apibkr-${namingSuffix}'
var adminName = '${prefix}-admin'
var planName = '${prefix}-admin-plan'
var configName = '${prefix}-cfg'
var integrationSubnetName = '${prefix}-admin-integ-subnet'
var appConfigReaderRoleId = '516239f1-63e1-4d78-a4de-a74fb236a071'
var appConfigOwnerRoleId = '5ae67dd6-50cb-40e7-96ff-dc2bfa4b606b'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var tableContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var blobOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var queueContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var adminAllowedRules = [for (cidr, index) in operatorAllowedCidrs: {
    name: 'AllowOperator${index + 1}'
    ipAddress: cidr
    action: 'Allow'
    priority: 100 + index
    tag: 'Default'
  }]
var adminAccessRestrictions = concat(adminAllowedRules, [
  {
    name: 'DenyAllPublic'
    ipAddress: '0.0.0.0/0'
    action: 'Deny'
    priority: 2147483647
    tag: 'Default'
  }
])

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = { name: vnetName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
resource peSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: privateEndpointSubnetName
}

resource integrationSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: integrationSubnetName
  properties: {
    addressPrefix: integrationSubnetCidr
    delegations: [
      {
        name: 'MicrosoftAppEnvironments'
        properties: { serviceName: 'Microsoft.App/environments' }
      }
    ]
    privateEndpointNetworkPolicies: 'Disabled'
    privateLinkServiceNetworkPolicies: 'Enabled'
  }
}

resource appConfig 'Microsoft.AppConfiguration/configurationStores@2024-05-01' = {
  name: configName
  location: location
  sku: { name: 'standard' }
  properties: {
    disableLocalAuth: true
    publicNetworkAccess: appConfigPublicNetworkAccess
    dataPlaneProxy: {
      authenticationMode: 'Pass-through'
      privateLinkDelegation: 'Enabled'
    }
  }
}

resource appConfigDns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.azconfig.io'
  location: 'global'
}
resource appConfigDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: appConfigDns
  name: '${prefix}-cfg-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}
resource appConfigPe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-pe-cfg'
  location: location
  properties: {
    subnet: { id: peSubnet.id }
    privateLinkServiceConnections: [
      {
        name: '${prefix}-pe-cfg-conn'
        properties: {
          privateLinkServiceId: appConfig.id
          groupIds: ['configurationStores']
        }
      }
    ]
  }
}
resource appConfigDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: appConfigPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'azconfig'
        properties: { privateDnsZoneId: appConfigDns.id }
      }
    ]
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: planName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: { reserved: true }
}
resource admin 'Microsoft.Web/sites@2024-04-01' = {
  name: adminName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    publicNetworkAccess: adminPublicNetworkAccess
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: integrationSubnet.id
    vnetRouteAllEnabled: true
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      scmIpSecurityRestrictionsUseMain: true
      ipSecurityRestrictions: adminAccessRestrictions
    }
    functionAppConfig: {
      runtime: {
        name: 'node'
        version: '22'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 5
        instanceMemoryMB: 2048
        alwaysReady: [
          {
            name: 'http'
            instanceCount: 1
          }
        ]
      }
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}deploymentpackage'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
    }
  }
}
resource adminSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: admin
  name: 'appsettings'
  properties: {
    APP_CONFIG_ENDPOINT: appConfig.properties.endpoint
    KEYVAULT_URI: vault.properties.vaultUri
    AUDIT_STORAGE_ACCOUNT: storage.name
    AUDIT_TABLE_NAME: 'operatorAudit'
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsightsConnectionString
    AzureWebJobsStorage: ''
    AzureWebJobsStorage__accountName: storage.name
    AzureWebJobsStorage__credential: 'managedidentity'
  }
}

resource adminPe 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-pe-admin'
  location: location
  properties: {
    subnet: { id: peSubnet.id }
    privateLinkServiceConnections: [
      {
        name: '${prefix}-pe-admin-conn'
        properties: {
          privateLinkServiceId: admin.id
          groupIds: ['sites']
        }
      }
    ]
  }
}
resource azureWebsitesDns 'Microsoft.Network/privateDnsZones@2024-06-01' existing = { name: 'privatelink.azurewebsites.net' }
resource adminDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: adminPe
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'azurewebsites'
        properties: { privateDnsZoneId: azureWebsitesDns.id }
      }
    ]
  }
}

resource adminBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, admin.id, 'Storage Blob Data Owner')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobOwnerRoleId)
    principalId: admin.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
resource adminTableContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, admin.id, 'Storage Table Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRoleId)
    principalId: admin.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
resource adminQueueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, admin.id, 'Storage Queue Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueContributorRoleId)
    principalId: admin.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
resource adminConfigOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appConfig.id, admin.id, 'App Configuration Data Owner')
  scope: appConfig
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', appConfigOwnerRoleId)
    principalId: admin.identity.principalId
    principalType: 'ServicePrincipal'
  }
}
resource deployerConfigOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appConfig.id, deployerPrincipalId, 'App Configuration Data Owner bootstrap')
  scope: appConfig
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', appConfigOwnerRoleId)
    principalId: deployerPrincipalId
    principalType: 'User'
  }
}
resource brokerConfigReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appConfig.id, brokerPrincipalId, 'App Configuration Data Reader')
  scope: appConfig
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', appConfigReaderRoleId)
    principalId: brokerPrincipalId
    principalType: 'ServicePrincipal'
  }
}
resource adminSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, admin.id, 'Key Vault Secrets Officer')
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: admin.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output adminFunctionName string = admin.name
output adminHostname string = admin.properties.defaultHostName
output adminPrincipalId string = admin.identity.principalId
output appConfigName string = appConfig.name
output appConfigEndpoint string = appConfig.properties.endpoint

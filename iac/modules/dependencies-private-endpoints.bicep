// iac/modules/dependencies-private-endpoints.bicep
// Provision private endpoints for Storage (Function host dependency) and Key Vault (broker secret access).
//
// EXISTING-NETWORK CONSTRAINT: this module only ADDS private endpoints and private DNS zones
// to an EXISTING VNet. It never creates or modifies the VNet itself.
//
// WHY THIS IS CRITICAL: Flex Consumption Functions require Storage (blob, file, queue, table)
// and the broker REQUIRES Key Vault (vault sub-resource) to operate. Both Storage and Key Vault
// are configured with publicNetworkAccess='Disabled' and networkAcls.defaultAction='Deny', so
// the Function CANNOT reach them unless private endpoints exist.
//
// PRIVATE DNS ZONES: Each private endpoint needs a private DNS zone so that DNS queries
// from within the VNet resolve the resource's FQDN to the private endpoint IP (not the public IP).
// Without the zone, resolution fails and the Function startup fails at storage access or the
// broker fails at first secret read.
//
// Microsoft Learn:
// - Private endpoints: https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-overview
// - Storage private endpoints: https://learn.microsoft.com/en-us/azure/storage/common/storage-private-endpoints
// - Key Vault private endpoints: https://learn.microsoft.com/en-us/azure/key-vault/general/private-link-service
// - Private endpoint DNS: https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns

@description('Name of the EXISTING VNet (in existingVnetResourceGroup) where private endpoints will be added.')
param existingVnetName string

@description('Resource group of the EXISTING VNet.')
param existingVnetResourceGroup string

@description('Private endpoint subnet ID (for hosting the private endpoint network interfaces).')
param privateEndpointSubnetId string

@description('Location for private endpoint resources.')
param location string

@description('Azure Storage account ID (created in foundation.bicep).')
param storageAccountId string

@description('Azure Key Vault ID (created in foundation.bicep).')
param keyVaultId string

@description('Naming prefix for all private endpoints and DNS zones.')
param namingPrefix string

// Private endpoint sub-resources required for Flex Consumption + broker.
// Storage: blob, file, queue, table — the Function host needs all four.
// https://learn.microsoft.com/en-us/azure/azure-functions/storage-considerations
// Key Vault: vault — the broker reads secrets via SecretClient.
var peNameBlob = '${namingPrefix}-pe-blob'
var peNameFile = '${namingPrefix}-pe-file'
var peNameQueue = '${namingPrefix}-pe-queue'
var peNameTable = '${namingPrefix}-pe-table'
var peNameVault = '${namingPrefix}-pe-vault'

// Private DNS zones: one per sub-resource type.
// https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns
var privateDnsZoneNameBlob = 'privatelink.blob.core.windows.net'
var privateDnsZoneNameFile = 'privatelink.file.core.windows.net'
var privateDnsZoneNameQueue = 'privatelink.queue.core.windows.net'
var privateDnsZoneNameTable = 'privatelink.table.core.windows.net'
var privateDnsZoneNameVault = 'privatelink.vaultcore.azure.net'

// Reference existing VNet (in existingVnetResourceGroup).
resource existingVnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: existingVnetName
  scope: resourceGroup(existingVnetResourceGroup)
}

// --- STORAGE: Blob ---
// MANDATORY for Flex Consumption: Function runtime accesses blob for bindings state, function keys, deployment.
resource peBlob 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: peNameBlob
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${peNameBlob}-conn'
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: ['blob']
        }
      }
    ]
  }
}

resource privateDnsZoneBlob 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneNameBlob
  location: 'global'
}

resource privateDnsZoneVnetLinkBlob 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZoneBlob
  name: '${namingPrefix}-vnet-link-blob'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: existingVnet.id }
  }
}

resource privateDnsZoneGroupBlob 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: peBlob
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: { privateDnsZoneId: privateDnsZoneBlob.id }
      }
    ]
  }
}

// --- STORAGE: File (Azure Files) ---
// REQUIRED for Flex Consumption deployment: code deployment uses file shares.
resource peFile 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: peNameFile
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${peNameFile}-conn'
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: ['file']
        }
      }
    ]
  }
}

resource privateDnsZoneFile 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneNameFile
  location: 'global'
}

resource privateDnsZoneVnetLinkFile 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZoneFile
  name: '${namingPrefix}-vnet-link-file'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: existingVnet.id }
  }
}

resource privateDnsZoneGroupFile 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: peFile
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'file'
        properties: { privateDnsZoneId: privateDnsZoneFile.id }
      }
    ]
  }
}

// --- STORAGE: Queue ---
// REQUIRED for Flex Consumption: runtime uses queues for internal state and durable task hubs.
resource peQueue 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: peNameQueue
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${peNameQueue}-conn'
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: ['queue']
        }
      }
    ]
  }
}

resource privateDnsZoneQueue 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneNameQueue
  location: 'global'
}

resource privateDnsZoneVnetLinkQueue 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZoneQueue
  name: '${namingPrefix}-vnet-link-queue'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: existingVnet.id }
  }
}

resource privateDnsZoneGroupQueue 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: peQueue
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'queue'
        properties: { privateDnsZoneId: privateDnsZoneQueue.id }
      }
    ]
  }
}

// --- STORAGE: Table ---
// REQUIRED for the broker's rate-limiter (new feature under parallel development).
// Table storage is used to track quota per caller and per key.
resource peTable 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: peNameTable
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${peNameTable}-conn'
        properties: {
          privateLinkServiceId: storageAccountId
          groupIds: ['table']
        }
      }
    ]
  }
}

resource privateDnsZoneTable 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneNameTable
  location: 'global'
}

resource privateDnsZoneVnetLinkTable 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZoneTable
  name: '${namingPrefix}-vnet-link-table'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: existingVnet.id }
  }
}

resource privateDnsZoneGroupTable 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: peTable
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'table'
        properties: { privateDnsZoneId: privateDnsZoneTable.id }
      }
    ]
  }
}

// --- KEY VAULT: vault sub-resource ---
// MANDATORY for the broker: SecretClient reads vendor keys via the broker's system-assigned MI.
// Without this endpoint, Key Vault access fails even though the MI has permission.
resource peVault 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: peNameVault
  location: location
  properties: {
    subnet: { id: privateEndpointSubnetId }
    privateLinkServiceConnections: [
      {
        name: '${peNameVault}-conn'
        properties: {
          privateLinkServiceId: keyVaultId
          groupIds: ['vault']
        }
      }
    ]
  }
}

resource privateDnsZoneVault 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneNameVault
  location: 'global'
}

resource privateDnsZoneVnetLinkVault 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZoneVault
  name: '${namingPrefix}-vnet-link-vault'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: existingVnet.id }
  }
}

resource privateDnsZoneGroupVault 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: peVault
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: { privateDnsZoneId: privateDnsZoneVault.id }
      }
    ]
  }
}

// --- Outputs ---
output blobPrivateDnsZoneName string = privateDnsZoneBlob.name
output filePrivateDnsZoneName string = privateDnsZoneFile.name
output queuePrivateDnsZoneName string = privateDnsZoneQueue.name
output tablePrivateDnsZoneName string = privateDnsZoneTable.name
output vaultPrivateDnsZoneName string = privateDnsZoneVault.name

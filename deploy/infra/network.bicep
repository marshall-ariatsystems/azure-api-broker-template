@description('Azure region for the isolated Tessera VNet.')
param location string
@description('Tenant-neutral deterministic VNet name.')
param vnetName string
@description('Non-overlapping address prefixes for the VNet.')
param addressPrefixes array
@description('Optional resource tags.')
param tags object = {}

module vnet '../../iac/modules/isolated-broker-vnet.bicep' = {
  name: 'ariat-isolated-network'
  params: { location: location, vnetName: vnetName, addressPrefixes: addressPrefixes, tags: tags }
}

output name string = vnet.outputs.vnetName
output id string = vnet.outputs.vnetId

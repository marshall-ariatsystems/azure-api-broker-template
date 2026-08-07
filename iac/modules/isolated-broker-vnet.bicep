// Creates the dedicated VNet used by a standalone broker deployment.
//
// The main foundation template intentionally consumes an existing VNet so it
// can be used safely in established enterprise networks. This module provides
// the complementary first step for a fully isolated deployment: create the
// VNet in the broker resource group, then pass its name and resource group to
// foundation.bicep. The foundation template creates the delegated integration
// subnet and private-endpoint subnet itself.

@description('Azure region for the VNet.')
param location string = resourceGroup().location

@description('Name of the dedicated broker VNet.')
param vnetName string

@description('Non-overlapping address prefixes for the dedicated broker VNet.')
param addressPrefixes array

@description('Optional resource tags applied to the VNet.')
param tags object = {}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: addressPrefixes
    }
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output resourceGroupName string = resourceGroup().name

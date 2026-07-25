// iac/modules/existing-vnet-subnet.bicep
// Adds ONE delegated subnet to an EXISTING VNet.
// EXISTING-NETWORK CONSTRAINT: the existing VNet already carries your private ingress path.
// This module never touches your existing VNet peering, gateways, routes, network appliances,
// or tunnels — it only adds a subnet.
//
// Cross-scope: the CALLER scopes this module to the VNet's resource group
// (module invocation `scope: resourceGroup(existingVnetResourceGroup)`). Inside the module the
// VNet is referenced as existing by name (same scope) and the subnet is a normal child.
// https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan#virtual-network-integration

@description('Name of the EXISTING VNet (in the resource group this module is scoped to).')
param existingVnetName string

@description('Subnet name to create inside the existing VNet.')
param subnetName string

@description('Subnet address prefix (CIDR). Must be within the existing VNet address space.')
param subnetCidr string

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: existingVnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: subnetName
  properties: {
    addressPrefix: subnetCidr
    // Flex Consumption requires the Microsoft.App/environments delegation. This DIFFERS from the
    // Elastic Premium and Dedicated (App Service) plans, which use Microsoft.Web/serverFarms.
    // https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options#subnets
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

output subnetId string = subnet.id
output subnetName string = subnet.name

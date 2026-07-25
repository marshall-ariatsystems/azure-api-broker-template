// iac/modules/private-endpoint-subnet.bicep
// Adds ONE private-endpoint subnet + its NSG to an EXISTING VNet.
//
// EXISTING-NETWORK CONSTRAINT: this module only ADDS a subnet and an NSG. It never creates or
// modifies your existing VNet peering, gateways, routes, network appliances, or tunnels — the VNet
// itself is referenced read-only (`existing =`).
//
// WHY A SEPARATE SUBNET: the Flex Consumption VNet-integration subnet is delegated to
// Microsoft.App/environments and "can't already be in use for other purposes (like private or
// service endpoints)". The private endpoint therefore needs its own, undelegated subnet.
// https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options#subnets
//
// WHY THE NSG IS THE FILTER: App Service access restrictions are NOT evaluated for traffic arriving
// through a private endpoint — "If the traffic is sent through a private endpoint, it sends directly
// to the site without any restrictions. Restrictions to private endpoints are configured using
// network security groups."
// https://learn.microsoft.com/en-us/azure/app-service/overview-access-restrictions#how-it-works
//
// WHY privateEndpointNetworkPolicies MUST BE 'Enabled': NSG traffic is bypassed on private endpoints
// by default because network policies are disabled for the subnet. Network policy support must be
// turned on for NSG and UDR rules to take effect on the private endpoint.
// https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-overview#network-security-of-private-endpoints

@description('Name of the EXISTING VNet (in the resource group this module is scoped to).')
param existingVnetName string

@description('Private endpoint subnet name to create inside the existing VNet.')
param subnetName string

@description('Private endpoint subnet address prefix (CIDR). Must be within the existing VNet address space and not overlap existing subnets.')
param subnetCidr string

@description('Name of the NSG that filters inbound traffic to the private endpoint.')
param nsgName string

@description('Azure region for the NSG (must match the existing VNet region).')
param location string

@description('ALLOW list — source CIDRs permitted to reach the broker private endpoint on 443. Evaluated after the deny list.')
param allowedSourceCidrs array

@description('DENY list — source CIDRs explicitly blocked, evaluated BEFORE the allow list. Use to carve exceptions out of a broader allowed range.')
param blockedSourceCidrs array = []

// Deny rules occupy 100..(100+n); allow rules follow at 200..(200+n); the catch-all deny sits last.
var denyRules = [for (cidr, i) in blockedSourceCidrs: {
  name: 'DenyBlockedSource${i}'
  properties: {
    description: 'Blacklist: deny ${cidr} to the broker private endpoint.'
    protocol: '*'
    sourceAddressPrefix: cidr
    sourcePortRange: '*'
    destinationAddressPrefix: subnetCidr
    destinationPortRange: '*'
    access: 'Deny'
    priority: 100 + i
    direction: 'Inbound'
  }
}]

var allowRules = [for (cidr, i) in allowedSourceCidrs: {
  name: 'AllowIngress${i}'
  properties: {
    description: 'Whitelist: allow ${cidr} to reach the broker private endpoint on 443.'
    protocol: 'Tcp'
    sourceAddressPrefix: cidr
    sourcePortRange: '*'
    destinationAddressPrefix: subnetCidr
    destinationPortRange: '443'
    access: 'Allow'
    priority: 200 + i
    direction: 'Inbound'
  }
}]

// Catch-all. NSG default rules permit intra-VirtualNetwork traffic, so without this any peered or
// on-VNet source would reach the private endpoint regardless of the allow list above.
var denyAllRule = [
  {
    name: 'DenyAllInbound'
    properties: {
      description: 'Implicit-deny backstop: everything not explicitly allowed above is refused.'
      protocol: '*'
      sourceAddressPrefix: '*'
      sourcePortRange: '*'
      destinationAddressPrefix: subnetCidr
      destinationPortRange: '*'
      access: 'Deny'
      priority: 4000
      direction: 'Inbound'
    }
  }
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: concat(denyRules, allowRules, denyAllRule)
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' existing = {
  name: existingVnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: vnet
  name: subnetName
  properties: {
    addressPrefix: subnetCidr
    networkSecurityGroup: {
      id: nsg.id
    }
    // MUST be 'Enabled' — otherwise the NSG above is bypassed for private endpoint traffic.
    privateEndpointNetworkPolicies: 'Enabled'
    privateLinkServiceNetworkPolicies: 'Enabled'
  }
}

output subnetId string = subnet.id
output subnetName string = subnet.name
output nsgId string = nsg.id
output vnetId string = vnet.id

// iac/foundation.bicep
// A1 — Foundation & Networking for the serverless Azure Function key broker.
//
// Design owner: spec §2 (compute host), §3 (architecture), §7 (networking — reuse your existing private-ingress VNet).
//
// EXISTING-NETWORK CONSTRAINT: this template only ADDS a delegated subnet + inbound access
// restrictions to a VNet you already have. It never creates or modifies your existing VNet
// peering, gateways, routes, network appliances, or tunnels — those are referenced read-only.
// It only adds a delegated subnet for Function VNet integration to an EXISTING VNet passed by
// parameter, and applies inbound access restrictions scoped to your EXISTING on-prem/VPN ingress
// CIDR ranges.
//
// All Azure examples in the runbooks use the `az` CLI (no Azure MCP server).
//
// Microsoft Learn citations (in comments by each resource):
// - Flex Consumption plan: https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan
// - Functions overview: https://learn.microsoft.com/en-us/azure/azure-functions/functions-overview
// - Functions networking options: https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options
// - App Service access restrictions: https://learn.microsoft.com/en-us/azure/app-service/app-service-ip-restrictions
// - Managed identity for App Service/Functions: https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity
// - Key Vault RBAC guide: https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide
// - Application Insights: https://learn.microsoft.com/en-us/azure/azure-functions/functions-monitoring
// - NAT Gateway overview: https://learn.microsoft.com/en-us/azure/nat-gateway/nat-overview
// - Private endpoint (OPTIONAL hardening, spec §7.2): https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options#inbound-networking-features

@description('Suffix for resource naming. Lowercase alphanumeric, max 8 chars.')
param namingSuffix string = 'optd'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Name of the EXISTING VNet that already carries your private ingress path (e.g. site-to-site VPN, ExpressRoute, or an SD-WAN/edge-appliance route into the VNet). REQUIRED: reuse, do not create.')
param existingVnetName string

@description('Resource group of the EXISTING VNet (same subscription as this deployment by default). Your private ingress path already lives in this VNet.')
param existingVnetResourceGroup string

@description('Address space (CIDR) to delegate as a subnet inside the existing VNet for Flex Consumption VNet integration. Must be within the existing VNet address space and not overlap existing subnets.')
param vnetIntegrationSubnetCidr string = '10.50.5.0/26'

@description('Address space (CIDR) for the private endpoint subnet inside the existing VNet. MUST be a different subnet from the VNet integration subnet — the Flex Consumption integration subnet is delegated and cannot host private endpoints.')
param privateEndpointSubnetCidr string = '10.50.5.64/28'

@description('Existing on-prem/VPN ingress CIDR range permitted to reach the broker over the private route (read-only reference; not created here).')
param onPremIngressCidr string = '10.0.0.0/8'

@description('Existing VPN client CIDR range permitted to reach the broker (read-only reference; not created here).')
param vpnClientCidr string = '10.99.0.0/16'

@description('BLACKLIST — source CIDRs explicitly denied at the private endpoint NSG, evaluated BEFORE the allow rules. Use to carve exceptions out of a broader allowed range (e.g. deny a guest VLAN inside 10.0.0.0/8).')
param blockedSourceCidrs array = []

@description('Deploy the inbound private endpoint (spec §7.1 default). Set false to fall back to the access-restriction-only posture documented in iac/network-design.md §4 — that fallback needs no private DNS work but leaves the app on its public default endpoint with IP rules as the only control.')
param deployPrivateEndpoint bool = true

@description('Always-ready instance count for Flex Consumption (1 removes cold starts; spec §2).')
param alwaysReadyInstanceCount int = 1

@description('Maximum burst instance count.')
param maximumInstanceCount int = 10

@description('Custom domain hostname. spec §7.1: broker.contoso.com resolved over the existing private path (DNS NOT created here; resolved over your existing private ingress path).')
param brokerHostname string = 'broker.contoso.com'

@description('Disable public network access (inbound). spec §7.1: public access disabled; inbound restricted to your on-prem/VPN ingress CIDR.')
param publicNetworkAccess string = 'Disabled'

// ----------------------------------------------------------------------------
// Naming convention
// ----------------------------------------------------------------------------
var prefix = 'apibkr-${namingSuffix}'
var storageName = toLower(replace('st${namingSuffix}${uniqueString(resourceGroup().id)}', '-', ''))
var funcAppName = '${prefix}-func'
var appInsightsName = '${prefix}-ai'
var appPlanName = '${prefix}-plan'
var kvName = '${prefix}-kv'
var vnetIntegrationSubnetName = '${prefix}-vnet-integ-subnet'
var privateEndpointSubnetName = '${prefix}-pe-subnet'
var privateEndpointNsgName = '${prefix}-pe-nsg'
var privateEndpointName = '${prefix}-pe'
// Private DNS zone for App Service / Functions private endpoints.
// https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns
var privateDnsZoneName = 'privatelink.azurewebsites.net'

// ----------------------------------------------------------------------------
// Storage account (required by Functions; spec §13 line item)
// https://learn.microsoft.com/en-us/azure/storage/common/storage-account-overview
// ----------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Disabled' // accessed via VNet integration + AzureServices bypass
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
    }
  }
}

// Blob service for Flex Consumption deployment package storage (spec §2, spec §13).
// Flex Consumption requires a dedicated blob container to hold the deployment package.
// The Function app reads this container via system-assigned managed identity.
// https://learn.microsoft.com/en-us/azure/azure-functions/functions-infrastructure-as-code#application-configuration
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource deploymentPackageContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'deploymentpackage'
  properties: {
    publicAccess: 'None' // no public access; Function app reads via MI
  }
}

// ----------------------------------------------------------------------------
// Existing VNet — referenced read-only; we add ONE delegated subnet for VNet integration.
// Your existing private ingress path already lives in this VNet (referenced read-only).
// Cross-scope subnet creation is delegated to a module (a child resource whose parent is in
// another scope must be deployed via a module).
// https://learn.microsoft.com/en-us/azure/virtual-network/virtual-networks-overview
// ----------------------------------------------------------------------------
module vnetIntegSubnet 'modules/existing-vnet-subnet.bicep' = {
  name: 'vnet-integ-subnet-${namingSuffix}'
  scope: resourceGroup(existingVnetResourceGroup)
  params: {
    existingVnetName: existingVnetName
    subnetName: vnetIntegrationSubnetName
    subnetCidr: vnetIntegrationSubnetCidr
  }
}

// ----------------------------------------------------------------------------
// Private endpoint subnet + NSG — the DEFAULT inbound path (spec §7.1).
// Separate from the integration subnet: the Flex Consumption integration subnet is delegated to
// Microsoft.App/environments and cannot host private endpoints.
// The NSG on this subnet is what enforces the IP allow/deny list — App Service access restrictions
// are NOT evaluated for private endpoint traffic.
// https://learn.microsoft.com/en-us/azure/app-service/overview-access-restrictions#how-it-works
// ----------------------------------------------------------------------------
module peSubnet 'modules/private-endpoint-subnet.bicep' = if (deployPrivateEndpoint) {
  name: 'pe-subnet-${namingSuffix}'
  scope: resourceGroup(existingVnetResourceGroup)
  params: {
    existingVnetName: existingVnetName
    subnetName: privateEndpointSubnetName
    subnetCidr: privateEndpointSubnetCidr
    nsgName: privateEndpointNsgName
    location: location
    allowedSourceCidrs: [onPremIngressCidr, vpnClientCidr]
    blockedSourceCidrs: blockedSourceCidrs
  }
}

// ----------------------------------------------------------------------------
// Private endpoints for Storage (blob, file, queue, table) and Key Vault (vault).
// MANDATORY: Function host and broker require private connectivity to both dependencies.
// spec §7.2 + §7.3: provision private endpoints so Function can reach Storage and Key Vault
// despite publicNetworkAccess='Disabled' on both. Also provision matching private DNS zones
// so that DNS resolution inside the VNet finds the private endpoint IP, not the public one.
// See iac/modules/dependencies-private-endpoints.bicep for the reasoning.
// https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-overview
// https://learn.microsoft.com/en-us/azure/azure-functions/storage-considerations
// ----------------------------------------------------------------------------
module dependenciesPe 'modules/dependencies-private-endpoints.bicep' = if (deployPrivateEndpoint) {
  name: 'dependencies-pe-${namingSuffix}'
  scope: resourceGroup(existingVnetResourceGroup)
  params: {
    existingVnetName: existingVnetName
    existingVnetResourceGroup: existingVnetResourceGroup
    privateEndpointSubnetId: peSubnet!.outputs.subnetId
    location: location
    storageAccountId: storage.id
    keyVaultId: keyVault.id
    namingPrefix: prefix
  }
  dependsOn: [
    storage
    keyVault
    peSubnet
  ]
}

// ----------------------------------------------------------------------------
// Application Insights (telemetry backend; spec §10, §13)
// https://learn.microsoft.com/en-us/azure/azure-monitor/app/asp-net-core
// ----------------------------------------------------------------------------
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Disabled'
  }
}

// ----------------------------------------------------------------------------
// Flex Consumption plan (compute host; spec §2)
// SKU FC1 / tier FlexConsumption is the verified Flex Consumption ARM shape.
// https://learn.microsoft.com/en-us/azure/azure-functions/flex-consumption-plan
// ----------------------------------------------------------------------------
resource flexPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: appPlanName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    maximumElasticWorkerCount: maximumInstanceCount
  }
}

// ----------------------------------------------------------------------------
// Azure Function (Flex Consumption) — the broker
// - system-assigned managed identity (MANDATORY; reads KV secrets per §6.1)
// - public network access DISABLED; inbound access restrictions scoped to your on-prem/VPN ingress CIDR (spec §7.1)
// - VNet integration for outbound vendor calls via virtualNetworkSubnetId (site-level, spec §7.1)
// - Easy Auth configured in function-config.bicep (authentiction-v2 audiences)
// https://learn.microsoft.com/en-us/azure/azure-functions/functions-overview
// https://learn.microsoft.com/en-us/azure/azure-functions/functions-networking-options
// https://learn.microsoft.com/en-us/azure/app-service/overview-managed-identity
// ----------------------------------------------------------------------------
resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: funcAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned' // MANDATORY: needed by A2 for Key Vault access (spec §6.1)
  }
  properties: {
    publicNetworkAccess: publicNetworkAccess // Disabled (spec §7.1)
    serverFarmId: flexPlan.id
    httpsOnly: true
    // Flex Consumption VNet integration (outbound to vendor) — site-level property (spec §7.1)
    virtualNetworkSubnetId: vnetIntegSubnet.outputs.subnetId
    vnetRouteAllEnabled: true // route all outbound traffic through the VNet integration
    siteConfig: {
      // Flex Consumption does NOT use linuxFxVersion or minimumElasticInstanceCount in siteConfig.
      // Runtime and scaling are configured in functionAppConfig below (spec §2; per Microsoft Learn
      // Flex Consumption migration docs: https://learn.microsoft.com/en-us/azure/azure-functions/migration/migrate-plan-consumption-to-flex#post-migration-tasks).
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      // Inbound access restrictions — these govern the PUBLIC default endpoint ONLY.
      // They are NOT evaluated for traffic arriving through the private endpoint; that traffic is
      // filtered by the NSG on the private endpoint subnet (modules/private-endpoint-subnet.bicep).
      // Kept as defense-in-depth for the case where publicNetworkAccess is ever re-enabled.
      // https://learn.microsoft.com/en-us/azure/app-service/overview-access-restrictions#how-it-works
      ipSecurityRestrictions: [
        {
          name: 'AllowOnPremIngress'
          ipAddress: onPremIngressCidr
          action: 'Allow'
          priority: 100
          tag: 'Default'
        }
        {
          name: 'VpnIngress'
          ipAddress: vpnClientCidr
          action: 'Allow'
          priority: 110
          tag: 'Default'
        }
        {
          name: 'DenyAllPublic'
          ipAddress: '0.0.0.0/0'
          action: 'Deny'
          priority: 2147483647
          tag: 'Default'
        }
      ]
    }
    // Flex Consumption configuration (spec §2): runtime, scaling, and deployment storage.
    // Per Microsoft Learn: https://learn.microsoft.com/en-us/azure/azure-functions/functions-infrastructure-as-code#application-configuration
    functionAppConfig: {
      runtime: {
        name: 'node'
        version: '22' // Node.js 22 LTS (April 30, 2027 support)
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: 2048 // Flex default: 1 always-ready 2 GiB instance = no cold starts (spec §2)
        alwaysReady: [
          {
            name: 'http'
            instanceCount: alwaysReadyInstanceCount
          }
        ]
      }
      deployment: {
        storage: {
          type: 'blobContainer'
          // Flex Consumption stores deployment artifacts in the designated storage container.
          // The value is the blob endpoint URI + container name. Flex runtime discovers and uses
          // this container via the function app's system-assigned managed identity (requires
          // Storage Blob Data Owner role on the storage account).
          value: '${storage.properties.primaryEndpoints.blob}deploymentpackage'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Private endpoint on the Function app (inbound) — spec §7.1 DEFAULT.
// groupId 'sites' targets the main site (a slot would be 'sites-<slot>').
// https://learn.microsoft.com/en-us/azure/app-service/overview-private-endpoint
// ----------------------------------------------------------------------------
resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (deployPrivateEndpoint) {
  name: privateEndpointName
  location: location
  properties: {
    subnet: {
      id: peSubnet!.outputs.subnetId
    }
    privateLinkServiceConnections: [
      {
        name: '${privateEndpointName}-conn'
        properties: {
          privateLinkServiceId: functionApp.id
          groupIds: ['sites']
        }
      }
    ]
  }
}

// ----------------------------------------------------------------------------
// -----------------------------------------------------------------------
// RBAC — Flex Consumption requires managed identity access to Storage (spec §2, §7.1).
// The Function app's system-assigned managed identity must read the deployment container
// (Blob Data Owner) and write quota counters to the rate-limit table (Table Data Contributor).
// Per Microsoft Learn: https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#storage
// -----------------------------------------------------------------------

// Storage Blob Data Owner: required for Flex deployment package access + general host storage ops.
resource rbacStorageBlobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, 'Storage Blob Data Owner')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Table Data Contributor: required by the rate limiter to write quota counters.
// The rate-limiter reads/writes to a Table Storage entity per minute window (spec §9).
// Scope: storage account (not scoped to a specific table; the rate limiter creates the table at runtime).
resource rbacStorageTableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, 'Storage Table Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Queue Data Contributor: defense-in-depth for potential future queue-based features
// (e.g., async processing). Not currently used but pre-positioned for extensibility.
resource rbacStorageQueueDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, 'Storage Queue Data Contributor')
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '974c5e8b-45b9-4653-ba55-5f855dd0fb88')
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Private DNS — resolves the Function hostname to the private endpoint IP inside the VNet.
// Adding a zone + a VNet LINK does not modify the VNet itself (EXISTING-NETWORK CONSTRAINT holds).
// ON-PREM RESOLUTION IS A PREREQUISITE, NOT AN IaC RESOURCE: on-prem DNS must conditionally forward
// this zone to a resolver that sits inside the VNet (Azure DNS Private Resolver inbound endpoint or
// an existing forwarder). See iac/network-design.md §3.1.
// https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns
// ----------------------------------------------------------------------------
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (deployPrivateEndpoint) {
  name: privateDnsZoneName
  location: 'global'
}

resource privateDnsZoneVnetLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (deployPrivateEndpoint) {
  parent: privateDnsZone
  name: '${prefix}-vnet-link'
  location: 'global'
  properties: {
    registrationEnabled: false // resolution only; this template never registers records for your VMs
    virtualNetwork: {
      id: peSubnet!.outputs.vnetId
    }
  }
}

// Binds the private endpoint's A record into the zone above.
resource privateDnsZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (deployPrivateEndpoint) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'azurewebsites'
        properties: {
          privateDnsZoneId: privateDnsZone!.id
        }
      }
    ]
  }
}

// ----------------------------------------------------------------------------
// App settings — Node.js broker configuration, Key Vault URI (for SecretClient),
// rate-limiting, role-to-secret mapping, and runtime settings.
// https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references
// https://learn.microsoft.com/en-us/azure/azure-functions/functions-reference-node
//
// RUNTIME DECISION: This is a Node.js app running on Flex Consumption. The broker code
// (function-node/src/broker.js) requires KEYVAULT_URI (not a connection string) to initialize
// the SecretClient with DefaultAzureCredential (uses system-assigned managed identity).
// App settings are mostly about broker behavior override; the rest fall back to broker defaults.
//
// RATE LIMITING: The broker uses Table Storage for quota tracking. Settings below are
// parsed by the broker; defaults are applied if omitted. The rate limiter requires
// QUOTA_CALLER_PER_MIN, QUOTA_KEY_PER_MIN, and RATE_LIMIT_STORAGE_ACCOUNT.
//
// ROLE MAPPING (issue #2): the authoritative role-to-secret mapping lives in
// identity/app-roles.json (role values) and keyvault.bicep (secret names). The broker's built-in
// fallback map is vendor-key-a/b/c, which does NOT exist in Key Vault — relying on it makes every
// secret read 404. ROLE_SECRET_MAP is therefore set EXPLICITLY below so the fallback is never
// reached, and the two sides cannot drift silently.
//   roles   (identity/app-roles.json): VendorApi.KeyA.Invoke, VendorApi.KeyB.Invoke,
//                                      VendorApi.KeyC.Invoke, VendorApi.Admin.Test
//   secrets (iac/keyvault.bicep):      vendor-api-key-team-a, vendor-api-key-team-b,
//                                      vendor-api-key-ci, vendor-api-key-canary
// If you add a role, add it in BOTH files and here, or the new role resolves to no secret.
// https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-guide
// https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references
// ----------------------------------------------------------------------------
resource functionAppSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: {
    // --- Vendor API gateway configuration (spec §6.2, §9) ---
    VENDOR_BASE_URL: 'https://api.vendor.example.com' // Replaced at deploy time with real vendor URL
    INJECT_MODE: 'header' // 'header' | 'bearer' | 'pair' | 'basic' | 'oauth2cc' | 'entra' (spec §6.2, §9)
    VENDOR_KEY_HEADER_NAME: 'x-api-key' // Header name for the vendor key injection (default: x-api-key)
    VENDOR_KEYID_HEADER_NAME: 'x-api-key-id' // Header name for keyId in pair/basic/oauth2cc modes
    VENDOR_SECRET_HEADER_NAME: 'x-api-secret' // Header name for secret in pair/basic/oauth2cc modes

    // --- Secret caching (spec §6.2, §8) ---
    SECRET_CACHE_TTL_SECONDS: '300' // Cache secrets for 5 minutes; rotation event (Event Grid) busts cache immediately

    // --- Rate limiting (new feature: quota per caller and per key) ---
    // The broker uses Table Storage (brokerRateLimits table) to track quota consumption.
    // The rate limiter requires: storage account name (derives table endpoint), storage account
    // role (Table Data Contributor), and quota settings (defaults if omitted).
    // Defaults are fail-closed: if Table Storage is unavailable, every request returns 429/503.
    // Set RATE_LIMIT_FAIL_MODE to 'open' to invert (allow traffic if quota service fails, risky).
    // Per function-node/src/rate-limiter.js: https://github.com/...
    RATE_LIMIT_STORAGE_ACCOUNT: storageName // Storage account NAME (not connection string or key)
    RATE_LIMIT_FAIL_MODE: 'closed' // 'closed' (default, deny if unavailable) | 'open' (allow if unavailable)
    RATE_LIMIT_TABLE_NAME: 'brokerRateLimits' // Table Storage table name for quota counters
    QUOTA_CALLER_PER_MIN: '60' // Max requests per caller (client service principal) per minute
    QUOTA_KEY_PER_MIN: '600' // Max requests per vendor key per minute

    // --- Request header allowlist (new feature: defense in depth) ---
    // Comma-separated list of header names to forward to the vendor (all others stripped).
    // Example: 'x-correlation-id,x-request-id,accept-language'
    // FORWARD_HEADER_ALLOWLIST: '' // Empty = strip all non-essential headers (default, safest)

    // --- Multi-role vendor routing (opt-in relaxation of spec §3c) ---
    // Normally, one Entra token = exactly one vendor role (spec §3c). Setting this to 'true'
    // allows one token to hold multiple roles and select a vendor per request via the URL
    // path (/broker/<vendor>/<path>). This is a DELIBERATE RELAXATION of fail-closed enforcement
    // and should only be used when one Entra identity MUST route to multiple vendors.
    // MULTI_ROLE_VENDOR_ROUTING: 'false' // Default: enforce one-role-per-token (spec §3c)

    // --- Demo mode (testing/development only) ---
    // When set to true, generates a demo vendor key for testing (never use in production).
    // DEMO_MODE: 'false' // Default: production mode

    // --- Azure Key Vault access (MANDATORY; function-node/src/broker.js reads secrets via SecretClient) ---
    // The broker uses DefaultAzureCredential with the Function's system-assigned managed identity.
    // Managed identity is granted Key Vault Secrets User scoped to ONLY the vendor-key secrets
    // (least privilege, spec §6.1). System-assigned identity principalId is emitted in foundation.bicep
    // outputs and is granted RBAC in keyvault.bicep.
    KEYVAULT_URI: keyVault.properties.vaultUri // e.g., https://apibkr-optd-kv.vault.azure.net/

    // --- Telemetry (Application Insights instrumentation) ---
    // Function runtime automatically uses this to emit traces and metrics.
    APPLICATIONINSIGHTS_CONNECTION_STRING: appInsights.properties.ConnectionString

    // --- Azure Functions runtime (Node.js on Flex Consumption) ---
    // The broker requires Node.js 22 runtime (function-node/src/broker.js uses @azure/functions v4).
    // Flex Consumption does NOT use linuxFxVersion or netFrameworkVersion (those are ignored).
    // Runtime is specified in functionAppConfig.runtime above (spec §2; Microsoft Learn Flex Consumption).
    FUNCTIONS_WORKER_RUNTIME: 'node'
    FUNCTIONS_EXTENSION_VERSION: '~4' // v4 runtime

    // --- Azure WebJobs Storage (Flex Consumption identity-based) ---
    // For Flex Consumption with managed identity, AzureWebJobsStorage must be an empty string
    // when using identity-based authentication. The companion setting __accountName tells the
    // runtime which storage account to use (derived from the name). This is NOT a connection
    // string (see spec §6.1: no long-lived secrets in app settings).
    // https://learn.microsoft.com/en-us/azure/azure-functions/functions-app-settings#azurewebjobsstorage__accountname
    AzureWebJobsStorage: '' // EMPTY by design (identity-based, not connection-string-based)
    AzureWebJobsStorage__accountName: storageName // Storage account name for identity-based access

    // --- Role-to-secret mapping (spec §5.1, identity/app-roles.json) ---
    // Authoritative mapping of Entra app-roles -> Key Vault secret names. The broker's built-in
    // fallback map uses different secret names (vendor-key-a/b/c) than the deployment (vendor-api-key-*),
    // causing 404 on every secret read (issue #2). This setting overrides the fallback so roles
    // and secrets stay aligned with keyvault.bicep. Format: JSON object { roleValue: secretName }.
    // Read from identity/app-roles.json: roles are VendorApi.KeyA.Invoke, VendorApi.KeyB.Invoke,
    // VendorApi.KeyC.Invoke, VendorApi.Admin.Test; secrets are vendor-api-key-team-a,
    // vendor-api-key-team-b, vendor-api-key-ci, vendor-api-key-canary.
    // Per function-node/src/broker.js loadRoleMap(): if ROLE_SECRET_MAP is invalid/missing,
    // broker falls back to built-in defaults (which DO NOT match keyvault.bicep).
    ROLE_SECRET_MAP: '{"VendorApi.KeyA.Invoke":"vendor-api-key-team-a","VendorApi.KeyB.Invoke":"vendor-api-key-team-b","VendorApi.KeyC.Invoke":"vendor-api-key-ci","VendorApi.Admin.Test":"vendor-api-key-canary"}'
  }
}

// ----------------------------------------------------------------------------
// Key Vault (created here so the principalId is emitted in outputs.json for A2 to bind RBAC).
// Full RBAC scoping is in keyvault.bicep (A2).
// https://learn.microsoft.com/en-us/azure/key-vault/general/overview
// ----------------------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true // RBAC mode (spec §6.1) — no access policies
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true // MANDATORY (spec §6.1 — purge protection)
    publicNetworkAccess: 'Disabled' // accessed by Function MI over VNet integration
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices' // let the Function's MI reach it via AzureServices bypass over the VNet
    }
  }
}

// ----------------------------------------------------------------------------
// Outputs — consumed by A2 (KV RBAC bind), A4 (broker code config), A6 (client base URL)
// ----------------------------------------------------------------------------
output functionName string = functionApp.name
output hostname string = brokerHostname // broker.contoso.com — resolved over the existing private path (spec §7.1)
output functionDefaultHostname string = functionApp.properties.defaultHostName
output identityPrincipalId string = functionApp.identity.principalId // consumed by A2 for KV RBAC
output identityTenantId string = functionApp.identity.tenantId
output flexPlanName string = flexPlan.name
output appInsightsName string = appInsights.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output storageAccountName string = storage.name
output vnetIntegrationSubnetId string = vnetIntegSubnet.outputs.subnetId
output publicNetworkAccess string = publicNetworkAccess
// Private endpoint (default inbound path; empty when deployPrivateEndpoint = false)
output privateEndpointEnabled bool = deployPrivateEndpoint
output privateEndpointName string = deployPrivateEndpoint ? privateEndpoint!.name : ''
output privateEndpointSubnetId string = deployPrivateEndpoint ? peSubnet!.outputs.subnetId : ''
output privateEndpointNsgId string = deployPrivateEndpoint ? peSubnet!.outputs.nsgId : ''
output privateDnsZoneName string = deployPrivateEndpoint ? privateDnsZone!.name : ''
// The private IP is deliberately NOT an output: customDnsConfigs comes back empty once a private DNS
// zone group is attached, so indexing it fails the deployment. Read it after deploy with:
//   az network private-endpoint show -g <rg> -n <pe-name> \
//     --query 'customDnsConfigs[0].ipAddresses[0]' -o tsv
output privateEndpointNicId string = deployPrivateEndpoint ? privateEndpoint!.properties.networkInterfaces[0].id : ''

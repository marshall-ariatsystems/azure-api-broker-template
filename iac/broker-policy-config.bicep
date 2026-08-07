// Enables dynamic, non-secret App Configuration policy on an existing broker.
param functionName string
param appConfigEndpoint string
resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionName
}
resource settings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: functionApp
  name: 'appsettings'
  properties: {
    APP_CONFIG_ENDPOINT: appConfigEndpoint
    POLICY_CACHE_TTL_SECONDS: '15'
  }
}

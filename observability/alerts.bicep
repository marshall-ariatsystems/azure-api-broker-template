// observability/alerts.bicep
// A8 — Application Insights + Azure Monitor alert rules (spec §10, §11).
//
// spec §10: "Use Application Insights to record per-caller (oid) and per-key usage, 4xx/5xx counts,
//   latency, and vendor-error rates, with alerts on error-rate and latency spikes."
// spec §11: metadata-only logging; never log vendor request/response bodies or bearer tokens.
//
// This design has NO SNAT-port-exhaustion alert (that was APIM Std v2 specific). Replace with a
// cold-start/health alert and a Key Vault access-anomaly alert.
//
// Microsoft Learn:
// - Monitor Functions with App Insights: https://learn.microsoft.com/en-us/azure/azure-functions/functions-monitoring
// - Alerts overview: https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-overview
// - Key Vault monitoring: https://learn.microsoft.com/en-us/azure/azure-monitor/insights/key-vault-insights-overview

@description('Function app name (from iac/outputs.json).')
param functionName string

@description('Application Insights name (from iac/outputs.json).')
param appInsightsName string

@description('Resource group for the alerts (the broker RG).')
param alertsResourceGroup string = resourceGroup().name

@description('Action group id for alert notifications (created out-of-band by the admin).')
param actionGroupId string

var alertWindow = 'PT5M'
var errorThreshold = 5
var latencyThresholdMs = 2000

// 4xx rate (esp. 401/403 spikes — spec §10)
resource alert4xx 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${functionName}-4xx-spike'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [resourceId('Microsoft.Web/sites', functionName)]
    evaluationFrequency: alertWindow
    windowSize: alertWindow
    criteria: {
      'allOf': [
        {
          name: '4xx'
          metricName: 'Http4xx'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: errorThreshold
          timeAggregation: 'Total'
        }
      ]
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

// 5xx rate
resource alert5xx 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${functionName}-5xx-spike'
  location: 'global'
  properties: {
    severity: 1
    enabled: true
    scopes: [resourceId('Microsoft.Web/sites', functionName)]
    evaluationFrequency: alertWindow
    windowSize: alertWindow
    criteria: {
      'allOf': [
        {
          name: '5xx'
          metricName: 'Http5xx'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: errorThreshold
          timeAggregation: 'Total'
        }
      ]
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

// Backend latency spike
resource alertLatency 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${functionName}-latency-spike'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [resourceId('Microsoft.Web/sites', functionName)]
    evaluationFrequency: alertWindow
    windowSize: alertWindow
    criteria: {
      'allOf': [
        {
          name: 'latency'
          metricName: 'HttpResponseTime'
          metricNamespace: 'Microsoft.Web/sites'
          operator: 'GreaterThan'
          threshold: latencyThresholdMs
          timeAggregation: 'Average'
        }
      ]
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

// Key Vault access anomaly (denied reads — could indicate an RBAC drift or a compromised MI)
// spec §6.1 least-privilege control: the MI can read ONLY vendor-key secrets; a denied read is notable.
resource alertKvDeny 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${functionName}-kv-access-anomaly'
  location: 'global'
  properties: {
    severity: 1
    enabled: true
    scopes: [resourceId('Microsoft.KeyVault/vaults', '${functionName}-kv')]
    evaluationFrequency: alertWindow
    windowSize: alertWindow
    criteria: {
      'allOf': [
        {
          name: 'kv-deny'
          metricName: 'ServiceApiResult'
          metricNamespace: 'Microsoft.KeyVault/vaults'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
          dimensions: [{
            name: 'ActivityResult'
            operator: 'Include'
            values: [' UnauthorizedAccess', ' Forbidden']
          }]
        }
      ]
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

// Cold-start / health (Flex Consumption always-ready = 1; a cold start indicates an always-ready failure)
// spec §2: 1 always-ready 2 GiB instance removes cold starts; alert if a cold start is observed.
resource alertColdStart 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${functionName}-cold-start'
  location: 'global'
  properties: {
    severity: 2
    enabled: true
    scopes: [resourceId('Microsoft.Insights/components', appInsightsName)]
    evaluationFrequency: alertWindow
    windowSize: alertWindow
    criteria: {
      'allOf': [
        {
          name: 'coldstart'
          metricName: 'exceptions/count'
          metricNamespace: 'Microsoft.Insights/components'
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Total'
        }
      ]
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
    }
    actions: [{ actionGroupId: actionGroupId }]
  }
}

output alerts array = [alert4xx.name, alert5xx.name, alertLatency.name, alertKvDeny.name, alertColdStart.name]

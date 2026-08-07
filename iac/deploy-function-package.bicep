// Publishes a prebuilt ZIP through the Flex Consumption OneDeploy extension.
// The package URI is secure because it is normally a short-lived Blob SAS URL.

param functionName string

param location string = resourceGroup().location

@secure()
param packageUri string

resource functionApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: functionName
}

resource oneDeploy 'Microsoft.Web/sites/extensions@2022-09-01' = {
  parent: functionApp
  name: 'onedeploy'
  location: location
  properties: {
    packageUri: packageUri
    remoteBuild: false
  }
}

output deploymentResourceId string = oneDeploy.id

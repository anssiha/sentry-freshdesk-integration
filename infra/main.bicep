// Sentry -> Freshdesk sync: Function App (Flex Consumption), Storage, Key Vault, App Insights.
// All access uses the Function App's system-assigned managed identity; storage shared keys are disabled.

@description('Short name used to derive resource names, e.g. "sentryfd".')
@minLength(3)
@maxLength(20)
param appName string

param location string = resourceGroup().location

@description('NCRONTAB schedule for the sync timer.')
param syncSchedule string = '0 */10 * * * *'

@description('Start in dry-run mode; flip to false once logs look right.')
param dryRun bool = true

@description('Optional principal (user or group object ID) allowed to manage Key Vault secrets.')
param vaultAdminPrincipalId string = ''

@allowed(['User', 'Group', 'ServicePrincipal'])
param vaultAdminPrincipalType string = 'User'

param stateTableName string = 'sentrysync'

@description('Key Vault secret holding the routes JSON (the contents of config/routes.json). Must exist before the app runs.')
param routesConfigSecretName string = 'routes-config'

var suffix = uniqueString(resourceGroup().id, appName)
var storageName = 'st${suffix}'
var vaultName = 'kv${suffix}'
var deploymentContainer = 'app-package'

var roles = {
  storageBlobDataOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${appName}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }

  resource blobs 'blobServices' = {
    name: 'default'
    resource container 'containers' = {
      name: deploymentContainer
    }
  }

  resource tables 'tableServices' = {
    name: 'default'
    resource state 'tables' = {
      name: stateTableName
    }
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: 'plan-${appName}'
  location: location
  kind: 'functionapp'
  sku: {
    tier: 'FlexConsumption'
    name: 'FC1'
  }
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: 'func-${appName}-${suffix}'
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'SYNC_SCHEDULE', value: syncSchedule }
        { name: 'DRY_RUN', value: string(dryRun) }
        { name: 'KEY_VAULT_URL', value: vault.properties.vaultUri }
        { name: 'STATE_TABLE_URL', value: storage.properties.primaryEndpoints.table }
        { name: 'STATE_TABLE_NAME', value: stateTableName }
        { name: 'ROUTES_CONFIG_SECRET', value: routesConfigSecretName }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
  }
}

var storageRoles = [roles.storageBlobDataOwner, roles.storageQueueDataContributor, roles.storageTableDataContributor]

resource storageRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in storageRoles: {
    name: guid(storage.id, site.id, roleId)
    scope: storage
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
      principalId: site.identity.principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource vaultReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, site.id, roles.keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource vaultOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(vaultAdminPrincipalId)) {
  name: guid(vault.id, vaultAdminPrincipalId, roles.keyVaultSecretsOfficer)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
    principalId: vaultAdminPrincipalId
    principalType: vaultAdminPrincipalType
  }
}

output functionAppName string = site.name
output keyVaultName string = vault.name
output storageAccountName string = storage.name
output appInsightsName string = insights.name

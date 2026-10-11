#!/usr/bin/env bash
# One-time setup: lets GitHub Actions log in to Azure without a stored secret (OIDC federation).
# Run it yourself with `az login` done. It creates an app registration, a service principal,
# a federated credential for the GitHub "production" environment and role assignments on the resource group.
#
# Usage: scripts/setup-github-oidc.sh <github-owner>/<repo> <resource-group>
set -euo pipefail

repo="${1:?usage: $0 <owner>/<repo> <resource-group>}"
rg="${2:?usage: $0 <owner>/<repo> <resource-group>}"
display_name="github-${repo//\//-}"

sub=$(az account show --query id -o tsv)
tenant=$(az account show --query tenantId -o tsv)
scope="/subscriptions/$sub/resourceGroups/$rg"

az group show -n "$rg" >/dev/null
app_id=$(az ad app create --display-name "$display_name" --query appId -o tsv)
az ad sp create --id "$app_id" >/dev/null

az ad app federated-credential create --id "$app_id" --parameters "{
  \"name\": \"github-production\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:${repo}:environment:production\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}" >/dev/null

# Contributor deploys resources and the app; Role Based Access Control Administrator lets main.bicep create its role assignments.
az role assignment create --assignee "$app_id" --role Contributor --scope "$scope" >/dev/null
az role assignment create --assignee "$app_id" --role "Role Based Access Control Administrator" --scope "$scope" >/dev/null

cat <<OUT

Done. Add these as repository *variables* (Settings -> Secrets and variables -> Actions -> Variables):

  AZURE_CLIENT_ID        $app_id
  AZURE_TENANT_ID        $tenant
  AZURE_SUBSCRIPTION_ID  $sub
  AZURE_RESOURCE_GROUP   $rg
  APP_NAME               <same appName as the first deployment, e.g. sentryfd>

Optional: VAULT_ADMIN_PRINCIPAL_ID (object id that may write Key Vault secrets), VAULT_ADMIN_PRINCIPAL_TYPE (User or Group).

Also create a GitHub environment named "production" (add required reviewers if you want approval before deploys).
OUT

# Setup guide: Sentry → Freshdesk sync

This guide takes you from nothing to a running deployment. For how the sync works internally and the full list of config options, see the [README](../README.md).

## What this does

Every 10 minutes the function checks Sentry for new **user feedback** (or new **error issues**) and creates a Freshdesk ticket for each one. It never creates the same ticket twice.

One deployment can serve many teams. Each team is one entry ("route") in `config/routes.json`.

## What you need

| What | Where to get it | Used for |
|---|---|---|
| Azure subscription, and rights to create resources and role assignments in one resource group | Your Azure admin | Hosting |
| Tools on your computer: Azure CLI (`az`), Azure Functions Core Tools v4 (`func`), Node 22, Docker (local testing only) | Install normally | Deploying |
| **Sentry token** | See [step 1](#1-create-a-sentry-token) | Reading feedback and issues |
| **Freshdesk API key** | See [step 2](#2-get-a-freshdesk-api-key) | Creating tickets |
| Sentry org slug, project slug(s), region URL | Your Sentry URL | Config |
| Freshdesk domain, ticket type, group ID, custom field names | Your Freshdesk admin | Config |

You need **one Sentry token and one Freshdesk key per team** (or one shared pair, if the same account can see everything). Keys never go into the config file. They are stored in Azure Key Vault, and the config only refers to them by name.

## Overview

1. [Create a Sentry token](#1-create-a-sentry-token)
2. [Get a Freshdesk API key](#2-get-a-freshdesk-api-key)
3. [Collect the Freshdesk values for the config](#3-collect-the-freshdesk-values)
4. [Write the config](#4-write-the-config)
5. [Try it locally with a dry run](#5-try-it-locally-dry-run)
6. [Deploy to Azure](#6-deploy-to-azure)
7. [Store the keys in Key Vault](#7-store-the-keys-in-key-vault)
8. [Check the dry run, then go live](#8-check-the-logs-then-go-live)

---

## 1. Create a Sentry token

The token needs three permissions (scopes): **`org:read`**, **`project:read`**, **`event:read`**. Nothing else; the sync never writes to Sentry.

**Easiest: a personal token.** In Sentry go to *User settings → Personal Tokens → Create New Token* and tick the three scopes above. The token starts with `sntryu_`.

**Better for production: an internal integration.** Go to *Settings → Developer Settings → Custom Integrations → Create New Integration → Internal Integration*. Give it Read access to *Project*, *Organization* and *Issue & Event*. This token is not tied to one person's account.

Copy the token now. Sentry shows it only once. A token cannot be edited later; if a scope is missing, create a new token.

**Find your Sentry values:**

- **Org slug**: the first part of your Sentry URL, e.g. `https://sentry.io/organizations/my-org/` → `my-org`.
- **Project slug(s)**: Settings → Projects, the lowercase project name.
- **Base URL**: `https://sentry.io` for the US region, `https://de.sentry.io` for the EU region. Use the region shown in your browser's address bar. A wrong region gives a 403 or empty result.

## 2. Get a Freshdesk API key

1. In Freshdesk, click your profile picture → *Profile settings*.
2. Copy the **API key** shown on the right.

The key acts as that agent. Use a dedicated agent such as "Sentry Bot", so tickets are easy to recognise and the key survives staff changes. The agent must be allowed to create and view tickets in the target group.

## 3. Collect the Freshdesk values

Ask your Freshdesk admin for these, or look them up as shown:

| Config field | What it is | How to find it |
|---|---|---|
| `freshdesk.domain` | Your Freshdesk address | The URL you log in with, e.g. `mycompany.freshdesk.com` |
| `ticket.type` | Ticket type, e.g. `Incident` | *Admin → Ticket Fields → Type*. Must match exactly, or Freshdesk rejects the ticket. Leave it out to use the default. |
| `ticket.groupId` | Group that receives the tickets | `curl -u YOUR_API_KEY:X https://mycompany.freshdesk.com/api/v2/groups` and use the `id` of the group. Optional. |
| `ticket.priority` | 1 Low, 2 Medium, 3 High, 4 Urgent | Default 2 |
| `ticket.status` | 2 Open, 3 Pending, 4 Resolved, 5 Closed | Default 2 |
| `customFields` names | Custom fields you want filled in | *Admin → Ticket Fields*. Use the **API name** that starts with `cf_`, not the label. |
| `requester.fallbackEmail` | Email used when the reporter is unknown | Any valid address, e.g. `sentry-feedback@mycompany.com` |

Optional but recommended: create a text custom field (for example `cf_sentry_id`) and put its API name in `freshdesk.sentryIdField`. Every ticket then carries its Sentry issue ID. Tickets are always tagged `sentry-<id>` regardless.

## 4. Write the config

All routes live in `config/routes.json`. A minimal feedback route:

```json
{
  "$schema": "./routes.schema.json",
  "routes": [
    {
      "name": "my-team-feedback",
      "enabled": true,
      "sentry": {
        "baseUrl": "https://sentry.io",
        "org": "my-org",
        "projects": ["frontend"],
        "source": "feedback",
        "tokenSecret": "my-team-sentry-token",
        "filters": { "environment": ["production"] },
        "initialLookbackMinutes": 60
      },
      "freshdesk": {
        "domain": "mycompany.freshdesk.com",
        "apiKeySecret": "my-team-freshdesk-key",
        "ticket": {
          "type": "Incident",
          "priority": 2,
          "tags": ["sentry", "feedback"],
          "subjectTemplate": "[{project}] {title}",
          "descriptionTemplate": "{message}\n\nFrom: {userName}\nSentry: {url}",
          "requester": {
            "fallbackEmail": "sentry-feedback@mycompany.com",
            "fallbackName": "Sentry Feedback"
          }
        }
      }
    }
  ]
}
```

What to change, field by field:

| Field | Meaning |
|---|---|
| `name` | Unique name for this route: lowercase letters, digits, dashes. **Don't rename it later**, because it identifies the route's saved progress. |
| `sentry.projects` | Only these projects are read. List several to cover more than one. |
| `sentry.source` | `"feedback"` for user feedback, `"issues"` for new error issues. |
| `sentry.tokenSecret` | **Name** of the Key Vault secret holding the Sentry token (not the token itself). |
| `sentry.initialLookbackMinutes` | How far back the **first** run looks. Use `60` unless you want old items imported as tickets. |
| `freshdesk.apiKeySecret` | **Name** of the Key Vault secret holding the Freshdesk key. |
| `subjectTemplate`, `descriptionTemplate` | Ticket text. `{placeholders}` are replaced by Sentry data. |

Secret names may only contain letters, digits and dashes.

**Placeholders you can use in templates and custom fields:** `{project}` `{title}` `{message}` `{url}` `{level}` `{environment}` `{userName}` `{userEmail}` `{eventCount}` `{firstSeen}` `{lastSeen}` `{culprit}` `{shortId}` `{sentryId}`. A typo is caught when the config is validated.

> **Privacy:** only the data a template uses is read and sent. If you don't put `{userEmail}` in a template, it never reaches Freshdesk. The one exception is the feedback reporter, who becomes the ticket requester. Set `"fromFeedback": false` under `requester` to turn that off and always use the fallback address.

### More than one project, different settings

Use `projectOverrides` to give some projects their own group, priority, tags or custom fields:

```json
"freshdesk": {
  "ticket": { "groupId": 100, "priority": 2, "customFields": { "cf_source": "sentry" }, ... },
  "projectOverrides": {
    "frontend": { "groupId": 456, "customFields": { "cf_product": "Web app" } },
    "backend":  { "priority": 3 }
  }
}
```

Fields you leave out are inherited from `ticket`. Custom fields are merged and tags are added. Use separate routes instead if projects need different tokens or Freshdesk accounts.

### Number, checkbox and date custom fields

Freshdesk rejects text in these fields. Add a type so the value is converted:

```json
"customFields": {
  "cf_source": "sentry",
  "cf_event_count": { "value": "{eventCount}", "type": "number" },
  "cf_first_seen":  { "value": "{firstSeen}",  "type": "date" }
}
```

Types: `text`, `number`, `boolean`, `date`. If a value is empty or can't be converted, that one field is skipped and a warning is logged. The ticket is still created.

### Error issues instead of feedback

Set `"source": "issues"` and add an `issues` block:

```json
"issues": { "minEvents": 5, "levels": ["error", "fatal"], "noteOnRepeat": false }
```

A ticket is created once per issue, when it has at least `minEvents` events. With `noteOnRepeat: true`, new events on an existing issue add a private note to its ticket (can be noisy). Only issues that first appeared within `initialLookbackMinutes` before the route's first run, or later, get tickets. Older issues are ignored, even when they are still active.

**Check the file for mistakes:**

```sh
npm install
npm run validate-config
```

It prints `OK` or tells you exactly which field is wrong.

## 5. Try it locally (dry run)

A dry run reads Sentry and **logs the tickets it would create**. It does not call Freshdesk and writes nothing, so it needs only the Sentry token.

```sh
cp local.settings.example.json local.settings.json
docker compose up -d        # local storage emulator
```

In `local.settings.json`, set the secret for your route. The setting name is the secret name in capitals, with every non-alphanumeric character replaced by `_`, prefixed with `SECRET_`:

```json
"SECRET_MY_TEAM_SENTRY_TOKEN": "sntryu_...your token..."
```

Keep `"DRY_RUN": "true"`. Then start and trigger it:

```sh
npm start
# in a second terminal:
curl -X POST http://localhost:7071/admin/functions/syncTimer -H 'Content-Type: application/json' -d '{}'
```

Look for lines like `DRY_RUN: would create ticket {...}`. Each one shows the complete ticket: subject, description, requester, tags, custom fields. Check them, adjust the templates, and repeat.

Stop with Ctrl+C and `docker compose down`. `docker compose down -v` also wipes local saved progress.

> Dry-run logs contain real reporter names and emails. Don't paste them into public places.

## 6. Deploy to Azure

Log in and create a resource group:

```sh
az login
az group create -n rg-sentry-freshdesk -l westeurope
```

Create everything with one command (Function App, storage, Key Vault, monitoring, permissions). The last argument gives **you** permission to store secrets in the vault:

```sh
az deployment group create -g rg-sentry-freshdesk -f infra/main.bicep \
  -p appName=sentryfd \
  -p vaultAdminPrincipalId=$(az ad signed-in-user show --query id -o tsv)
```

`appName` is 3–20 characters and is used to name the resources. Note the outputs at the end: `functionAppName` and `keyVaultName`. You need them below. Show them again anytime with:

```sh
az deployment group show -g rg-sentry-freshdesk -n main --query properties.outputs
```

The app starts in dry-run mode, so nothing is written to Freshdesk yet.

## 7. Store the keys in Key Vault

For every route, store the two secrets under exactly the names used in `config/routes.json`:

```sh
az keyvault secret set --vault-name <keyVaultName> --name my-team-sentry-token    --value "sntryu_..."
az keyvault secret set --vault-name <keyVaultName> --name my-team-freshdesk-key   --value "<freshdesk api key>"
```

The Function App reads them using its own managed identity; no passwords or connection strings are stored anywhere. Rotating a key means setting the secret again; the app picks up the new value within about 10 minutes.

Now publish the code and config:

```sh
npm ci
npm test
func azure functionapp publish <functionAppName>
```

Store your routes too. The deployed app reads them from Key Vault, not from the package:

```sh
npm run validate-config
az keyvault secret set --vault-name <keyVaultName> --name routes-config --file config/routes.json
```

**Config changes:** edit `config/routes.json`, run `npm run validate-config`, set the secret again. No republish; it applies within about 10 minutes.

## 8. Check the logs, then go live

In the Azure portal open the Function App → *Application Insights → Logs* and run:

```kusto
traces
| where message startswith "Route sync finished" or message startswith "DRY_RUN" or message startswith "Route sync failed"
| order by timestamp desc
```

Wait for a run (up to 10 minutes) and check:

- `Route sync finished` with `failed: 0` for each route
- `DRY_RUN: would create ticket` entries look right

Then turn dry run off:

```sh
az functionapp config appsettings set -g rg-sentry-freshdesk -n <functionAppName> --settings DRY_RUN=false
```

The next run creates real tickets. Check the first few in Freshdesk, especially custom fields.

---

## Settings reference (Azure app settings)

Set automatically by the template. Change with `az functionapp config appsettings set`.

| Setting | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `true` | `true` = log only. `false` = create tickets. |
| `SYNC_SCHEDULE` | `0 */10 * * * *` | How often it runs, in NCRONTAB format (this one is every 10 minutes). |
| `KEY_VAULT_URL` | set by template | Where secrets are read from. |
| `STATE_TABLE_URL`, `STATE_TABLE_NAME` | set by template | Where progress is saved. |
| `ROUTES_CONFIG_PATH` | not set | Use a different config file (rarely needed). |

## Adding another team later

1. Create their Sentry token and Freshdesk key (steps 1–2).
2. Store both in Key Vault with new names (step 7).
3. Add a route to `config/routes.json` with a new `name` and those secret names.
4. `npm run validate-config`, then set the `routes-config` secret again (step 7). No publish needed.

New routes follow the global `DRY_RUN` setting, so if you want to preview a new team while others are live, test it locally first (step 5) with only that route enabled.

## Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| `Invalid ... config` at startup, function missing | `config/routes.json` has an error. Run `npm run validate-config`. |
| `Route sync failed` ... `secret ... not found` | The Key Vault secret name differs from the config, or you haven't stored it yet. Also check that the deployment finished and the app has had a few minutes to receive its permissions. |
| `Sentry GET ... returned 403` | Token missing a scope (needs `org:read`, `project:read`, `event:read`), or wrong region in `baseUrl`. Create a new token. |
| `Sentry GET .../projects/... returned 404` | Wrong org or project slug. |
| `fetched: 0` every run | Nothing new matches. Check `environment` filter, the project, and that `source` is right. |
| `Ticket creation failed` ... `status 400` | Freshdesk rejected the ticket. The log includes Freshdesk's message. Usually an unknown ticket `type`, a wrong `cf_` field name or a text value in a number field (use a typed custom field). Fix the config and publish; failed items are retried automatically. |
| `status 401` / `403` from Freshdesk | Wrong API key, or the agent can't create tickets in that group. |
| `status 429` | Freshdesk rate limit. The function waits and retries by itself. Lower `maxTicketsPerRun` if it keeps happening. |
| Too many old tickets after enabling a route | `initialLookbackMinutes` was too large. |
| `truncated: true` warning | More results than `maxPages` allows. Narrow the filters or raise `maxPages`. |
| Duplicate tickets after renaming a route | Renaming resets the saved progress. Keep route names stable. |

Items that fail are never skipped: the route's progress stays before the failed item and it is retried on the next run.

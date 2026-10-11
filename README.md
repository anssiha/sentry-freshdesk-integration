# Sentry → Freshdesk sync

An Azure Function (timer trigger, TypeScript, Node 22) that copies Sentry **user feedback** and, optionally, **new error issues** into Freshdesk as tickets. One deployment serves any number of teams. Each team is a *route* in `config/routes.json`, so adding a team is a config change, not a code change.

> **New here?** Follow the step-by-step [setup guide](docs/SETUP.md): keys you need, config, deploy, go live.

## How it works

On every timer tick (default every 10 minutes), each enabled route runs on its own. A failure in one route is logged and does not stop the others.

1. Read the route cursor from Table Storage. On the first run, the cursor is `now - initialLookbackMinutes`.
2. Query Sentry's org issues endpoint for items at or after the cursor, following all pages up to `maxPages`.
   - `feedback`: `issue.category:feedback firstSeen:>=<cursor>`
   - `issues`: `issue.category:error is:unresolved level:[...] times_seen:>=<minEvents> firstSeen:>=<baseline> lastSeen:>=<cursor>`
3. For each item, oldest first:
   - **Already mapped** → skip. For `issues` with `noteOnRepeat`, add a private note when the event count grew.
   - **New** → build the ticket, **claim** the item in Table Storage (insert-if-absent), create the Freshdesk ticket, then mark the mapping `done` with the ticket ID.
4. Advance the cursor only up to the earliest item that failed or was deferred. Those items are retried next run.

### Idempotency

The state table is the source of truth: `PartitionKey = route name`, `RowKey = Sentry issue ID`.

- Claims are atomic inserts, so two overlapping runs can never both create a ticket for the same item. The loser skips it and holds its cursor.
- Every ticket gets the tag `sentry-<issueId>` and, if `sentryIdField` is set, that custom field too.
- Ticket creation is **never retried on 5xx or network errors**, because Freshdesk may have created the ticket anyway. The claim stays `pending`. Once it is older than 15 minutes, a later run searches Freshdesk for the `sentry-<id>` tag: if the ticket exists, the mapping is repaired; if not, the ticket is created.
- A clear rejection (4xx) releases the claim so the next run retries cleanly.
- 429 responses are always retried after `Retry-After`, because a rejected request was not processed.

### Why "new issues" uses a baseline

Issue routes track `lastSeen`. An issue that crosses `minEvents` must have just received an event, so it always comes back into the query window and gets its ticket then. The `baseline`, stored on the route's first run, limits tickets to issues first seen after the route started. Turning on a new route therefore does not flood Freshdesk with old issues.

## Configuration reference

`config/routes.json` is validated with zod (`src/config/schema.ts`) when the function starts. An invalid file stops the function from registering, and the host logs show why. `config/routes.schema.json` is generated from the zod schema and gives editors autocompletion. `config/routes.example.json` shows both route types.

| Field | Default | Notes |
|---|---|---|
| `name` | — | Lowercase letters, digits and dashes. **Unique; also the state partition key. Renaming a route resets its state.** |
| `enabled` | `true` | |
| `sentry.baseUrl` | `https://sentry.io` | HTTPS only. Use your region or self-hosted URL if needed (e.g. `https://de.sentry.io`). |
| `sentry.org` | — | Organization slug. |
| `sentry.projects` | — | Project slugs. Only these projects are fetched (slugs are resolved to IDs once per run). |
| `sentry.source` | — | `feedback` or `issues`. |
| `sentry.tokenSecret` | — | Key Vault **secret name** holding the Sentry token. |
| `sentry.filters.environment` | all | List of environments. |
| `sentry.initialLookbackMinutes` | `60` | How far back the first run looks. |
| `sentry.maxPages` | `10` | Safety cap (100 items per page). If hit, the cursor does not advance and a warning is logged. |
| `freshdesk.domain` | — | e.g. `mycompany.freshdesk.com`. |
| `freshdesk.apiKeySecret` | — | Key Vault **secret name** holding the Freshdesk API key. |
| `freshdesk.sentryIdField` | — | Optional custom field (`cf_...`) that receives the Sentry issue ID. Must exist in Freshdesk. |
| `freshdesk.maxTicketsPerRun` | `50` | Flood guard. Extra items are deferred to the next run. |
| `freshdesk.projectOverrides` | `{}` | Per-project ticket settings, keyed by project slug. See [Per-project overrides](#per-project-overrides). |
| `freshdesk.ticket.type` | — | Must be a ticket type that exists in Freshdesk. |
| `freshdesk.ticket.priority` | `2` | 1 Low, 2 Medium, 3 High, 4 Urgent. |
| `freshdesk.ticket.status` | `2` | 2 Open, 3 Pending, 4 Resolved, 5 Closed. |
| `freshdesk.ticket.groupId` | — | |
| `freshdesk.ticket.tags` | `[]` | `sentry-<id>` is always added. Max 32 chars per tag. |
| `freshdesk.ticket.customFields` | `{}` | Freshdesk custom fields by API name (`cf_...`). See [Custom fields](#custom-fields). |
| `freshdesk.ticket.subjectTemplate` | — | Plain text, flattened to one line, max 255 chars. |
| `freshdesk.ticket.descriptionTemplate` | — | Values are HTML-escaped; `\n` becomes `<br>`. |
| `freshdesk.ticket.requester.fromFeedback` | `true` | Feedback routes: use the reporter's email/name when present. |
| `freshdesk.ticket.requester.fallbackEmail` | — | Required. Used for issues routes and anonymous feedback. |
| `freshdesk.ticket.requester.fallbackName` | — | |
| `issues.minEvents` | `1` | Only valid for `source: "issues"`. |
| `issues.levels` | `["error","fatal"]` | |
| `issues.noteOnRepeat` | `false` | Adds a private note whenever a mapped issue's event count grows. Can be noisy for busy issues. |

### Custom fields

Keys are the field **API names** from Freshdesk Admin → Ticket Fields (e.g. `cf_product`). Freshdesk rejects unknown fields with a 400 error, which fails every item in the route until the config is fixed. Values can be:

| Form | Example | Sent as |
|---|---|---|
| Literal | `"sentry"`, `3`, `true` | As is |
| Template | `"{level}"` | Rendered text |
| Typed | `{ "value": "{eventCount}", "type": "number" }` | Converted after rendering |

`type` is one of:
- `text`
- `number`
- `boolean`: accepts `true`/`false`/`1`/`0`/`yes`/`no`
- `date`: sent as `YYYY-MM-DD`

Use a typed value for number, checkbox and date fields filled from a template, because Freshdesk rejects text in those fields.

A value that renders empty (e.g. `{userName}` on anonymous feedback) is **left out** rather than sent as `""`. A value that can't be converted to its type is also left out, and the warning `Custom field omitted` is logged with the field name and reason.

### Per-project overrides

One route can cover several projects with different ticket settings:

```json
"freshdesk": {
  "ticket": { "priority": 2, "groupId": 100, "tags": ["sentry"], "customFields": { "cf_source": "sentry" }, ... },
  "projectOverrides": {
    "mim":        { "groupId": 456, "tags": ["mim"], "customFields": { "cf_product": "MIM" } },
    "contenthub": { "priority": 3, "requester": { "fallbackEmail": "contenthub@mycompany.com" } }
  }
}
```

Any `ticket` field can be overridden. Fields left out inherit from `ticket`. Merge rules:
- `customFields` merge by key.
- `tags` are added to the base tags.
- `requester` merges field by field.
- Everything else replaces the base value.

Each key must be listed in `sentry.projects`, and unknown fields are rejected, so typos fail validation. Use separate routes instead when projects need different Sentry filters, tokens or Freshdesk accounts.

### Template placeholders

`{sentryId}` `{shortId}` `{project}` `{title}` `{message}` `{culprit}` `{url}` `{level}` `{environment}` `{userEmail}` `{userName}` `{eventCount}` `{firstSeen}` `{lastSeen}`

Unknown placeholders fail validation. Missing values render as an empty string.

| Placeholder | feedback | issues |
|---|---|---|
| `message` | Feedback text | Exception message (falls back to title) |
| `userEmail`, `userName` | From the feedback form | From the latest event's user (extra API call) |
| `environment` | Latest event's tag (extra API call) | Same |

**PII:** only placeholders that appear in a template are extracted and sent. The latest event is fetched only when a template needs `environment` (or user fields on issues routes). Logs never include emails or descriptions. The only PII sent outside templates is the feedback reporter as ticket requester, which `requester.fromFeedback: false` turns off.

## Adding a new team

1. Create a Sentry token and a Freshdesk API key (see permissions below).
2. Store them in Key Vault:
   ```sh
   az keyvault secret set --vault-name <kv> --name team-c-sentry-token --value <token>
   az keyvault secret set --vault-name <kv> --name team-c-freshdesk-key --value <key>
   ```
3. Add a route to your routes JSON (`config/routes.json`, then upload it as in [Routes in Key Vault](#routes-in-key-vault)), using those secret **names**. Start with `"enabled": true` and the app setting `DRY_RUN=true` (or test locally first).
4. Check the file: `npm run validate-config`.
5. Upload the config secret (no code deploy needed). Check the logs for `DRY_RUN: would create ticket`, then set `DRY_RUN=false`.

`DRY_RUN` applies to the whole app. It writes no tickets, notes, mappings or cursors, and never calls Freshdesk, so the Freshdesk API key secret is not needed. Only the Sentry token is required. Each item that would become a ticket is logged as `DRY_RUN: would create ticket` together with the full Freshdesk payload (subject, HTML description, requester, tags, custom fields).

> **PII note:** that payload contains whatever the templates render, including reporter emails, so dry-run logs land in App Insights with that data. Keep dry runs short in production, or preview locally.

## Required permissions

**Sentry.** Use an internal integration token (preferred) or a personal token with these scopes:
- `org:read`: org issues endpoint
- `project:read`: resolve project slugs to IDs
- `event:read`: issues and latest events

**Freshdesk.** API key of an agent who can:
- create tickets in the target group(s)
- view tickets (search by tag, used for reconciliation)
- add notes (only with `noteOnRepeat`)

Prefer a dedicated agent account so tickets and API rate-limit usage are attributable. Freshdesk rate limits apply to the whole account. Routes run one after another, and 429 responses are retried after `Retry-After` (up to 4 times, waiting at most 120s each).

## Local development

Requirements: Node 22, [Azure Functions Core Tools v4](https://learn.microsoft.com/azure/azure-functions/functions-run-local), Docker.

```sh
npm install
cp local.settings.example.json local.settings.json   # edit secrets
docker compose up -d                                 # Azurite: blob/queue/table storage
npm start                                            # builds, then func start
```

`docker-compose.yml` runs [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) on `127.0.0.1:10000-10002`. The Functions host uses its blob/queue storage and the sync state lives in its table storage. `UseDevelopmentStorage=true` in `local.settings.json` points at it. State persists in the `azurite-data` volume:

```sh
docker compose down      # stop, keep state
docker compose down -v   # stop and wipe all cursors and mappings
```

To browse the state table, connect [Azure Storage Explorer](https://azure.microsoft.com/products/storage/storage-explorer) to the local emulator.

Secrets resolve like this:
- `KEY_VAULT_URL` empty → secret `team-a-sentry-token` is read from env var `SECRET_TEAM_A_SENTRY_TOKEN` (uppercased, non-alphanumerics become `_`).
- `KEY_VAULT_URL` set → read from Key Vault with `DefaultAzureCredential` (run `az login` locally).

To trigger the timer immediately while `func start` runs:
```sh
curl -X POST http://localhost:7071/admin/functions/syncTimer -H 'Content-Type: application/json' -d '{}'
```

| App setting | Purpose |
|---|---|
| `SYNC_SCHEDULE` | NCRONTAB, e.g. `0 */10 * * * *` |
| `DRY_RUN` | `true` to log only |
| `KEY_VAULT_URL` | Key Vault URI. Empty means env secrets (local only). |
| `STATE_TABLE_URL` | Table endpoint, `https://<account>.table.core.windows.net/` (managed identity) |
| `STATE_CONNECTION_STRING` | Alternative to `STATE_TABLE_URL`, e.g. `UseDevelopmentStorage=true` for Azurite |
| `STATE_TABLE_NAME` | Default `sentrysync` |
| `ROUTES_CONFIG_SECRET` | Name of the secret holding the routes JSON. Set by the template (`routes-config`). Empty means read the config file. |
| `ROUTES_CONFIG_PATH` | Override the config file path (file mode only) |

## Tests

```sh
npm test            # vitest
npm run typecheck   # src, tests, scripts
npm run schema      # regenerate config/routes.schema.json after schema changes
```

`processRoute` has no Azure dependencies. Tests inject in-memory fakes for Sentry, Freshdesk and state (`test/fakes.ts`).

## Deploy

`infra/main.bicep` creates:
- a Flex Consumption Function App with a system-assigned identity
- Storage (shared keys disabled), holding the host storage, the deployment package container and the state table
- Key Vault (RBAC, purge protection)
- Log Analytics and App Insights
- role assignments: Storage Blob Data Owner, Queue Data Contributor and Table Data Contributor on the storage account; Key Vault Secrets User on the vault

```sh
az group create -n rg-sentry-freshdesk -l westeurope
az deployment group create -g rg-sentry-freshdesk -f infra/main.bicep \
  -p appName=sentryfd vaultAdminPrincipalId=$(az ad signed-in-user show --query id -o tsv)

# store secrets (names must match config/routes.json)
az keyvault secret set --vault-name <keyVaultName output> --name team-a-sentry-token --value ...
az keyvault secret set --vault-name <keyVaultName output> --name team-a-freshdesk-key --value ...

npm ci && npm run build && npm test
func azure functionapp publish <functionAppName output>
```

The template deploys with `DRY_RUN=true`. When the logs look right:
```sh
az functionapp config appsettings set -g rg-sentry-freshdesk -n <functionAppName> --settings DRY_RUN=false
```

### Routes in Key Vault

The infra sets the app setting `ROUTES_CONFIG_SECRET=routes-config`. With that setting, the app ignores any packaged file and reads the routes JSON from that Key Vault secret on every run (secrets are cached for 10 minutes, so a change applies within about 10 minutes, with no restart or redeploy). An invalid secret fails the run with a `Route sync failed`-style error; fix the secret and the next run recovers.

```sh
npm run validate-config                                   # checks your local config/routes.json
az keyvault secret set --vault-name <keyVaultName> --name routes-config --file config/routes.json
```

Create this secret before deploying the infra change that adds the setting, or the app will fail until it exists. Without `ROUTES_CONFIG_SECRET` (local development), routes come from `config/routes.json` or `ROUTES_CONFIG_PATH` and are validated at startup. Locally you can also test secret mode with `ROUTES_CONFIG_SECRET=routes-config` and `SECRET_ROUTES_CONFIG='<json>'`.

### GitHub Actions

Workflows in `.github/workflows/`:

| Workflow | Trigger | Does |
|---|---|---|
| `ci.yml` | PRs and pushes to `main` | typecheck, tests, `validate-config`, build, checks `routes.schema.json` is current, compiles the Bicep |
| `deploy-infra.yml` | push to `main` touching `infra/`, or manual | what-if, then deploy `infra/main.bicep`. Keeps the app's current `DRY_RUN` unless you choose a value when running it manually |
| `deploy-function.yml` | push to `main` touching code or `config/`, or manual | test, build, drop dev dependencies, `func azure functionapp publish` |
| `run-sync.yml` | manual | triggers `syncTimer` now and prints counts only (no names, payloads or errors, since logs are public in a public repo) |

One-time setup: run `scripts/setup-github-oidc.sh <owner>/<repo> <resource-group>`, add the repository variables it prints, and create a GitHub environment named `production` (add required reviewers to gate deploys). Login uses OIDC, so no secrets are stored in GitHub. Key Vault secrets are still set by hand.

**Keeping your org, projects and Freshdesk domain private:** `config/routes.json` is gitignored and only `config/routes.example.json` is committed (CI validates that one). The deployed app reads the real routes from the Key Vault secret `routes-config` (see [Routes in Key Vault](#routes-in-key-vault)), so the pipeline never needs them.

### Useful App Insights query

```kusto
traces
| where message startswith "Route sync finished"
| extend r = parse_json(substring(message, indexof(message, "{")))
| project timestamp, route = tostring(r.route), fetched = toint(r.fetched), created = toint(r.created),
          skipped = toint(r.skipped), failed = toint(r.failed), deferred = toint(r.deferred), dryRun = tobool(r.dryRun)
| order by timestamp desc
```

## Extending

- **Webhook trigger:** add an HTTP function that verifies Sentry's signature and calls `processRoute` for the matching route (or a single-item variant sharing the same claim/create logic). State and idempotency carry over unchanged.
- **Assumption to verify:** feedback content is read from the feedback issue's `metadata` (`message`, `contact_email`, `name`), as produced by Sentry's current User Feedback widget. The legacy "User Reports" API is not used.

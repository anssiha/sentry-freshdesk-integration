# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An Azure Function (timer trigger, TypeScript, Node 22, Functions v4 programming model) that copies Sentry user feedback and new error issues into Freshdesk tickets. One deployment serves many teams; each team is a "route" in `config/routes.json`. See [README.md](README.md) for the config reference and [docs/SETUP.md](docs/SETUP.md) for the end-to-end setup guide.

## Commands

```sh
npm run build            # tsc -> dist/ (the Functions host runs dist/src/functions/*.js)
npm test                 # vitest run (all tests in test/)
npx vitest run test/processRoute.test.ts        # single file
npx vitest run -t "name fragment"               # single test by name
npm run typecheck        # src, test and scripts (tsconfig.check.json)
npm run validate-config  # validates config/routes.json with the zod schema
npm run schema           # regenerate config/routes.schema.json after editing src/config/schema.ts
npm start                # clean + build + `func start` (needs Azurite: `docker compose up -d`, and local.settings.json)
```

Trigger the timer locally while `func start` runs: `curl -X POST http://localhost:7071/admin/functions/syncTimer -H 'Content-Type: application/json' -d '{}'`.

Deploy: `infra/main.bicep` (deploys with `DRY_RUN=true`), then `func azure functionapp publish <functionAppName>`. `config/routes.json` is gitignored (private org/domain). Deployed apps read routes from the Key Vault secret named by `ROUTES_CONFIG_SECRET` (default `routes-config`) on every run, so config changes need only `az keyvault secret set --file`, not a republish. Locally the file is used. There is no linter configured.

## Architecture

Flow: `src/functions/syncTimer.ts` -> `src/runtime.ts` (`runSync`) -> `src/sync/runRoutes.ts` -> `src/sync/processRoute.ts`.

- `runtime.ts` is the only composition root. It builds config, secrets, state store and per-route clients, once per warm instance. Secrets come from Key Vault when `KEY_VAULT_URL` is set, otherwise from `SECRET_<NAME>` env vars (`EnvSecrets`). State uses `STATE_CONNECTION_STRING` (Azurite) or `STATE_TABLE_URL` (managed identity).
- `processRoute` and `runRoutes` have no Azure dependencies. They talk to ports in `src/sync/types.ts` (`SentryPort`, `FreshdeskPort`, `StatePort`, `Logger`). Tests inject in-memory fakes from `test/fakes.ts`; follow that pattern rather than mocking modules.
- `runRoutes` runs enabled routes sequentially and isolates failures per route.
- `src/config/schema.ts` (zod) is the source of truth for config. `config/routes.schema.json` is generated from it, so never edit that file by hand. `resolveTicket.ts` merges `projectOverrides` over the base ticket; `src/templates/render.ts` handles `{placeholder}` rendering and HTML escaping.
- Config is loaded and validated at module load in `syncTimer.ts` (`initRuntime()`). An invalid `routes.json` stops the function from registering.

## Invariants to preserve

- **Idempotency lives in the Table Storage state**: `PartitionKey = route name`, `RowKey = Sentry issue ID`. An item is claimed with an atomic insert-if-absent before the Freshdesk ticket is created, then marked `done`. Renaming a route resets its state.
- **Ticket creation is never retried on 5xx or network errors**, because Freshdesk may have created the ticket anyway. A `pending` claim older than 15 minutes is reconciled by searching Freshdesk for the `sentry-<id>` tag. A 4xx releases the claim. 429 is always retried after `Retry-After` (`src/http/retry.ts`).
- **The cursor only advances up to the earliest failed or deferred item**, so those items are retried next run.
- **Issue routes track `lastSeen`** and use a stored `baseline` (first-run time) so enabling a route doesn't import old issues.
- **`DRY_RUN=true` is app-wide**: it writes no tickets, notes, mappings or cursors, and does not read the Freshdesk key secret (`runtime.ts` passes the `dryRunFreshdesk` stub, which rejects if called). Each would-be ticket is logged as `DRY_RUN: would create ticket` with the full payload, which includes PII from templates.
- Only placeholders used in templates are extracted; the latest Sentry event is fetched only when a template needs it. Logs must not contain emails or descriptions (except the dry-run payload log).

## Conventions

- Log lines append props as JSON (`message {...}`) so App Insights queries can `parse_json()` them.
- Secret names in config are Key Vault secret names (letters, digits, dashes), never values.
- `infra/main.json` is a gitignored compiled ARM build of `infra/main.bicep`; edit the Bicep only. The Key Vault and storage names are `uniqueString(resourceGroup().id, appName)` hashes, so they are deterministic per resource group and app name.

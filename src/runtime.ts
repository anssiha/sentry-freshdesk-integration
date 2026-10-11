import { randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { loadConfig, parseConfigText } from './config/load';
import type { Config, Route } from './config/schema';
import { dryRunFreshdesk, FreshdeskClient } from './freshdesk/client';
import { EnvSecrets, KeyVaultSecrets, type SecretProvider } from './secrets/keyVault';
import { SentryClient } from './sentry/client';
import { TableStateStore } from './state/tableStore';
import { runRoutes, type RouteRunOutcome } from './sync/runRoutes';
import type { Logger } from './sync/types';

interface Runtime {
  /** Set when routes come from a file. Otherwise they are read from `routesSecret` on every run. */
  fileConfig?: Config;
  routesSecret?: string;
  secrets: SecretProvider;
  state: TableStateStore;
  tableReady: Promise<void>;
}

let runtime: Runtime | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`App setting ${name} is required`);
  return value;
}

/** Built once per warm instance so config validation fails fast and secrets stay cached. */
export function initRuntime(): Runtime {
  if (runtime) return runtime;
  // ROUTES_CONFIG_SECRET names a Key Vault secret (or SECRET_* env var locally) holding the routes JSON.
  // Without it, routes come from config/routes.json (or ROUTES_CONFIG_PATH) and are validated at startup.
  const routesSecret = process.env.ROUTES_CONFIG_SECRET || undefined;
  const fileConfig = routesSecret ? undefined : loadConfig();
  const credential = new DefaultAzureCredential();
  const tableName = process.env.STATE_TABLE_NAME || 'sentrysync';

  const secrets = process.env.KEY_VAULT_URL ? new KeyVaultSecrets(process.env.KEY_VAULT_URL, credential) : new EnvSecrets();
  const state = process.env.STATE_CONNECTION_STRING
    ? TableStateStore.fromConnectionString(process.env.STATE_CONNECTION_STRING, tableName)
    : TableStateStore.fromUrl(required('STATE_TABLE_URL'), tableName, credential);

  runtime = { fileConfig, routesSecret, secrets, state, tableReady: state.ensureTable() };
  runtime.tableReady.catch(() => (runtime = undefined));
  return runtime;
}

export async function runSync(logger: Logger): Promise<RouteRunOutcome[]> {
  const rt = initRuntime();
  await rt.tableReady;
  const dryRun = process.env.DRY_RUN?.toLowerCase() === 'true';

  // Re-read per run: secrets are cached for 10 minutes, so a changed routes secret applies without a restart.
  const config = rt.fileConfig ?? parseConfigText(await rt.secrets.get(rt.routesSecret!), `Key Vault secret "${rt.routesSecret}"`);

  return runRoutes(config.routes, {
    state: rt.state,
    logger,
    dryRun,
    runId: randomUUID(),
    async clientsFor(route: Route) {
      const [token, apiKey] = await Promise.all([
        rt.secrets.get(route.sentry.tokenSecret),
        dryRun ? undefined : rt.secrets.get(route.freshdesk.apiKeySecret),
      ]);
      return {
        sentry: new SentryClient({
          baseUrl: route.sentry.baseUrl,
          org: route.sentry.org,
          projects: route.sentry.projects,
          environments: route.sentry.filters.environment,
          token,
          maxPages: route.sentry.maxPages,
        }),
        freshdesk: apiKey ? new FreshdeskClient({ domain: route.freshdesk.domain, apiKey }) : dryRunFreshdesk,
      };
    },
  });
}

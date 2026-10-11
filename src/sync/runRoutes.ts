import type { Route } from '../config/schema';
import { processRoute, type ProcessRouteDeps, type RouteResult } from './processRoute';
import type { FreshdeskPort, Logger, SentryPort, StatePort } from './types';

export interface RouteClients {
  sentry: SentryPort;
  freshdesk: FreshdeskPort;
}

export interface RunRoutesDeps {
  state: StatePort;
  logger: Logger;
  runId: string;
  dryRun: boolean;
  /** Builds per-route clients (resolves secrets). Failures are isolated to that route. */
  clientsFor(route: Route): Promise<RouteClients>;
  now?: ProcessRouteDeps['now'];
}

export type RouteRunOutcome = { route: string; ok: true; result: RouteResult } | { route: string; ok: false; error: string };

/** Runs every enabled route sequentially; a failing route never stops the others. */
export async function runRoutes(routes: Route[], deps: RunRoutesDeps): Promise<RouteRunOutcome[]> {
  const outcomes: RouteRunOutcome[] = [];
  for (const route of routes.filter((r) => r.enabled)) {
    try {
      const clients = await deps.clientsFor(route);
      const result = await processRoute(route, { ...deps, ...clients });
      outcomes.push({ route: route.name, ok: true, result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.logger.error('Route sync failed', { route: route.name, runId: deps.runId, error });
      outcomes.push({ route: route.name, ok: false, error });
    }
  }
  return outcomes;
}

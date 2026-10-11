import { app, type InvocationContext, type Timer } from '@azure/functions';
import { initRuntime, runSync } from '../runtime';
import type { Logger } from '../sync/types';

// Fail fast: an invalid config/routes.json stops the worker from registering the function.
initRuntime();

/** Props are appended as JSON so App Insights traces can be queried with parse_json(). */
function contextLogger(context: InvocationContext): Logger {
  const fmt = (message: string, props?: Record<string, unknown>) => (props ? `${message} ${JSON.stringify(props)}` : message);
  return {
    info: (message, props) => context.info(fmt(message, props)),
    warn: (message, props) => context.warn(fmt(message, props)),
    error: (message, props) => context.error(fmt(message, props)),
  };
}

app.timer('syncTimer', {
  schedule: '%SYNC_SCHEDULE%',
  runOnStartup: false,
  handler: async (timer: Timer, context: InvocationContext) => {
    const logger = contextLogger(context);
    if (timer.isPastDue) logger.warn('Timer is past due');
    const outcomes = await runSync(logger);
    const failed = outcomes.filter((o) => !o.ok).map((o) => o.route);
    logger.info('Sync run finished', { routes: outcomes.length, failedRoutes: failed });
  },
});

import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/load';
import { runRoutes } from '../src/sync/runRoutes';
import { FakeFreshdesk, FakeSentry, feedbackRouteInput, issue, MemoryLogger, MemoryState } from './fakes';

describe('runRoutes', () => {
  it('keeps processing other routes when one fails and skips disabled routes', async () => {
    const { routes } = parseConfig({
      routes: [
        feedbackRouteInput({ name: 'broken' }),
        feedbackRouteInput({ name: 'disabled', enabled: false }),
        feedbackRouteInput({ name: 'healthy' }),
      ],
    });
    const freshdesk = new FakeFreshdesk();
    const logger = new MemoryLogger();

    const outcomes = await runRoutes(routes, {
      state: new MemoryState(),
      logger,
      runId: 'run-1',
      dryRun: false,
      now: () => new Date('2026-10-09T10:30:00Z'),
      async clientsFor(route) {
        if (route.name === 'broken') throw new Error('Key Vault secret "sentry-token" not found');
        return { sentry: new FakeSentry([issue('1')]), freshdesk };
      },
    });

    expect(outcomes.map((o) => [o.route, o.ok])).toEqual([
      ['broken', false],
      ['healthy', true],
    ]);
    expect(freshdesk.created).toHaveLength(1);
    expect(logger.lines.find((l) => l.level === 'error')).toMatchObject({ message: 'Route sync failed', props: { route: 'broken' } });
  });
});

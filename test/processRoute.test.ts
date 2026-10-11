import { describe, expect, it } from 'vitest';
import { dryRunFreshdesk } from '../src/freshdesk/client';
import { buildQuery, processRoute, type ProcessRouteDeps } from '../src/sync/processRoute';
import {
  ambiguousFailure,
  definiteFailure,
  FakeFreshdesk,
  FakeSentry,
  feedbackRouteInput,
  issue,
  MemoryLogger,
  MemoryState,
  route,
} from './fakes';

const NOW = new Date('2026-10-09T10:30:00Z');

function setup(issues = [issue('1'), issue('2'), issue('3')], r = route()) {
  const sentry = new FakeSentry(issues);
  const freshdesk = new FakeFreshdesk();
  const state = new MemoryState();
  const logger = new MemoryLogger();
  const deps = (overrides: Partial<ProcessRouteDeps> = {}): ProcessRouteDeps => ({
    sentry,
    freshdesk,
    state,
    logger,
    runId: 'run-1',
    dryRun: false,
    now: () => NOW,
    ...overrides,
  });
  return { r, sentry, freshdesk, state, logger, deps };
}

describe('processRoute', () => {
  it('creates one ticket per new item and advances the cursor to the newest item', async () => {
    const { r, freshdesk, state, deps } = setup();
    const result = await processRoute(r, deps());

    expect(result).toMatchObject({ fetched: 3, created: 3, skipped: 0, failed: 0 });
    expect(freshdesk.created.map((t) => t.tags)).toEqual([
      ['sentry', 'sentry-1'],
      ['sentry', 'sentry-2'],
      ['sentry', 'sentry-3'],
    ]);
    expect(state.cursors.get(r.name)?.cursor).toBe('2026-10-09T10:00:03.000Z');
    expect(await state.getMapping(r.name, '2')).toMatchObject({ status: 'done', ticketId: 1001 });
  });

  it('uses the feedback reporter as requester and falls back when missing', async () => {
    const anonymous = issue('2', { metadata: { message: 'hi' } });
    const { r, freshdesk, deps } = setup([issue('1'), anonymous]);
    await processRoute(r, deps());

    expect(freshdesk.created[0]).toMatchObject({ email: 'user1@example.com', name: 'User 1' });
    expect(freshdesk.created[1]).toMatchObject({ email: 'fallback@acme.test', name: 'Sentry' });
  });

  it('is idempotent across repeated runs', async () => {
    const { r, freshdesk, state, deps } = setup();
    await processRoute(r, deps());
    state.cursors.clear(); // force a full re-fetch of the same items
    const second = await processRoute(r, deps({ runId: 'run-2' }));

    expect(freshdesk.created).toHaveLength(3);
    expect(second).toMatchObject({ created: 0, skipped: 3 });
  });

  it('does not create duplicates when two runs overlap', async () => {
    const { r, freshdesk, state, deps } = setup([issue('1')]);
    await state.claim(r.name, '1', 'other-run', NOW); // another run holds a fresh claim

    const result = await processRoute(r, deps());

    expect(freshdesk.created).toHaveLength(0);
    expect(result).toMatchObject({ deferred: 1 });
  });

  it('holds the cursor at the earliest failed item and retries it next run', async () => {
    const { r, freshdesk, state, deps } = setup();
    freshdesk.failures.set('2', definiteFailure());

    const first = await processRoute(r, deps());
    expect(first).toMatchObject({ created: 2, failed: 1 });
    expect(state.cursors.get(r.name)?.cursor).toBe('2026-10-09T10:00:02.000Z');
    expect(await state.getMapping(r.name, '2')).toBeNull(); // definite failure releases the claim

    freshdesk.failures.clear();
    const second = await processRoute(r, deps({ runId: 'run-2' }));
    expect(second).toMatchObject({ created: 1, skipped: 2 });
    expect(freshdesk.created.map((t) => t.tags.at(-1)).sort()).toEqual(['sentry-1', 'sentry-2', 'sentry-3']);
    expect(state.cursors.get(r.name)?.cursor).toBe('2026-10-09T10:00:03.000Z');
  });

  it('keeps the claim on ambiguous failures and reconciles via tag once stale', async () => {
    const { r, freshdesk, state, deps } = setup([issue('1')]);
    freshdesk.failures.set('1', ambiguousFailure());
    await processRoute(r, deps());
    expect(await state.getMapping(r.name, '1')).toMatchObject({ status: 'pending' });

    // Pretend Freshdesk actually created the ticket despite the 503.
    freshdesk.failures.clear();
    freshdesk.byTag.set('sentry-1', 777);

    const soon = await processRoute(r, deps({ now: () => new Date(NOW.getTime() + 60_000) }));
    expect(soon).toMatchObject({ deferred: 1 });

    const later = await processRoute(r, deps({ now: () => new Date(NOW.getTime() + 20 * 60_000) }));
    expect(later).toMatchObject({ skipped: 1, created: 0 });
    expect(freshdesk.created).toHaveLength(0);
    expect(await state.getMapping(r.name, '1')).toMatchObject({ status: 'done', ticketId: 777 });
  });

  it('creates the ticket after a stale claim when Freshdesk has none', async () => {
    const { r, freshdesk, state, deps } = setup([issue('1')]);
    await state.claim(r.name, '1', 'crashed-run', new Date(NOW.getTime() - 60 * 60_000));

    const result = await processRoute(r, deps());
    expect(result).toMatchObject({ created: 1 });
    expect(freshdesk.created).toHaveLength(1);
  });

  it('writes nothing in dry-run mode', async () => {
    const { r, freshdesk, state, logger, deps } = setup();
    const result = await processRoute(r, deps({ dryRun: true }));

    expect(result).toMatchObject({ created: 3, dryRun: true });
    expect(freshdesk.created).toHaveLength(0);
    expect(state.writes).toBe(0);
    expect(logger.lines.filter((l) => l.message.startsWith('DRY_RUN'))).toHaveLength(3);
  });

  it('never calls Freshdesk in dry-run mode and logs the full ticket payload', async () => {
    const input = feedbackRouteInput();
    const r = route({ ...input, sentry: { ...input.sentry, source: 'issues' }, issues: { noteOnRepeat: true } });
    const { state, logger, deps } = setup([issue('1'), issue('2', { count: '99' }), issue('3')], r);
    await state.claim(r.name, '1', 'crashed-run', new Date(NOW.getTime() - 60 * 60_000)); // stale claim
    await state.complete(r.name, '2', 500, 10); // mapped, would get a repeat note
    const writesBefore = state.writes;

    const result = await processRoute(r, deps({ dryRun: true, freshdesk: dryRunFreshdesk }));

    expect(result).toMatchObject({ created: 1, noted: 1, deferred: 1, failed: 0 });
    expect(state.writes).toBe(writesBefore);
    const preview = logger.lines.find((l) => l.message === 'DRY_RUN: would create ticket');
    expect(preview?.props).toMatchObject({
      sentryId: '3',
      ticket: { subject: '[web] Issue 3', email: 'fallback@acme.test', tags: ['sentry', 'sentry-3'], priority: 2, status: 2 },
    });
  });

  it('does not advance the cursor when Sentry results are truncated', async () => {
    const { r, sentry, state, deps } = setup();
    sentry.truncated = true;
    const result = await processRoute(r, deps());
    expect(result.cursorTo).toBe(result.cursorFrom);
    expect(state.cursors.get(r.name)?.cursor).toBe(result.cursorFrom);
  });

  it('defers items beyond maxTicketsPerRun', async () => {
    const input = feedbackRouteInput();
    const r = route({ ...input, freshdesk: { ...input.freshdesk, maxTicketsPerRun: 2 } });
    const { freshdesk, state, deps } = setup(undefined, r);

    const result = await processRoute(r, deps());
    expect(result).toMatchObject({ created: 2, deferred: 1 });
    expect(freshdesk.created).toHaveLength(2);
    expect(state.cursors.get(r.name)?.cursor).toBe('2026-10-09T10:00:03.000Z');
  });

  it('starts from initialLookbackMinutes on the first run and keeps the baseline', async () => {
    const { r, sentry, state, deps } = setup([]);
    await processRoute(r, deps());
    expect(sentry.queries[0]?.query).toBe('issue.category:feedback firstSeen:>=2026-10-09T09:30:00');
    expect(state.cursors.get(r.name)).toMatchObject({ cursor: '2026-10-09T09:30:00.000Z', baseline: '2026-10-09T09:30:00.000Z' });
  });

  it('applies per-project overrides and fetches the latest event only where needed', async () => {
    const input = feedbackRouteInput();
    const r = route({
      ...input,
      sentry: { ...input.sentry, projects: ['web', 'api'] },
      freshdesk: {
        ...input.freshdesk,
        ticket: { ...input.freshdesk.ticket, groupId: 1, customFields: { cf_events: { value: '{eventCount}', type: 'number' } } },
        projectOverrides: {
          api: { groupId: 2, priority: 3, descriptionTemplate: '{message} ({environment})', customFields: { cf_product: 'API' } },
        },
      },
    });
    const { sentry, freshdesk, deps } = setup([issue('1'), issue('2', { project: { id: '2', slug: 'api' } })], r);
    sentry.event = { tags: [{ key: 'environment', value: 'production' }] };

    await processRoute(r, deps());

    expect(freshdesk.created[0]).toMatchObject({ group_id: 1, priority: 2, custom_fields: { cf_events: 10 } });
    expect(freshdesk.created[1]).toMatchObject({
      group_id: 2,
      priority: 3,
      description: 'Feedback 2 (production)',
      custom_fields: { cf_events: 10, cf_product: 'API' },
    });
    expect(sentry.eventCalls).toEqual(['2']);
  });

  it('isolates state per route name', async () => {
    const { r, freshdesk, state, deps } = setup([issue('1')]);
    const other = route(feedbackRouteInput({ name: 'team-b-feedback' }));
    await processRoute(r, deps());
    await processRoute(other, deps());
    expect(freshdesk.created).toHaveLength(2);
    expect(state.cursors.size).toBe(2);
  });
});

describe('issues routes', () => {
  const issuesRoute = (issuesBlock: Record<string, unknown> = {}, descriptionTemplate = '{message}\n{url}') => {
    const input = feedbackRouteInput({ name: 'team-b-errors' });
    return route({
      ...input,
      sentry: { ...input.sentry, source: 'issues' },
      freshdesk: { ...input.freshdesk, ticket: { ...input.freshdesk.ticket, descriptionTemplate } },
      issues: { minEvents: 5, levels: ['error', 'fatal'], ...issuesBlock },
    });
  };

  it('builds a lastSeen query restricted to new issues meeting the thresholds', () => {
    const q = buildQuery(issuesRoute(), '2026-10-09T11:50:00.000Z', '2026-10-01T00:00:00.000Z');
    expect(q).toEqual({
      query:
        'issue.category:error is:unresolved level:[error,fatal] times_seen:>=5 firstSeen:>=2026-10-01T00:00:00 lastSeen:>=2026-10-09T11:50:00',
      sort: 'date',
      start: '2026-10-09T11:50:00.000Z',
    });
  });

  it('never uses the issue reporter as requester and advances by lastSeen', async () => {
    const r = issuesRoute();
    const { freshdesk, state, deps } = setup([issue('1', { metadata: { value: 'TypeError: x is undefined' } })], r);
    await processRoute(r, deps());
    expect(freshdesk.created[0]).toMatchObject({ email: 'fallback@acme.test', description: 'TypeError: x is undefined<br>https://acme.sentry.io/issues/1/' });
    expect(state.cursors.get(r.name)?.cursor).toBe('2026-10-09T10:05:01.000Z');
  });

  it('skips repeat occurrences of mapped issues by default', async () => {
    const r = issuesRoute();
    const { sentry, freshdesk, state, deps } = setup([issue('1')], r);
    await processRoute(r, deps());
    sentry.issues = [issue('1', { count: '50', lastSeen: '2026-10-09T10:29:00Z' })];
    const second = await processRoute(r, deps());
    expect(second).toMatchObject({ skipped: 1, noted: 0 });
    expect(freshdesk.notes).toHaveLength(0);
    expect(state.cursors.get(r.name)?.cursor).toBe('2026-10-09T10:29:00.000Z');
  });

  it('adds a private note on repeat occurrences when noteOnRepeat is enabled', async () => {
    const r = issuesRoute({ noteOnRepeat: true });
    const { sentry, freshdesk, state, deps } = setup([issue('1')], r);
    await processRoute(r, deps());
    sentry.issues = [issue('1', { count: '50' })];
    const second = await processRoute(r, deps());
    expect(second).toMatchObject({ noted: 1, created: 0 });
    expect(freshdesk.notes[0]?.ticketId).toBe(1000);
    expect(await state.getMapping(r.name, '1')).toMatchObject({ eventCount: 50 });
    const third = await processRoute(r, deps());
    expect(third).toMatchObject({ noted: 0, skipped: 1 });
  });

  it('fetches the latest event only when templates need event data', async () => {
    const without = issuesRoute();
    const a = setup([issue('1')], without);
    await processRoute(without, a.deps());
    expect(a.sentry.eventCalls).toEqual([]);

    const withEnv = issuesRoute({}, '{message} ({environment})');
    const b = setup([issue('1')], withEnv);
    b.sentry.event = { tags: [{ key: 'environment', value: 'production' }], user: { email: 'secret@example.com' } };
    await processRoute(withEnv, b.deps());
    expect(b.sentry.eventCalls).toEqual(['1']);
    expect(b.freshdesk.created[0]?.description).toBe('Issue 1 (production)');
    expect(JSON.stringify(b.freshdesk.created[0])).not.toContain('secret@example.com');
  });
});

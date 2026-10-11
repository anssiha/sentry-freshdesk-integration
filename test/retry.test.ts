import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, HttpError, parseRetryAfter, type HttpDeps } from '../src/http/retry';
import { FreshdeskClient } from '../src/freshdesk/client';

function deps(responses: (Response | Error)[]): HttpDeps & { sleeps: number[]; calls: number } {
  const state = { sleeps: [] as number[], calls: 0 };
  return Object.assign(state, {
    fetch: vi.fn(async () => {
      const next = responses[state.calls++];
      if (!next) throw new Error('no more responses');
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
    sleep: async (ms: number) => void state.sleeps.push(ms),
    random: () => 0.5,
  });
}

const status = (code: number, headers: Record<string, string> = {}) => new Response(code === 204 ? null : '{}', { status: code, headers });

describe('fetchWithRetry', () => {
  it('honors Retry-After seconds on 429', async () => {
    const d = deps([status(429, { 'retry-after': '7' }), status(200)]);
    const res = await fetchWithRetry('https://x.test/a', {}, {}, d);
    expect(res.status).toBe(200);
    expect(d.sleeps).toEqual([7000]);
  });

  it('honors Retry-After HTTP dates', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(parseRetryAfter('Fri, 09 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('garbage', now)).toBeUndefined();
  });

  it('retries 429 even for non-idempotent requests', async () => {
    const d = deps([status(429, { 'retry-after': '1' }), status(201)]);
    const res = await fetchWithRetry('https://x.test/a', { method: 'POST' }, { retryOnServerError: false }, d);
    expect(res.status).toBe(201);
  });

  it('gives up after maxRetries and returns the last 429', async () => {
    const d = deps([status(429), status(429), status(429)]);
    const res = await fetchWithRetry('https://x.test/a', {}, { maxRetries: 2 }, d);
    expect(res.status).toBe(429);
    expect(d.calls).toBe(3);
  });

  it('does not wait for Retry-After values above the cap', async () => {
    const d = deps([status(429, { 'retry-after': '3600' })]);
    const res = await fetchWithRetry('https://x.test/a', {}, { maxRetryAfterMs: 60_000 }, d);
    expect(res.status).toBe(429);
    expect(d.sleeps).toEqual([]);
  });

  it('backs off exponentially on 5xx', async () => {
    const d = deps([status(503), status(502), status(500), status(200)]);
    await fetchWithRetry('https://x.test/a', {}, { baseDelayMs: 100 }, d);
    expect(d.sleeps).toEqual([75, 150, 300]);
  });

  it('does not retry 5xx or network errors when retryOnServerError is false', async () => {
    const d = deps([status(503)]);
    expect((await fetchWithRetry('https://x.test/a', {}, { retryOnServerError: false }, d)).status).toBe(503);

    const n = deps([new TypeError('fetch failed')]);
    await expect(fetchWithRetry('https://x.test/a', {}, { retryOnServerError: false }, n)).rejects.toMatchObject({
      name: 'HttpError',
      ambiguous: true,
    });
  });
});

describe('FreshdeskClient.createTicket', () => {
  const ticket = { subject: 's', description: 'd', email: 'a@b.c', priority: 1, status: 2, tags: ['sentry-1'] };

  it('retries 429 then succeeds', async () => {
    const d = deps([status(429, { 'retry-after': '2' }), new Response('{"id":42}', { status: 201 })]);
    const client = new FreshdeskClient({ domain: 'acme.freshdesk.com', apiKey: 'k' }, d);
    expect(await client.createTicket(ticket)).toEqual({ id: 42 });
    expect(d.sleeps).toEqual([2000]);
  });

  it('marks 4xx as definite and 5xx as ambiguous without retrying', async () => {
    const client400 = new FreshdeskClient({ domain: 'acme.freshdesk.com', apiKey: 'k' }, deps([status(400)]));
    await expect(client400.createTicket(ticket)).rejects.toMatchObject({ status: 400, ambiguous: false });

    const d = deps([status(500), status(201)]);
    const client500 = new FreshdeskClient({ domain: 'acme.freshdesk.com', apiKey: 'k' }, d);
    const err = await client500.createTicket(ticket).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 500, ambiguous: true });
    expect(d.calls).toBe(1);
  });
});

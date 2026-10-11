import { describe, expect, it } from 'vitest';
import type { HttpDeps } from '../src/http/retry';
import { nextCursor, SentryClient } from '../src/sentry/client';
import { issue } from './fakes';

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const link = (cursor: string, more: boolean) =>
  `<https://sentry.io/api/0/x/?cursor=prev>; rel="previous"; results="false"; cursor="prev", ` +
  `<https://sentry.io/api/0/x/?cursor=${cursor}>; rel="next"; results="${more}"; cursor="${cursor}"`;

describe('Sentry client', () => {
  it('parses the next cursor only when more results exist', () => {
    expect(nextCursor(link('abc:100:0', true))).toBe('abc:100:0');
    expect(nextCursor(link('abc:100:0', false))).toBeUndefined();
    expect(nextCursor(null)).toBeUndefined();
  });

  it('resolves project slugs, paginates, and reports truncation at maxPages', async () => {
    const urls: string[] = [];
    const pages = [json([issue('1')], { link: link('c1', true) }), json([issue('2')], { link: link('c2', true) })];
    const http: HttpDeps = {
      fetch: (async (url: string) => {
        urls.push(url);
        if (url.includes('/projects/')) return json({ id: '42' });
        return pages.shift()!;
      }) as unknown as typeof fetch,
      sleep: async () => {},
      random: () => 0,
    };
    const client = new SentryClient(
      { baseUrl: 'https://sentry.io/', org: 'acme', projects: ['web'], environments: ['production'], token: 't', maxPages: 2 },
      http,
    );

    const res = await client.listIssues({ query: 'issue.category:feedback', sort: 'new', start: '2026-10-09T10:00:00.000Z' });

    expect(res.issues.map((i) => i.id)).toEqual(['1', '2']);
    expect(res.truncated).toBe(true);
    expect(urls[0]).toBe('https://sentry.io/api/0/projects/acme/web/');
    const second = new URL(urls[2]!);
    expect(second.pathname).toBe('/api/0/organizations/acme/issues/');
    expect(second.searchParams.getAll('project')).toEqual(['42']);
    expect(second.searchParams.get('environment')).toBe('production');
    expect(second.searchParams.get('cursor')).toBe('c1');
  });
});

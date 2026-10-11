import { defaultHttpDeps, fetchWithRetry, HttpError, readJson, type HttpDeps } from '../http/retry';
import type { IssueQuery, SentryPort } from '../sync/types';
import type { SentryEvent, SentryIssue } from './types';

export interface SentryClientOptions {
  baseUrl: string;
  org: string;
  projects: string[];
  environments?: string[];
  token: string;
  maxPages: number;
}

const PAGE_SIZE = 100;

/** Parses Sentry's Link header and returns the next cursor if more results exist. */
export function nextCursor(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(',')) {
    if (/rel="next"/.test(part) && /results="true"/.test(part)) {
      return /cursor="([^"]+)"/.exec(part)?.[1];
    }
  }
  return undefined;
}

export class SentryClient implements SentryPort {
  private projectIds?: Promise<string[]>;
  private readonly api: string;

  constructor(
    private readonly opts: SentryClientOptions,
    private readonly http: HttpDeps = defaultHttpDeps,
  ) {
    this.api = `${opts.baseUrl.replace(/\/+$/, '')}/api/0`;
  }

  private async get<T>(url: string): Promise<{ data: T; res: Response }> {
    const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${this.opts.token}` } }, {}, this.http);
    const data = await readJson<T>(res, `Sentry GET ${url.split('?')[0]}`);
    return { data, res };
  }

  /** The org issues endpoint filters by numeric project ID, so resolve slugs once per client. */
  private resolveProjectIds(): Promise<string[]> {
    this.projectIds ??= Promise.all(
      this.opts.projects.map(async (slug) => {
        const url = `${this.api}/projects/${encodeURIComponent(this.opts.org)}/${encodeURIComponent(slug)}/`;
        const { data } = await this.get<{ id: string }>(url);
        return String(data.id);
      }),
    ).catch((err: unknown) => {
      this.projectIds = undefined;
      throw err;
    });
    return this.projectIds;
  }

  async listIssues(q: IssueQuery): Promise<{ issues: SentryIssue[]; truncated: boolean }> {
    const params = new URLSearchParams({
      query: q.query,
      sort: q.sort,
      limit: String(PAGE_SIZE),
      start: q.start,
      end: new Date().toISOString(),
    });
    for (const id of await this.resolveProjectIds()) params.append('project', id);
    for (const env of this.opts.environments ?? []) params.append('environment', env);

    const issues: SentryIssue[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.opts.maxPages; page++) {
      if (cursor) params.set('cursor', cursor);
      const url = `${this.api}/organizations/${encodeURIComponent(this.opts.org)}/issues/?${params}`;
      const { data, res } = await this.get<SentryIssue[]>(url);
      issues.push(...data);
      cursor = nextCursor(res.headers.get('link'));
      if (!cursor) return { issues, truncated: false };
    }
    return { issues, truncated: true };
  }

  async getLatestEvent(issueId: string): Promise<SentryEvent | null> {
    const url = `${this.api}/organizations/${encodeURIComponent(this.opts.org)}/issues/${encodeURIComponent(issueId)}/events/latest/`;
    try {
      return (await this.get<SentryEvent>(url)).data;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }
}

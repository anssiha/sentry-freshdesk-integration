import { defaultHttpDeps, fetchWithRetry, readJson, type HttpDeps } from '../http/retry';
import type { FreshdeskPort, NewTicket } from '../sync/types';

export interface FreshdeskClientOptions {
  domain: string;
  apiKey: string;
}

/** Stand-in for dry runs, so no Freshdesk API key is needed. processRoute never calls it when dryRun is set. */
export const dryRunFreshdesk: FreshdeskPort = {
  createTicket: () => Promise.reject(new Error('Freshdesk called during dry run')),
  findTicketIdByTag: () => Promise.reject(new Error('Freshdesk called during dry run')),
  addNote: () => Promise.reject(new Error('Freshdesk called during dry run')),
};

/** Freshdesk REST API v2. Rate limits are per account; 429 responses are retried after Retry-After. */
export class FreshdeskClient implements FreshdeskPort {
  private readonly api: string;
  private readonly auth: string;

  constructor(
    opts: FreshdeskClientOptions,
    private readonly http: HttpDeps = defaultHttpDeps,
  ) {
    this.api = `https://${opts.domain}/api/v2`;
    this.auth = `Basic ${Buffer.from(`${opts.apiKey}:X`).toString('base64')}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: this.auth, 'Content-Type': 'application/json' };
  }

  async createTicket(ticket: NewTicket): Promise<{ id: number }> {
    // POST is not idempotent: never retry 5xx/network errors here. The caller keeps the
    // claim pending and reconciles by tag on a later run instead.
    const res = await fetchWithRetry(
      `${this.api}/tickets`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify(ticket) },
      { retryOnServerError: false },
      this.http,
    );
    const created = await readJson<{ id: number }>(res, 'Freshdesk POST /tickets');
    return { id: created.id };
  }

  async findTicketIdByTag(tag: string): Promise<number | null> {
    const query = encodeURIComponent(`"tag:'${tag.replaceAll("'", '')}'"`);
    const res = await fetchWithRetry(`${this.api}/search/tickets?query=${query}`, { headers: this.headers() }, {}, this.http);
    const data = await readJson<{ results: { id: number }[] }>(res, 'Freshdesk GET /search/tickets');
    return data.results[0]?.id ?? null;
  }

  async addNote(ticketId: number, body: string): Promise<void> {
    const res = await fetchWithRetry(
      `${this.api}/tickets/${ticketId}/notes`,
      { method: 'POST', headers: this.headers(), body: JSON.stringify({ body, private: true }) },
      { retryOnServerError: false },
      this.http,
    );
    await readJson(res, 'Freshdesk POST /tickets/{id}/notes');
  }
}

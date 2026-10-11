import { parseConfig } from '../src/config/load';
import type { ConfigInput, Route } from '../src/config/schema';
import { HttpError } from '../src/http/retry';
import type { SentryEvent, SentryIssue } from '../src/sentry/types';
import type { CursorState, FreshdeskPort, IssueQuery, Logger, Mapping, NewTicket, SentryPort, StatePort } from '../src/sync/types';

type RouteInput = ConfigInput['routes'][number];

export function feedbackRouteInput(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    name: 'team-a-feedback',
    sentry: { org: 'acme', projects: ['web'], source: 'feedback', tokenSecret: 'sentry-token' },
    freshdesk: {
      domain: 'acme.freshdesk.com',
      apiKeySecret: 'fd-key',
      ticket: {
        tags: ['sentry'],
        subjectTemplate: '[{project}] {title}',
        descriptionTemplate: '{message}\n\nSentry: {url}',
        requester: { fallbackEmail: 'fallback@acme.test', fallbackName: 'Sentry' },
      },
    },
    ...overrides,
  };
}

export function route(input: RouteInput = feedbackRouteInput()): Route {
  return parseConfig({ routes: [input] }).routes[0]!;
}

export function issue(id: string, overrides: Partial<SentryIssue> = {}): SentryIssue {
  return {
    id,
    shortId: `WEB-${id}`,
    title: `Issue ${id}`,
    culprit: 'app.js',
    permalink: `https://acme.sentry.io/issues/${id}/`,
    level: 'error',
    count: '10',
    firstSeen: `2026-10-09T10:00:0${id.slice(-1)}Z`,
    lastSeen: `2026-10-09T10:05:0${id.slice(-1)}Z`,
    project: { id: '1', slug: 'web' },
    metadata: { message: `Feedback ${id}`, contact_email: `user${id}@example.com`, name: `User ${id}` },
    ...overrides,
  };
}

export class FakeSentry implements SentryPort {
  queries: IssueQuery[] = [];
  eventCalls: string[] = [];
  truncated = false;
  constructor(
    public issues: SentryIssue[] = [],
    public event: SentryEvent | null = null,
  ) {}
  async listIssues(q: IssueQuery) {
    this.queries.push(q);
    return { issues: this.issues.map((i) => ({ ...i })), truncated: this.truncated };
  }
  async getLatestEvent(issueId: string) {
    this.eventCalls.push(issueId);
    return this.event;
  }
}

export class FakeFreshdesk implements FreshdeskPort {
  created: (NewTicket & { id: number })[] = [];
  notes: { ticketId: number; body: string }[] = [];
  /** Sentry IDs whose ticket creation fails, with the error to throw. */
  failures = new Map<string, Error>();
  byTag = new Map<string, number>();
  private nextId = 1000;

  async createTicket(ticket: NewTicket) {
    const sentryTag = ticket.tags.find((t) => t.startsWith('sentry-'))!;
    const err = this.failures.get(sentryTag.slice('sentry-'.length));
    if (err) throw err;
    const id = this.nextId++;
    this.created.push({ ...ticket, id });
    this.byTag.set(sentryTag, id);
    return { id };
  }
  async findTicketIdByTag(tag: string) {
    return this.byTag.get(tag) ?? null;
  }
  async addNote(ticketId: number, body: string) {
    this.notes.push({ ticketId, body });
  }
}

export const definiteFailure = () => new HttpError('Freshdesk POST /tickets returned 400', 400, false, '{"errors":[]}');
export const ambiguousFailure = () => new HttpError('Freshdesk POST /tickets returned 503', 503, true);

type Row = { status: 'pending'; claimedAt: string; runId: string } | { status: 'done'; ticketId: number; eventCount: number };

export class MemoryState implements StatePort {
  cursors = new Map<string, CursorState>();
  rows = new Map<string, Row & { etag: string }>();
  writes = 0;
  private etagSeq = 0;

  private key(route: string, id: string) {
    return `${route}/${id}`;
  }
  private put(route: string, id: string, row: Row) {
    this.writes++;
    this.rows.set(this.key(route, id), { ...row, etag: `e${++this.etagSeq}` } as Row & { etag: string });
  }
  async getCursor(route: string) {
    return this.cursors.get(route) ?? null;
  }
  async setCursor(route: string, state: CursorState) {
    this.writes++;
    this.cursors.set(route, state);
  }
  async getMapping(route: string, id: string): Promise<Mapping | null> {
    const row = this.rows.get(this.key(route, id));
    return row ? ({ ...row } as Mapping) : null;
  }
  async claim(route: string, id: string, runId: string, now: Date) {
    if (this.rows.has(this.key(route, id))) return false;
    this.put(route, id, { status: 'pending', claimedAt: now.toISOString(), runId });
    return true;
  }
  async takeOver(route: string, id: string, etag: string, runId: string, now: Date) {
    if (this.rows.get(this.key(route, id))?.etag !== etag) return false;
    this.put(route, id, { status: 'pending', claimedAt: now.toISOString(), runId });
    return true;
  }
  async complete(route: string, id: string, ticketId: number, eventCount: number) {
    this.put(route, id, { status: 'done', ticketId, eventCount });
  }
  async updateEventCount(route: string, id: string, eventCount: number) {
    const row = this.rows.get(this.key(route, id));
    if (row?.status === 'done') this.put(route, id, { status: 'done', ticketId: row.ticketId, eventCount });
  }
  async release(route: string, id: string) {
    this.writes++;
    this.rows.delete(this.key(route, id));
  }
}

export class MemoryLogger implements Logger {
  lines: { level: string; message: string; props?: Record<string, unknown> }[] = [];
  info = (message: string, props?: Record<string, unknown>) => void this.lines.push({ level: 'info', message, props });
  warn = (message: string, props?: Record<string, unknown>) => void this.lines.push({ level: 'warn', message, props });
  error = (message: string, props?: Record<string, unknown>) => void this.lines.push({ level: 'error', message, props });
}

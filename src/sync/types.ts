import type { SentryEvent, SentryIssue } from '../sentry/types';

export interface IssueQuery {
  /** Sentry search query, e.g. "issue.category:feedback firstSeen:>=2026-01-01T00:00:00". */
  query: string;
  /** "new" = firstSeen desc, "date" = lastSeen desc. */
  sort: 'new' | 'date';
  /** Lower bound for the event window (ISO). */
  start: string;
}

export interface SentryPort {
  listIssues(q: IssueQuery): Promise<{ issues: SentryIssue[]; truncated: boolean }>;
  getLatestEvent(issueId: string): Promise<SentryEvent | null>;
}

export interface NewTicket {
  subject: string;
  description: string;
  email: string;
  name?: string;
  priority: number;
  status: number;
  type?: string;
  group_id?: number;
  tags: string[];
  custom_fields?: Record<string, string | number | boolean>;
}

export interface FreshdeskPort {
  /** Throws HttpError; `ambiguous` tells whether the ticket might exist anyway. */
  createTicket(ticket: NewTicket): Promise<{ id: number }>;
  findTicketIdByTag(tag: string): Promise<number | null>;
  addNote(ticketId: number, body: string): Promise<void>;
}

export interface CursorState {
  /** ISO timestamp; items at or after this point are fetched next run. */
  cursor: string;
  /** ISO timestamp of the route's first run. Issue routes only ticket issues first seen after it. */
  baseline: string;
  updatedAt: string;
}

export type Mapping =
  | { status: 'pending'; claimedAt: string; runId: string; etag: string }
  | { status: 'done'; ticketId: number; eventCount: number; etag: string };

export interface StatePort {
  getCursor(route: string): Promise<CursorState | null>;
  setCursor(route: string, state: CursorState): Promise<void>;
  getMapping(route: string, sentryId: string): Promise<Mapping | null>;
  /** Atomically creates a pending claim. Returns false if any row already exists. */
  claim(route: string, sentryId: string, runId: string, now: Date): Promise<boolean>;
  /** Replaces a stale pending claim if its etag still matches. Returns false if someone else changed it. */
  takeOver(route: string, sentryId: string, etag: string, runId: string, now: Date): Promise<boolean>;
  complete(route: string, sentryId: string, ticketId: number, eventCount: number): Promise<void>;
  updateEventCount(route: string, sentryId: string, eventCount: number): Promise<void>;
  release(route: string, sentryId: string): Promise<void>;
}

export interface Logger {
  info(message: string, props?: Record<string, unknown>): void;
  warn(message: string, props?: Record<string, unknown>): void;
  error(message: string, props?: Record<string, unknown>): void;
}

import { resolveTicket } from '../config/resolveTicket';
import type { CustomFieldValue, Route, Ticket } from '../config/schema';
import { HttpError } from '../http/retry';
import type { SentryEvent, SentryIssue } from '../sentry/types';
import { escapeHtml, placeholdersIn, render, renderHtml, type TemplateValues } from '../templates/render';
import type { FreshdeskPort, IssueQuery, Logger, NewTicket, SentryPort, StatePort } from './types';

export interface ProcessRouteDeps {
  sentry: SentryPort;
  freshdesk: FreshdeskPort;
  state: StatePort;
  logger: Logger;
  runId: string;
  dryRun: boolean;
  now?: () => Date;
  /** A pending claim older than this is assumed abandoned and gets reconciled. */
  staleClaimMs?: number;
}

export type Outcome = 'created' | 'skipped' | 'noted' | 'failed' | 'deferred';

export interface RouteResult {
  route: string;
  dryRun: boolean;
  fetched: number;
  created: number;
  skipped: number;
  noted: number;
  failed: number;
  deferred: number;
  truncated: boolean;
  cursorFrom: string;
  cursorTo: string;
}

export const DEFAULT_STALE_CLAIM_MS = 15 * 60_000;

/** Sentry search accepts second-precision UTC timestamps without zone suffix. */
export function toSentryDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19);
}

export function buildQuery(route: Route, cursor: string, baseline: string): IssueQuery {
  const since = toSentryDate(cursor);
  if (route.sentry.source === 'feedback') {
    return { query: `issue.category:feedback firstSeen:>=${since}`, sort: 'new', start: cursor };
  }
  const issues = route.issues!;
  // Cursor tracks lastSeen: an issue that crosses minEvents always has a new event, so it
  // re-enters the window. Mapped issues are skipped by the state lookup. The baseline
  // restricts tickets to issues that first appeared after the route started.
  return {
    query: [
      'issue.category:error',
      'is:unresolved',
      `level:[${issues.levels.join(',')}]`,
      `times_seen:>=${issues.minEvents}`,
      `firstSeen:>=${toSentryDate(baseline)}`,
      `lastSeen:>=${since}`,
    ].join(' '),
    sort: 'date',
    start: cursor,
  };
}

function cursorField(route: Route, issue: SentryIssue): string {
  return new Date(route.sentry.source === 'feedback' ? issue.firstSeen : issue.lastSeen).toISOString();
}

function usedPlaceholders(ticket: Ticket): Set<string> {
  const fieldTemplates = Object.values(ticket.customFields)
    .map((v) => (typeof v === 'object' ? v.value : v))
    .filter((v): v is string => typeof v === 'string');
  return new Set([ticket.subjectTemplate, ticket.descriptionTemplate, ...fieldTemplates].flatMap(placeholdersIn));
}

function needsLatestEvent(route: Route, used: Set<string>): boolean {
  if (used.has('environment')) return true;
  return route.sentry.source === 'issues' && (used.has('userEmail') || used.has('userName'));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Builds only the placeholder values the route's templates reference (PII minimization). */
export function templateValues(route: Route, issue: SentryIssue, event: SentryEvent | null, used: Set<string>): TemplateValues {
  const meta = issue.metadata ?? {};
  const feedback = route.sentry.source === 'feedback';
  const all: TemplateValues = {
    sentryId: issue.id,
    shortId: issue.shortId,
    project: issue.project.slug,
    title: issue.title,
    message: feedback ? (str(meta.message) ?? str(meta.value)) : (str(meta.value) ?? issue.title),
    culprit: issue.culprit ?? undefined,
    url: issue.permalink,
    level: issue.level,
    environment: event?.tags?.find((t) => t.key === 'environment')?.value,
    userEmail: feedback ? str(meta.contact_email) : (event?.user?.email ?? undefined),
    userName: feedback ? str(meta.name) : (event?.user?.name ?? event?.user?.username ?? undefined),
    eventCount: issue.count,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
  };
  return Object.fromEntries(Object.entries(all).filter(([k]) => used.has(k)));
}

export function sentryTag(issueId: string): string {
  return `sentry-${issueId}`;
}

export interface FieldWarning {
  field: string;
  reason: string;
}

const BOOLEANS: Record<string, boolean> = { true: true, false: false, '1': true, '0': false, yes: true, no: false };

/**
 * Renders a custom field value and converts it to the declared type.
 * Returns undefined to omit the field: empty values are omitted silently, unconvertible ones with a reason.
 */
export function convertCustomField(
  raw: CustomFieldValue,
  values: TemplateValues,
): { value?: string | number | boolean; reason?: string } {
  const { value, type } = typeof raw === 'object' ? raw : { value: raw, type: undefined };
  if (!type && typeof value !== 'string') return { value };

  const text = (typeof value === 'string' ? render(value, values) : String(value)).trim();
  if (text === '') return {};

  switch (type) {
    case undefined:
    case 'text':
      return { value: text };
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n) ? { value: n } : { reason: 'not a number' };
    }
    case 'boolean': {
      const b = BOOLEANS[text.toLowerCase()];
      return b === undefined ? { reason: 'not a boolean (true/false/1/0/yes/no)' } : { value: b };
    }
    case 'date': {
      const ms = Date.parse(text);
      return Number.isNaN(ms) ? { reason: 'not a date' } : { value: new Date(ms).toISOString().slice(0, 10) };
    }
  }
}

export function buildTicket(route: Route, issue: SentryIssue, values: TemplateValues): { ticket: NewTicket; warnings: FieldWarning[] } {
  const t = resolveTicket(route, issue.project.slug);
  const meta = issue.metadata ?? {};
  const reporterEmail = str(meta.contact_email);
  const useReporter = route.sentry.source === 'feedback' && t.requester.fromFeedback && reporterEmail?.includes('@');

  const warnings: FieldWarning[] = [];
  const customFields: Record<string, string | number | boolean> = {};
  for (const [field, raw] of Object.entries(t.customFields)) {
    const { value, reason } = convertCustomField(raw, values);
    if (value !== undefined) customFields[field] = value;
    else if (reason) warnings.push({ field, reason });
  }
  if (route.freshdesk.sentryIdField) customFields[route.freshdesk.sentryIdField] = issue.id;

  const ticket: NewTicket = {
    subject: render(t.subjectTemplate, values).replace(/\s+/g, ' ').trim().slice(0, 255) || `Sentry ${issue.shortId}`,
    description: renderHtml(t.descriptionTemplate, values),
    email: useReporter ? reporterEmail! : t.requester.fallbackEmail,
    priority: t.priority,
    status: t.status,
    tags: [...new Set([...t.tags, sentryTag(issue.id)])],
  };
  const name = useReporter ? str(meta.name) : t.requester.fallbackName;
  if (name) ticket.name = name;
  if (t.type) ticket.type = t.type;
  if (t.groupId) ticket.group_id = t.groupId;
  if (Object.keys(customFields).length > 0) ticket.custom_fields = customFields;
  return { ticket, warnings };
}

function errorProps(err: unknown): Record<string, unknown> {
  if (err instanceof HttpError) return { error: err.message, status: err.status, ambiguous: err.ambiguous, body: err.body };
  return { error: err instanceof Error ? err.message : String(err) };
}

export async function processRoute(route: Route, deps: ProcessRouteDeps): Promise<RouteResult> {
  const { sentry, freshdesk, state, logger, dryRun, runId } = deps;
  const now = deps.now ?? (() => new Date());
  const staleClaimMs = deps.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const log = (props: Record<string, unknown> = {}) => ({ route: route.name, runId, dryRun, ...props });

  const stored = await state.getCursor(route.name);
  const cursorFrom = stored?.cursor ?? new Date(now().getTime() - route.sentry.initialLookbackMinutes * 60_000).toISOString();
  const baseline = stored?.baseline ?? cursorFrom;

  const { issues, truncated } = await sentry.listIssues(buildQuery(route, cursorFrom, baseline));
  issues.sort((a, b) => cursorField(route, a).localeCompare(cursorField(route, b)));

  const plans = new Map<string, { used: Set<string>; wantEvent: boolean }>();
  const planFor = (project: string) => {
    let plan = plans.get(project);
    if (!plan) {
      const used = usedPlaceholders(resolveTicket(route, project));
      plan = { used, wantEvent: needsLatestEvent(route, used) };
      plans.set(project, plan);
    }
    return plan;
  };
  const counts: Record<Outcome, number> = { created: 0, skipped: 0, noted: 0, failed: 0, deferred: 0 };
  const held: string[] = [];

  const prepare = async (issue: SentryIssue): Promise<NewTicket> => {
    const { used, wantEvent } = planFor(issue.project.slug);
    const event = wantEvent ? await sentry.getLatestEvent(issue.id) : null;
    const { ticket, warnings } = buildTicket(route, issue, templateValues(route, issue, event, used));
    for (const w of warnings) logger.warn('Custom field omitted', log({ sentryId: issue.id, ...w }));
    return ticket;
  };

  /** Caller must hold the claim. */
  const submit = async (issue: SentryIssue, ticket: NewTicket): Promise<Outcome> => {
    let ticketId: number;
    try {
      ticketId = (await freshdesk.createTicket(ticket)).id;
    } catch (err) {
      const ambiguous = !(err instanceof HttpError) || err.ambiguous;
      if (!ambiguous) await state.release(route.name, issue.id);
      logger.warn('Ticket creation failed', log({ sentryId: issue.id, claimKept: ambiguous, ...errorProps(err) }));
      return 'failed';
    }
    await state.complete(route.name, issue.id, ticketId, Number(issue.count));
    logger.info('Ticket created', log({ sentryId: issue.id, ticketId }));
    return 'created';
  };

  const processItem = async (issue: SentryIssue): Promise<Outcome> => {
    const mapping = await state.getMapping(route.name, issue.id);
    const count = Number(issue.count);

    if (mapping?.status === 'done') {
      if (route.issues?.noteOnRepeat && count > mapping.eventCount) {
        if (dryRun) {
          logger.info('DRY_RUN: would add repeat note', log({ sentryId: issue.id, ticketId: mapping.ticketId }));
          return 'noted';
        }
        const body =
          `Sentry issue ${escapeHtml(issue.shortId)} now has ${count} events (was ${mapping.eventCount}). ` +
          `Last seen ${escapeHtml(issue.lastSeen)}.<br><a href="${escapeHtml(issue.permalink)}">Open in Sentry</a>`;
        await freshdesk.addNote(mapping.ticketId, body);
        await state.updateEventCount(route.name, issue.id, count);
        return 'noted';
      }
      return 'skipped';
    }

    if (counts.created >= route.freshdesk.maxTicketsPerRun) return 'deferred';

    if (mapping?.status === 'pending') {
      const age = now().getTime() - Date.parse(mapping.claimedAt);
      if (age < staleClaimMs) return 'deferred';
      if (dryRun) {
        logger.info('DRY_RUN: would reconcile stale claim', log({ sentryId: issue.id }));
        return 'deferred';
      }
      // A previous run crashed or got an ambiguous error after claiming. Check Freshdesk first.
      const existing = await freshdesk.findTicketIdByTag(sentryTag(issue.id));
      if (existing !== null) {
        await state.complete(route.name, issue.id, existing, count);
        logger.info('Recovered ticket from stale claim', log({ sentryId: issue.id, ticketId: existing }));
        return 'skipped';
      }
      const ticket = await prepare(issue);
      if (!(await state.takeOver(route.name, issue.id, mapping.etag, runId, now()))) return 'deferred';
      return submit(issue, ticket);
    }

    const ticket = await prepare(issue);
    if (dryRun) {
      logger.info('DRY_RUN: would create ticket', log({ sentryId: issue.id, ticket }));
      return 'created';
    }
    if (!(await state.claim(route.name, issue.id, runId, now()))) return 'deferred';
    return submit(issue, ticket);
  };

  for (const issue of issues) {
    let outcome: Outcome;
    try {
      outcome = await processItem(issue);
    } catch (err) {
      logger.warn('Item processing failed', log({ sentryId: issue.id, ...errorProps(err) }));
      outcome = 'failed';
    }
    counts[outcome]++;
    if (outcome === 'failed' || outcome === 'deferred') held.push(cursorField(route, issue));
  }

  let cursorTo = cursorFrom;
  if (truncated) {
    logger.warn('Sentry results truncated at maxPages; cursor not advanced. Raise maxPages or narrow filters.', log());
  } else if (held.length > 0) {
    cursorTo = held.reduce((a, b) => (a < b ? a : b));
  } else if (issues.length > 0) {
    cursorTo = cursorField(route, issues[issues.length - 1]!);
  }
  if (cursorTo < cursorFrom) cursorTo = cursorFrom;

  if (!dryRun && (cursorTo !== cursorFrom || !stored)) {
    await state.setCursor(route.name, { cursor: cursorTo, baseline, updatedAt: now().toISOString() });
  }

  const result: RouteResult = { route: route.name, dryRun, fetched: issues.length, ...counts, truncated, cursorFrom, cursorTo };
  logger.info('Route sync finished', { ...result, runId });
  return result;
}

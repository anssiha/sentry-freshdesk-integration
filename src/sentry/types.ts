/** Subset of the Sentry issue payload (GET /api/0/organizations/{org}/issues/) that we use. */
export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit?: string | null;
  permalink: string;
  level: string;
  /** Sentry returns event count as a string. */
  count: string;
  firstSeen: string;
  lastSeen: string;
  project: { id: string; slug: string };
  issueCategory?: string;
  /**
   * For feedback issues Sentry stores the report here:
   * message, contact_email, name. For errors, value holds the exception message.
   */
  metadata?: Record<string, unknown>;
}

/** Subset of GET /api/0/organizations/{org}/issues/{id}/events/latest/. */
export interface SentryEvent {
  tags?: { key: string; value: string }[];
  user?: { email?: string | null; name?: string | null; username?: string | null } | null;
}

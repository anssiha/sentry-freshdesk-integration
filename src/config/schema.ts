import { z } from 'zod';
import { PLACEHOLDERS, unknownPlaceholders } from '../templates/render';

const template = z.string().min(1).superRefine((value, ctx) => {
  const unknown = unknownPlaceholders(value);
  if (unknown.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `Unknown placeholder(s): ${unknown.map((p) => `{${p}}`).join(', ')}. Allowed: ${PLACEHOLDERS.join(', ')}`,
    });
  }
});

const routeName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Route name must be lowercase letters, digits and dashes (max 63 chars)');

const secretName = z
  .string()
  .regex(/^[0-9a-zA-Z-]{1,127}$/, 'Key Vault secret names may only contain letters, digits and dashes');

const level = z.enum(['debug', 'info', 'warning', 'error', 'fatal']);

export const SentrySchema = z.object({
  baseUrl: z.url({ protocol: /^https$/ }).default('https://sentry.io'),
  org: z.string().min(1),
  projects: z.array(z.string().min(1)).min(1),
  source: z.enum(['feedback', 'issues']),
  tokenSecret: secretName,
  filters: z
    .object({
      environment: z.array(z.string().min(1)).optional(),
    })
    .default({}),
  /** How far back the very first run looks when no cursor exists yet. */
  initialLookbackMinutes: z.number().int().positive().default(60),
  /** Safety cap on Sentry pages (100 items each) per run. */
  maxPages: z.number().int().positive().max(100).default(10),
});

const plainFieldValue = z.union([template, z.number(), z.boolean()]);

/**
 * A custom field value: a literal, a template string, or { value, type } where type converts
 * the rendered value for number, checkbox and date fields.
 */
export const CustomFieldValueSchema = z.union([
  plainFieldValue,
  z.strictObject({
    value: plainFieldValue,
    type: z.enum(['text', 'number', 'boolean', 'date']),
  }),
]);

const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const status = z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);

const ticketFields = {
  type: z.string().min(1),
  priority,
  status,
  groupId: z.number().int().positive(),
  tags: z.array(z.string().min(1).max(32)),
  customFields: z.record(z.string(), CustomFieldValueSchema),
  subjectTemplate: template,
  descriptionTemplate: template,
};

const requesterFields = {
  /** For feedback routes: use the reporter's email/name when present. */
  fromFeedback: z.boolean(),
  fallbackEmail: z.email(),
  fallbackName: z.string().min(1),
};

export const TicketSchema = z.object({
  ...ticketFields,
  type: ticketFields.type.optional(),
  priority: priority.default(2),
  status: status.default(2),
  groupId: ticketFields.groupId.optional(),
  tags: ticketFields.tags.default([]),
  customFields: ticketFields.customFields.default({}),
  requester: z.object({
    ...requesterFields,
    fromFeedback: requesterFields.fromFeedback.default(true),
    fallbackName: requesterFields.fallbackName.optional(),
  }),
});

/** Per-project override: every field optional and without defaults, so omitted fields inherit. Strict to catch typos. */
export const TicketOverrideSchema = z
  .strictObject({
    ...ticketFields,
    requester: z.strictObject(requesterFields).partial(),
  })
  .partial();

export const FreshdeskSchema = z.object({
  domain: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i, 'Expected a hostname like mycompany.freshdesk.com'),
  apiKeySecret: secretName,
  /** Optional custom field (e.g. cf_sentry_id) that receives the Sentry issue ID. The tag sentry-<id> is always set. */
  sentryIdField: z.string().regex(/^cf_[a-z0-9_]+$/).optional(),
  maxTicketsPerRun: z.number().int().positive().default(50),
  ticket: TicketSchema,
  /** Keyed by Sentry project slug; merged over `ticket` for issues from that project. */
  projectOverrides: z.record(z.string(), TicketOverrideSchema).default({}),
});

export const IssuesSchema = z.object({
  minEvents: z.number().int().min(1).default(1),
  levels: z.array(level).min(1).default(['error', 'fatal']),
  /** Add a private note to the mapped ticket when an issue gets new events. */
  noteOnRepeat: z.boolean().default(false),
});

export const RouteSchema = z
  .object({
    name: routeName,
    enabled: z.boolean().default(true),
    sentry: SentrySchema,
    freshdesk: FreshdeskSchema,
    issues: IssuesSchema.optional(),
  })
  .superRefine((route, ctx) => {
    if (route.sentry.source === 'feedback' && route.issues) {
      ctx.addIssue({
        code: 'custom',
        path: ['issues'],
        message: 'The "issues" block is only valid when sentry.source is "issues"',
      });
    }
    for (const slug of Object.keys(route.freshdesk.projectOverrides)) {
      if (!route.sentry.projects.includes(slug)) {
        ctx.addIssue({
          code: 'custom',
          path: ['freshdesk', 'projectOverrides', slug],
          message: `Override for project "${slug}", which is not listed in sentry.projects`,
        });
      }
    }
  })
  .transform((route) =>
    route.sentry.source === 'issues' && !route.issues ? { ...route, issues: IssuesSchema.parse({}) } : route,
  );

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    routes: z.array(RouteSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.routes.forEach((route, i) => {
      if (seen.has(route.name)) {
        ctx.addIssue({ code: 'custom', path: ['routes', i, 'name'], message: `Duplicate route name "${route.name}"` });
      }
      seen.add(route.name);
    });
  });

export type Config = z.output<typeof ConfigSchema>;
export type Route = z.output<typeof RouteSchema>;
export type Ticket = z.output<typeof TicketSchema>;
export type CustomFieldValue = z.output<typeof CustomFieldValueSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

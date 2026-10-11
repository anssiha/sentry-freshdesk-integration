import type { Route, Ticket } from './schema';

/**
 * Ticket settings for one Sentry project: the project's override merged over the route's ticket.
 * Scalars replace, customFields merge by key, tags are combined, requester merges shallowly.
 */
export function resolveTicket(route: Route, project: string): Ticket {
  const base = route.freshdesk.ticket;
  const override = route.freshdesk.projectOverrides[project];
  if (!override) return base;

  const { tags, customFields, requester, ...scalars } = override;
  return {
    ...base,
    ...scalars,
    tags: tags ? [...new Set([...base.tags, ...tags])] : base.tags,
    customFields: { ...base.customFields, ...customFields },
    requester: { ...base.requester, ...requester },
  };
}

import { describe, expect, it } from 'vitest';
import { resolveTicket } from '../src/config/resolveTicket';
import { buildTicket, convertCustomField } from '../src/sync/processRoute';
import { feedbackRouteInput, issue, route } from './fakes';

function routeWithOverrides(projectOverrides: Record<string, unknown>, customFields: Record<string, unknown> = { cf_source: 'sentry', cf_team: 'core' }) {
  const input = feedbackRouteInput();
  return route({
    ...input,
    sentry: { ...input.sentry, projects: ['web', 'api'] },
    freshdesk: {
      ...input.freshdesk,
      ticket: { ...input.freshdesk.ticket, priority: 2, groupId: 1, customFields: customFields as never },
      projectOverrides: projectOverrides as never,
    },
  });
}

describe('resolveTicket', () => {
  const r = routeWithOverrides({
    api: {
      priority: 4,
      tags: ['api', 'sentry'],
      customFields: { cf_team: 'platform', cf_product: 'API' },
      requester: { fallbackEmail: 'api@acme.test' },
      subjectTemplate: 'API: {title}',
    },
  });

  it('returns the base ticket for projects without overrides', () => {
    expect(resolveTicket(r, 'web')).toBe(r.freshdesk.ticket);
  });

  it('replaces scalars, merges customFields and requester, and combines tags', () => {
    const t = resolveTicket(r, 'api');
    expect(t).toMatchObject({
      priority: 4,
      groupId: 1,
      status: 2,
      subjectTemplate: 'API: {title}',
      descriptionTemplate: r.freshdesk.ticket.descriptionTemplate,
      tags: ['sentry', 'api'],
      customFields: { cf_source: 'sentry', cf_team: 'platform', cf_product: 'API' },
      requester: { fromFeedback: true, fallbackEmail: 'api@acme.test', fallbackName: 'Sentry' },
    });
  });

  it('applies the override in the built ticket for that project only', () => {
    const values = { project: 'x', title: 'Boom', message: 'm', url: 'u' };
    const web = buildTicket(r, issue('1'), values).ticket;
    const api = buildTicket(r, issue('2', { project: { id: '2', slug: 'api' } }), values).ticket;
    expect(web).toMatchObject({ priority: 2, group_id: 1, custom_fields: { cf_source: 'sentry', cf_team: 'core' } });
    expect(api).toMatchObject({ priority: 4, group_id: 1, subject: 'API: Boom', tags: ['sentry', 'api', 'sentry-2'] });
    expect(api.custom_fields).toEqual({ cf_source: 'sentry', cf_team: 'platform', cf_product: 'API' });
  });
});

describe('convertCustomField', () => {
  const values = { eventCount: '42', firstSeen: '2026-09-18T06:38:14Z', level: 'error', userName: '' };

  it('passes literals through and renders plain templates as text', () => {
    expect(convertCustomField(7, values)).toEqual({ value: 7 });
    expect(convertCustomField(true, values)).toEqual({ value: true });
    expect(convertCustomField('{level}', values)).toEqual({ value: 'error' });
  });

  it('converts typed values', () => {
    expect(convertCustomField({ value: '{eventCount}', type: 'number' }, values)).toEqual({ value: 42 });
    expect(convertCustomField({ value: '{firstSeen}', type: 'date' }, values)).toEqual({ value: '2026-09-18' });
    expect(convertCustomField({ value: 'Yes', type: 'boolean' }, values)).toEqual({ value: true });
    expect(convertCustomField({ value: '0', type: 'boolean' }, values)).toEqual({ value: false });
    expect(convertCustomField({ value: 5, type: 'text' }, values)).toEqual({ value: '5' });
  });

  it('omits empty values silently and unconvertible values with a reason', () => {
    expect(convertCustomField('{userName}', values)).toEqual({});
    expect(convertCustomField({ value: '{userEmail}', type: 'number' }, values)).toEqual({});
    expect(convertCustomField({ value: '{level}', type: 'number' }, values)).toEqual({ reason: 'not a number' });
    expect(convertCustomField({ value: '{level}', type: 'date' }, values)).toEqual({ reason: 'not a date' });
    expect(convertCustomField({ value: 'maybe', type: 'boolean' }, values).reason).toMatch(/not a boolean/);
  });

  it('reports omitted fields from buildTicket as warnings without the value', () => {
    const r = routeWithOverrides({}, { cf_events: { value: '{level}', type: 'number' }, cf_ok: { value: '{eventCount}', type: 'number' } });
    const { ticket, warnings } = buildTicket(r, issue('1'), { level: 'error', eventCount: '10' });
    expect(ticket.custom_fields).toEqual({ cf_ok: 10 });
    expect(warnings).toEqual([{ field: 'cf_events', reason: 'not a number' }]);
  });
});

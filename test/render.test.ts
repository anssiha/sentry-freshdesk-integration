import { describe, expect, it } from 'vitest';
import { buildTicket, templateValues } from '../src/sync/processRoute';
import { render, renderHtml, unknownPlaceholders } from '../src/templates/render';
import { feedbackRouteInput, issue, route } from './fakes';

describe('templates', () => {
  it('substitutes placeholders and blanks missing values', () => {
    expect(render('[{project}] {title} {userEmail}', { project: 'web', title: 'Boom' })).toBe('[web] Boom ');
  });

  it('finds unknown placeholders and ignores stray braces', () => {
    expect(unknownPlaceholders('{project} {foo} { not a placeholder } {bar_2}')).toEqual(['foo', 'bar_2']);
  });

  it('escapes HTML in values and template text, converting newlines', () => {
    expect(renderHtml('<b>{message}</b>\n{url}', { message: '<script>x</script> & "y"', url: 'https://s/1?a=1&b=2' })).toBe(
      '&lt;b&gt;&lt;script&gt;x&lt;/script&gt; &amp; &quot;y&quot;&lt;/b&gt;<br>https://s/1?a=1&amp;b=2',
    );
  });

  it('does not re-substitute placeholders that appear inside values', () => {
    expect(render('{title}', { title: '{url}', url: 'leak' })).toBe('{url}');
  });
});

describe('ticket building', () => {
  it('only exposes values the templates use (PII minimization)', () => {
    const r = route();
    const used = new Set(['project', 'title', 'message', 'url']);
    const values = templateValues(r, issue('1'), null, used);
    expect(Object.keys(values).sort()).toEqual(['message', 'project', 'title', 'url']);
    expect(JSON.stringify(values)).not.toContain('example.com');
  });

  it('builds the Freshdesk payload with tag, custom fields and sentry ID field', () => {
    const input = feedbackRouteInput();
    const r = route({
      ...input,
      freshdesk: {
        ...input.freshdesk,
        sentryIdField: 'cf_sentry_id',
        ticket: { ...input.freshdesk.ticket, type: 'Incident', groupId: 7, customFields: { cf_level: '{level}', cf_flag: true } },
      },
    });
    const { ticket: t, warnings } = buildTicket(r, issue('42'), { project: 'web', title: 'Issue 42', message: 'Hello', url: 'https://s/42', level: 'error' });
    expect(t).toEqual({
      subject: '[web] Issue 42',
      description: 'Hello<br><br>Sentry: https://s/42',
      email: 'user42@example.com',
      name: 'User 42',
      priority: 2,
      status: 2,
      type: 'Incident',
      group_id: 7,
      tags: ['sentry', 'sentry-42'],
      custom_fields: { cf_level: 'error', cf_flag: true, cf_sentry_id: '42' },
    });
    expect(warnings).toEqual([]);
  });

  it('uses the fallback requester when fromFeedback is off', () => {
    const input = feedbackRouteInput();
    const r = route({
      ...input,
      freshdesk: { ...input.freshdesk, ticket: { ...input.freshdesk.ticket, requester: { fromFeedback: false, fallbackEmail: 'fb@acme.test' } } },
    });
    const { ticket: t } = buildTicket(r, issue('1'), {});
    expect(t.email).toBe('fb@acme.test');
    expect(t.name).toBeUndefined();
  });

  it('truncates and flattens long subjects', () => {
    const { ticket: t } = buildTicket(route(), issue('1'), { project: 'web', title: `line1\nline2 ${'x'.repeat(400)}` });
    expect(t.subject.length).toBe(255);
    expect(t.subject).not.toContain('\n');
  });
});

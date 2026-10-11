import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateJsonSchema } from '../src/config/jsonSchema';
import { ConfigError, loadConfig, parseConfig, parseConfigText } from '../src/config/load';
import { feedbackRouteInput } from './fakes';

const configDir = path.resolve(__dirname, '../config');

describe('config validation', () => {
  it('accepts the shipped example file', () => {
    expect(loadConfig(path.join(configDir, 'routes.example.json')).routes).toHaveLength(2);
  });

  it('parses config text and reports invalid JSON without echoing it', () => {
    const text = readFileSync(path.join(configDir, 'routes.example.json'), 'utf8');
    expect(parseConfigText(text, 'secret "x"').routes).toHaveLength(2);
    expect(() => parseConfigText('{ nope', 'secret "x"')).toThrow(/secret "x" is not valid JSON/);
    expect(() => parseConfigText('{"routes":[]}', 'secret "x"')).toThrow(ConfigError);
  });

  it('applies defaults', () => {
    const r = parseConfig({ routes: [feedbackRouteInput()] }).routes[0]!;
    expect(r.enabled).toBe(true);
    expect(r.sentry.baseUrl).toBe('https://sentry.io');
    expect(r.freshdesk.ticket).toMatchObject({ priority: 2, status: 2, customFields: {} });
    expect(r.freshdesk.ticket.requester.fromFeedback).toBe(true);
  });

  it('fills issue defaults for issues routes', () => {
    const input = feedbackRouteInput();
    const r = parseConfig({ routes: [{ ...input, sentry: { ...input.sentry, source: 'issues' } }] }).routes[0]!;
    expect(r.issues).toEqual({ minEvents: 1, levels: ['error', 'fatal'], noteOnRepeat: false });
  });

  it('rejects unknown template placeholders with a helpful message', () => {
    const input = feedbackRouteInput();
    const bad = { ...input, freshdesk: { ...input.freshdesk, ticket: { ...input.freshdesk.ticket, subjectTemplate: '{project} {titel}' } } };
    expect(() => parseConfig({ routes: [bad] })).toThrow(/Unknown placeholder\(s\): \{titel\}/);
  });

  it('rejects unknown placeholders in custom field values', () => {
    const input = feedbackRouteInput();
    const bad = { ...input, freshdesk: { ...input.freshdesk, ticket: { ...input.freshdesk.ticket, customFields: { cf_x: '{nope}' } } } };
    expect(() => parseConfig({ routes: [bad] })).toThrow(/\{nope\}/);
  });

  it('rejects duplicate route names', () => {
    expect(() => parseConfig({ routes: [feedbackRouteInput(), feedbackRouteInput()] })).toThrow(/Duplicate route name "team-a-feedback"/);
  });

  it('rejects an issues block on feedback routes', () => {
    expect(() => parseConfig({ routes: [feedbackRouteInput({ issues: { minEvents: 3 } })] })).toThrow(/only valid when sentry.source is "issues"/);
  });

  it('rejects invalid names, secrets, emails and missing fields', () => {
    const input = feedbackRouteInput();
    const cases = [
      { ...input, name: 'Team A' },
      { ...input, sentry: { ...input.sentry, tokenSecret: 'has_underscore' } },
      { ...input, sentry: { ...input.sentry, baseUrl: 'http://sentry.io' } },
      { ...input, freshdesk: { ...input.freshdesk, ticket: { ...input.freshdesk.ticket, requester: { fallbackEmail: 'nope' } } } },
      { ...input, sentry: { ...input.sentry, projects: [] } },
    ];
    for (const c of cases) expect(() => parseConfig({ routes: [c] })).toThrow(ConfigError);
  });

  describe('projectOverrides', () => {
    const withOverrides = (projectOverrides: unknown, customFields: unknown = {}) => {
      const input = feedbackRouteInput();
      return {
        ...input,
        freshdesk: { ...input.freshdesk, ticket: { ...input.freshdesk.ticket, customFields: customFields as never }, projectOverrides: projectOverrides as never },
      };
    };

    it('accepts overrides and applies no defaults inside them', () => {
      const r = parseConfig({ routes: [withOverrides({ web: { groupId: 9 } })] }).routes[0]!;
      expect(r.freshdesk.projectOverrides).toEqual({ web: { groupId: 9 } });
    });

    it('rejects overrides for projects not in sentry.projects', () => {
      expect(() => parseConfig({ routes: [withOverrides({ wbe: { groupId: 9 } })] })).toThrow(/project "wbe", which is not listed in sentry.projects/);
    });

    it('rejects unknown placeholders and unknown keys in overrides', () => {
      expect(() => parseConfig({ routes: [withOverrides({ web: { subjectTemplate: '{nope}' } })] })).toThrow(/\{nope\}/);
      expect(() => parseConfig({ routes: [withOverrides({ web: { customFields: { cf_x: { value: '{nope}', type: 'text' } } } })] })).toThrow(/\{nope\}/);
      expect(() => parseConfig({ routes: [withOverrides({ web: { groupID: 9 } })] })).toThrow(ConfigError);
    });

    it('validates typed custom field values', () => {
      expect(() => parseConfig({ routes: [withOverrides({}, { cf_n: { value: '{eventCount}', type: 'number' } })] })).not.toThrow();
      expect(() => parseConfig({ routes: [withOverrides({}, { cf_n: { value: '{eventCount}', type: 'integer' } })] })).toThrow(ConfigError);
      expect(() => parseConfig({ routes: [withOverrides({}, { cf_n: { value: '1', type: 'number', extra: 1 } })] })).toThrow(ConfigError);
    });
  });

  it('keeps routes.schema.json in sync with the zod schema (run npm run schema)', () => {
    const onDisk = JSON.parse(readFileSync(path.join(configDir, 'routes.schema.json'), 'utf8'));
    expect(onDisk).toEqual(generateJsonSchema());
  });
});

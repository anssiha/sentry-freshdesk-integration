import { z } from 'zod';
import { PLACEHOLDERS } from '../templates/render';
import { ConfigSchema } from './schema';

/** JSON Schema for editor autocompletion. The zod schema stays authoritative (placeholder checks, uniqueness). */
export function generateJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return {
    ...schema,
    title: 'Sentry to Freshdesk routes',
    description: `Template placeholders: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`,
  };
}

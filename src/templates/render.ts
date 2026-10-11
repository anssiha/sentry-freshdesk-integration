export const PLACEHOLDERS = [
  'sentryId',
  'shortId',
  'project',
  'title',
  'message',
  'culprit',
  'url',
  'level',
  'environment',
  'userEmail',
  'userName',
  'eventCount',
  'firstSeen',
  'lastSeen',
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];
export type TemplateValues = Partial<Record<Placeholder, string>>;

const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;
const KNOWN = new Set<string>(PLACEHOLDERS);

export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_PATTERN)].map((m) => m[1]!);
}

export function unknownPlaceholders(template: string): string[] {
  return placeholdersIn(template).filter((p) => !KNOWN.has(p));
}

export function render(template: string, values: TemplateValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (_, name: string) => values[name as Placeholder] ?? '');
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Renders a template into Freshdesk-safe HTML: values are escaped, newlines become <br>. */
export function renderHtml(template: string, values: TemplateValues): string {
  const escaped: TemplateValues = {};
  for (const [key, value] of Object.entries(values)) {
    escaped[key as Placeholder] = escapeHtml(value ?? '');
  }
  return escapeHtml(template)
    .replace(PLACEHOLDER_PATTERN, (_, name: string) => escaped[name as Placeholder] ?? '')
    .replace(/\r?\n/g, '<br>');
}

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigSchema, type Config } from './schema';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../../../config/routes.json');

export function parseConfig(raw: unknown, source = 'config'): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid ${source}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Parses config text (e.g. a Key Vault secret). The text is never echoed in errors. */
export function parseConfigText(text: string, source: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw, source);
}

export function loadConfig(filePath = process.env.ROUTES_CONFIG_PATH || DEFAULT_CONFIG_PATH): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read ${filePath}: ${(err as Error).message}`);
  }
  return parseConfig(raw, filePath);
}

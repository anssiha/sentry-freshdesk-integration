import type { TokenCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

export interface SecretProvider {
  get(name: string): Promise<string>;
}

interface CacheEntry {
  value: Promise<string>;
  expiresAt: number;
}

/** Reads secrets from Key Vault with managed identity and caches them per warm instance. */
export class KeyVaultSecrets implements SecretProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly client: SecretClient;

  constructor(
    vaultUrl: string,
    credential: TokenCredential,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.client = new SecretClient(vaultUrl, credential);
  }

  get(name: string): Promise<string> {
    const hit = this.cache.get(name);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const value = this.client.getSecret(name).then((s) => {
      if (!s.value) throw new Error(`Key Vault secret "${name}" has no value`);
      return s.value;
    });
    this.cache.set(name, { value, expiresAt: this.now() + this.ttlMs });
    value.catch(() => this.cache.delete(name));
    return value;
  }
}

/** Local development: secret "team-a-sentry-token" is read from env var SECRET_TEAM_A_SENTRY_TOKEN. */
export class EnvSecrets implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  static varName(name: string): string {
    return `SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  async get(name: string): Promise<string> {
    const value = this.env[EnvSecrets.varName(name)];
    if (!value) throw new Error(`Secret "${name}" not found in env var ${EnvSecrets.varName(name)}`);
    return value;
  }
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Retry-After values above this are not waited for; the request fails instead. */
  maxRetryAfterMs: number;
  timeoutMs: number;
  /**
   * Retry on 5xx and network errors. Must be false for non-idempotent requests
   * (ticket creation): the server may have processed the request before failing.
   */
  retryOnServerError: boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
  timeoutMs: 30_000,
  retryOnServerError: true,
};

export interface HttpDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number | undefined,
    /** True when the request may have been processed by the server (network error, timeout, 5xx). */
    readonly ambiguous: boolean,
    readonly body?: string,
  ) {
    super(message);
  }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function backoff(attempt: number, opts: RetryOptions, random: () => number): number {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + (random() * exp) / 2);
}

/** Strips query strings so tokens or PII in URLs never reach logs. */
function describe(url: string, method: string): string {
  return `${method} ${url.split('?')[0]}`;
}

/**
 * fetch with retries. Always retries 429 (the server rejected the request, so a retry is safe),
 * honoring Retry-After. Retries 5xx and network errors only when retryOnServerError is set.
 * Returns the final Response; callers decide what a non-2xx status means.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: Partial<RetryOptions> = {},
  deps: HttpDeps = defaultHttpDeps,
): Promise<Response> {
  const opts = { ...DEFAULT_RETRY, ...options };
  const label = describe(url, init.method ?? 'GET');

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < opts.maxRetries;
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs) });
    } catch (err) {
      if (opts.retryOnServerError && canRetry) {
        await deps.sleep(backoff(attempt, opts, deps.random));
        continue;
      }
      throw new HttpError(`${label} failed: ${(err as Error).message}`, undefined, true);
    }

    if (res.status === 429 && canRetry) {
      const wait = parseRetryAfter(res.headers.get('retry-after')) ?? backoff(attempt, opts, deps.random);
      if (wait > opts.maxRetryAfterMs) return res;
      await res.body?.cancel();
      await deps.sleep(wait);
      continue;
    }

    if (res.status >= 500 && opts.retryOnServerError && canRetry) {
      await res.body?.cancel();
      await deps.sleep(backoff(attempt, opts, deps.random));
      continue;
    }

    return res;
  }
}

/** Throws HttpError for non-2xx responses; otherwise returns the parsed JSON body. */
export async function readJson<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 500);
    throw new HttpError(`${label} returned ${res.status}`, res.status, res.status >= 500, body);
  }
  return (await res.json()) as T;
}

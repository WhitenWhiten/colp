export const WEB_SHELL_CACHE_TTL_MS = 60_000;
export const WEB_SHELL_MAX_STALE_MS = 300_000;
export const WEB_SHELL_FETCH_TIMEOUT_MS = 3_000;
const SHELL_PATH = '/index.html';

export interface WebShellLoadResult {
  readonly kind: 'ok' | 'unavailable';
  readonly body?: string;
}

export interface WebShellCache {
  load(signal?: AbortSignal): Promise<WebShellLoadResult>;
}

interface CachedShell {
  readonly body: string;
  readonly etag: string | null;
  fetchedAt: number;
}

export type WebShellFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<Response>;

/**
 * Dedicated internal fetch: only the configured WEB_SHELL_ORIGIN + /index.html.
 * Do not use createHardenedEgressFetch (it blocks private/compose URLs).
 */
export function createInternalOriginFetch(origin: string, fetchImpl: typeof fetch = fetch): WebShellFetch {
  const allowed = new URL(origin);
  return async (url, init) => {
    const parsed = new URL(url);
    if (
      parsed.protocol !== allowed.protocol
      || parsed.hostname !== allowed.hostname
      || parsed.port !== allowed.port
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.search !== ''
      || parsed.hash !== ''
      || parsed.pathname !== SHELL_PATH
    ) {
      throw new Error('internal shell fetch refused: URL is outside WEB_SHELL_ORIGIN/index.html');
    }
    return fetchImpl(url, init);
  };
}

export function createWebShellCache(options: {
  readonly origin: string;
  readonly ttlMs?: number;
  readonly maxStaleMs?: number;
  readonly fetch?: WebShellFetch;
  readonly now?: () => number;
}): WebShellCache {
  let cache: CachedShell | null = null;
  const ttlMs = options.ttlMs ?? WEB_SHELL_CACHE_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? WEB_SHELL_MAX_STALE_MS;
  const fetchImpl = options.fetch ?? createInternalOriginFetch(options.origin);
  let pending: Promise<WebShellLoadResult> | undefined;
  const staleOrUnavailable = (): WebShellLoadResult => {
    const now = options.now?.() ?? Date.now();
    return cache !== null && now - cache.fetchedAt < ttlMs + maxStaleMs
      ? { kind: 'ok', body: cache.body }
      : { kind: 'unavailable' };
  };
  const fetchShell = async (): Promise<WebShellLoadResult> => {
    const now = options.now?.() ?? Date.now();
    const headers: Record<string, string> = { Accept: 'text/html' };
    if (cache?.etag) headers['If-None-Match'] = cache.etag;
    // One shared origin fetch. A caller's abort must not cancel the others.
    const timeout = AbortSignal.timeout(WEB_SHELL_FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${options.origin}${SHELL_PATH}`, { headers, signal: timeout });
      if (response.status === 304 && cache !== null) {
        cache.fetchedAt = now;
        return { kind: 'ok', body: cache.body };
      }
      if (!response.ok) return staleOrUnavailable();
      const body = await response.text();
      cache = { body, etag: response.headers.get('etag'), fetchedAt: now };
      return { kind: 'ok', body };
    } catch {
      return staleOrUnavailable();
    }
  };
  return {
    async load(_signal?: AbortSignal) {
      const now = options.now?.() ?? Date.now();
      if (cache !== null && now - cache.fetchedAt < ttlMs) {
        return { kind: 'ok', body: cache.body };
      }
      if (pending) return pending;
      const flight = fetchShell().finally(() => {
        if (pending === flight) pending = undefined;
      });
      pending = flight;
      return flight;
    },
  };
}

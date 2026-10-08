/**
 * LEGACY OIDC JWKS client — DEPRECATED SOURCE (Task F1 quarantine).
 * Retained for audit and the legacy migration window; source retention is NOT
 * runtime enablement. Superseded by Better Auth
 * (docs/development/known-backend/better-auth/better-auth-migration-development-plan.md
 * §12 Task F1; G1 ADR §11). Ownership: Better Auth migration lane F — new
 * code reaches this surface only through
 * `src/infrastructure/auth/legacy-oidc-boundary.ts`. Keep behavior unchanged.
 *
 * Bounded JWKS HTTP client with max-age cache and forced refresh for key
 * rotation. Network failures map to typed IdTokenVerificationError reasons.
 *
 * @deprecated Legacy OIDC JWKS client.
 */
import type { JSONWebKeySet } from 'jose';
import {
  IdTokenVerificationError,
  type JwksProvider,
} from '../../modules/identity/index.js';
import {
  createHardenedEgressFetch,
  type HardenedEgressResolver,
} from '../egress/index.js';

/**
 * @deprecated Legacy OIDC JWKS client options (Task F1 quarantine).
 */
export interface CachingJwksClientOptions {
  readonly jwksUri: string;
  /**
   * Inject for tests. Defaults to the shared hardened egress fetch, which
   * validates the URL policy, resolves and classifies all A/AAAA records,
   * pins the connection to the validated address and revalidates every
   * redirect hop without ever reading proxy environment variables.
   */
  readonly fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** DNS resolver for the hardened egress adapter; defaults to system resolution. */
  readonly resolve?: HardenedEgressResolver;
  /** HTTP timeout for JWKS fetch. Default 5_000 ms. */
  readonly fetchTimeoutMs?: number;
  /** Maximum age of a cached JWKS document. Default 300_000 ms (5 minutes). */
  readonly cacheMaxAgeMs?: number;
  /** Maximum JWKS response body size. Default 1 MiB. */
  readonly maxResponseBytes?: number;
  /** Clock for cache expiry; defaults to Date.now. */
  readonly now?: () => number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_MAX_AGE_MS = 300_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * @deprecated Legacy OIDC JWKS client (Task F1 quarantine).
 */
export function createCachingJwksClient(options: CachingJwksClientOptions): JwksProvider {
  const fetchImpl = options.fetchImpl
    ?? createHardenedEgressFetch({ resolve: options.resolve, label: 'JWKS endpoint' });
  const fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const now = options.now ?? Date.now;

  let cache: { readonly document: JSONWebKeySet; readonly fetchedAt: number } | null = null;
  let inflight: Promise<JSONWebKeySet> | null = null;

  async function fetchDocument(): Promise<JSONWebKeySet> {
    if (inflight) return inflight;

    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
      try {
        const response = await fetchImpl(options.jwksUri, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new IdTokenVerificationError(
            'jwks_fetch_failed',
            `JWKS endpoint returned HTTP ${response.status}`,
          );
        }
        let body: unknown;
        try {
          const contentLength = Number(response.headers.get('content-length'));
          if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
            throw new IdTokenVerificationError(
              'jwks_malformed',
              `JWKS response exceeds ${maxResponseBytes} byte limit`,
            );
          }
          const text = await readBoundedResponseText(response, maxResponseBytes);
          body = JSON.parse(text) as unknown;
        } catch (error: unknown) {
          if (error instanceof IdTokenVerificationError) throw error;
          throw new IdTokenVerificationError('jwks_malformed', 'JWKS response is not valid JSON');
        }
        if (!isJsonWebKeySet(body)) {
          throw new IdTokenVerificationError(
            'jwks_malformed',
            'JWKS response is missing a keys array',
          );
        }
        cache = { document: body, fetchedAt: now() };
        return body;
      } catch (error: unknown) {
        if (error instanceof IdTokenVerificationError) throw error;
        if (isAbortError(error)) {
          throw new IdTokenVerificationError('jwks_timeout', 'JWKS fetch timed out');
        }
        throw new IdTokenVerificationError(
          'jwks_fetch_failed',
          error instanceof Error ? error.message : 'JWKS fetch failed',
        );
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();

    return inflight;
  }

  return {
    async getKeySet(getOptions = {}): Promise<JSONWebKeySet> {
      const forceRefresh = getOptions.forceRefresh === true;
      if (!forceRefresh && cache !== null && now() - cache.fetchedAt < cacheMaxAgeMs) {
        return cache.document;
      }
      return fetchDocument();
    },
  };
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new IdTokenVerificationError('jwks_malformed', 'JWKS response limit is invalid');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new IdTokenVerificationError(
        'jwks_malformed',
        `JWKS response exceeds ${maxBytes} byte limit`,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new IdTokenVerificationError(
          'jwks_malformed',
          `JWKS response exceeds ${maxBytes} byte limit`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isJsonWebKeySet(value: unknown): value is JSONWebKeySet {
  if (value === null || typeof value !== 'object') return false;
  const keys = (value as { keys?: unknown }).keys;
  return Array.isArray(keys);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return false;
}

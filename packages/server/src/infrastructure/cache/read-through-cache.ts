/**
 * T04 domain-neutral read-through cache policy (plan §3.2/§6.4 T04).
 *
 * `readThrough` is a reusable cache-aside reader that never references a
 * Publication (or any business) type. The caller supplies the cache key, a
 * domain policy (soft/hard TTL, downward jitter, serveStale, domain name,
 * entry-size and lock budget), a CacheStore, an origin loader, a clock and an
 * AbortSignal, plus a process-local CacheSingleflight and CacheBulkhead.
 *
 * Algorithm (plan §3.2):
 *   1. Read CacheStore.get(key) and classify via the T02 envelope codec:
 *      fresh_hit / miss / soft_expired / decode_error / unavailable.
 *   2. fresh hit        -> return the cached value (loader calls = 0).
 *   3. miss / soft_expired(serveStale=false) / decode_error -> in-process
 *      singleflight (key = domain:key), then a short Redis SET NX PX lock with
 *      a per-flight token. The lock owner loads from origin, validates and
 *      writes back (oversized/forbidden values are never written), then
 *      releases with a token-safe releaseIfOwner in a finally.
 *   4. unavailable      -> fail-open: load from origin under the bulkhead.
 *      Redis errors are converted into a classified result, never thrown to
 *      the reader. decode_error is treated as a miss (a fresh write overwrites
 *      the corrupt value).
 *   5. Non-owners wait for the owner (bounded by the lockWaitTimeoutMs
 *      deadline, with lockWaitCount as a minimum attempt floor), polling at a
 *      short jittered interval and re-reading the cache after each wait so a
 *      completed owner refresh is served from cache. After the budget is
 *      exhausted the request falls back to a bulkhead-limited origin load and
 *      never writes (no lock -> no write). A crashed owner's lock expires via
 *      its TTL and the next poll takes over.
 *   6. serveStale defaults to false; with false a soft-expired value is never
 *      returned after a refresh failure (loader_error instead). serveStale=true
 *      serves the soft-expired value immediately without background refresh
 *      (T04 forbids background refresh and the Publication domains never
 *      enable it).
 *
 * Error classification: CacheMiss is not an exception; cache_unavailable,
 * cache_decode_error and loader errors are kept as distinct kinds/paths in the
 * result so callers (T05 metrics) never collapse them into a single 500.
 *
 * All timers, singleflight entries and lock cleanup are settled in finally;
 * no promise is left un-awaited.
 */
import { randomUUID } from 'node:crypto';
import { CACHE_ERROR_CATEGORY, CacheStoreError, type CacheStore } from './cache-store.js';
import { decodeCacheEnvelope, encodeCacheEnvelope, type CacheEnvelopeTimes } from './cache-envelope.js';
import { CacheAbortError, isCacheAbortError, throwIfCacheAborted } from './cache-abort.js';
import { CacheBulkhead, CacheBulkheadError } from './cache-bulkhead.js';
import { type CacheSingleflightLike } from './cache-singleflight.js';

/** Low-cardinality path that led to an origin load (T05 metric label source). */
export type CacheRefreshPath =
  | 'miss'
  | 'soft_expired'
  | 'decode_error'
  | 'cache_unavailable'
  | 'lock_unavailable'
  | 'lock_wait_exceeded';

export type CacheRefreshStartPath = 'miss' | 'soft_expired' | 'decode_error';

/**
 * Domain-neutral read policy. `softTtlMs < hardTtlMs` is validated here (T01
 * already validates the config pairs); `jitterMs` is a downward-only jitter
 * budget on the hard TTL and is validated to be smaller than the hard TTL.
 * `serveStale` defaults to false and the Publication domains must not override
 * it. `lockWaitCount` (minimum attempts) and `lockWaitTimeoutMs` (total
 * budget) bound how long a non-owner waits before a bulkhead-limited
 * fallback load.
 */
export interface CacheReadPolicy {
  /** Low-cardinality domain label (e.g. 'publication-metadata'); never a cache key or query. */
  readonly domain: string;
  readonly softTtlMs: number;
  readonly hardTtlMs: number;
  /** Maximum downward jitter (ms) applied to the hard TTL at write time. */
  readonly jitterMs?: number;
  /** Default false. */
  readonly serveStale?: boolean;
  /** Envelope size budget (config.cache.limits.maxEntryBytes). */
  readonly maxEntryBytes: number;
  /** Distributed lock TTL (config.cache.limits.lockTtlMs). */
  readonly lockTtlMs: number;
  /**
   * Minimum lock-wait attempts before a bulkhead-limited fallback load; the
   * lockWaitTimeoutMs deadline is the hard bound. Default 3.
   */
  readonly lockWaitCount?: number;
  /** Total lock-wait budget (ms). Defaults to lockWaitCount * lockTtlMs. */
  readonly lockWaitTimeoutMs?: number;
}

export interface CacheReadDependencies {
  readonly store: CacheStore;
  /** Origin loader; `null` means not found (nothing is cached). A throw is a loader error. */
  readonly loader: (signal: AbortSignal) => Promise<unknown | null>;
  /** Injectable clock (ms) used for freshness classification and write-back TTLs. */
  readonly clock: () => number;
  /** Injectable RNG in [0, 1) for jitter; defaults to Math.random. */
  readonly random?: () => number;
  /** Injectable lock-token generator; defaults to crypto.randomUUID. */
  readonly tokenFactory?: () => string;
  /** Injectable wait used between lock attempts; defaults to cacheDefaultSleep. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Process-local singleflight (one per API/Worker composition, never global). */
  readonly singleflight: CacheSingleflightLike;
  /** Bounded fallback bulkhead that caps concurrent origin loads. */
  readonly bulkhead: CacheBulkhead;
  /** Optional domain validator applied after decode and before every write-back. */
  readonly validateCachedValue?: (value: unknown) => boolean;
}

export type ReadThroughResult<T> =
  | {
      readonly kind: 'cache_hit';
      readonly value: T;
      readonly writtenAtMs: number;
      readonly hardExpiresAtMs: number;
      readonly entryBytes?: number;
    }
  | {
      readonly kind: 'stale_hit';
      readonly value: T;
      readonly writtenAtMs: number;
      readonly softExpiresAtMs: number;
      readonly hardExpiresAtMs: number;
      readonly entryBytes?: number;
    }
  | {
      readonly kind: 'origin';
      readonly value: T;
      readonly path: CacheRefreshPath;
      readonly cached: boolean;
      readonly writtenAtMs?: number;
      readonly softExpiresAtMs?: number;
      readonly hardExpiresAtMs?: number;
      readonly entryBytes?: number;
      /** Redis accepted the read/lock path but rejected the write-back. */
      readonly redisFailure?: 'write_unavailable';
    }
  | { readonly kind: 'not_found'; readonly path: CacheRefreshPath }
  | { readonly kind: 'loader_error'; readonly path: CacheRefreshPath; readonly error: unknown }
  | { readonly kind: 'fallback_rejected'; readonly reason: 'bulkhead_full' };

/** Programmer-error guard for an invalid CacheReadPolicy (never an HTTP error). */
export class CacheReadPolicyError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'CacheReadPolicyError';
    this.reason = reason;
  }
}

/**
 * RDS-04 (T-10, 2026-08-27 backend performance audit): a `fallback_rejected`
 * result means the fallback bulkhead is at capacity while Redis is degraded —
 * a bounded-overload condition, not a server fault. Domain decorators throw
 * this typed error so transports can answer 503 (+ Retry-After) instead of
 * the generic 500 a bare Error produced.
 */
export class CacheFallbackRejectedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(`${domain} origin load rejected by the cache fallback bulkhead`);
    this.name = 'CacheFallbackRejectedError';
    this.domain = domain;
  }
}

interface NormalizedCacheReadPolicy {
  readonly domain: string;
  readonly softTtlMs: number;
  readonly hardTtlMs: number;
  readonly jitterMs: number;
  readonly serveStale: boolean;
  readonly maxEntryBytes: number;
  readonly lockTtlMs: number;
  readonly lockWaitCount: number;
  readonly lockWaitTimeoutMs: number;
}

/**
 * Extended version of T02's CacheLookupResult: the same five classifications
 * plus `writtenAtMs` on soft_expired so a stale hit can report its age.
 */
type CacheReadClassification<T> =
  | {
      readonly kind: 'fresh_hit';
      readonly value: T;
      readonly writtenAtMs: number;
      readonly hardExpiresAtMs: number;
      readonly entryBytes: number;
    }
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'soft_expired';
      readonly value: T;
      readonly writtenAtMs: number;
      readonly softExpiresAtMs: number;
      readonly hardExpiresAtMs: number;
      readonly entryBytes: number;
    }
  | { readonly kind: 'decode_error'; readonly category: typeof CACHE_ERROR_CATEGORY.DECODE_ERROR }
  | { readonly kind: 'unavailable'; readonly category: typeof CACHE_ERROR_CATEGORY.UNAVAILABLE };

/** Distributed-lock key derived from a data key: `<dataKey>:lock`. */
export function buildCacheLockKey(key: string): string {
  return `${key}:lock`;
}

/** Singleflight key scoped by domain so different cache domains never merge. */
export function buildCacheSingleflightKey(domain: string, key: string): string {
  return `${domain}:${key}`;
}

/** Default bounded wait between lock attempts; abortable, timer cleaned up. */
export function cacheDefaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new CacheAbortError('cache lock wait aborted'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    function onAbort(): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      cleanup();
      reject(new CacheAbortError('cache lock wait aborted'));
    }
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Poll interval for a non-owner lock waiter: a short fraction of the lease
 * TTL (so a completed owner is noticed quickly) clamped to a bounded band so
 * Redis is never hot-polled and the lease TTL itself stays the takeover bound.
 */
export function computeCacheLockPollIntervalMs(lockTtlMs: number): number {
  return Math.min(500, Math.max(100, Math.floor(lockTtlMs / 4)));
}

/** Uniform jitter sample in [0, budgetMs] from the injectable RNG (clamped). */
function sampleJitter(random: (() => number) | undefined, budgetMs: number): number {
  const rng = random ?? Math.random;
  const sample = Math.max(0, Math.min(1, rng()));
  return Math.floor(sample * (budgetMs + 1));
}

function normalizePolicy(policy: CacheReadPolicy): NormalizedCacheReadPolicy {
  if (
    typeof policy.domain !== 'string'
    || policy.domain.length === 0
    || policy.domain.length > 64
    || /[\u0000-\u001F\u007F\s]/u.test(policy.domain)
  ) {
    throw new CacheReadPolicyError(
      'invalid_domain',
      'cache read domain must be a non-empty 1..64 char label without whitespace or control characters',
    );
  }
  if (!Number.isSafeInteger(policy.softTtlMs) || policy.softTtlMs < 0) {
    throw new CacheReadPolicyError('invalid_soft_ttl', 'softTtlMs must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(policy.hardTtlMs) || policy.hardTtlMs <= policy.softTtlMs) {
    throw new CacheReadPolicyError('invalid_hard_ttl', 'hardTtlMs must be a safe integer strictly greater than softTtlMs');
  }
  const jitterMs = policy.jitterMs ?? 0;
  if (!Number.isSafeInteger(jitterMs) || jitterMs < 0 || jitterMs >= policy.hardTtlMs) {
    throw new CacheReadPolicyError('invalid_jitter', 'jitterMs must be a non-negative safe integer smaller than hardTtlMs');
  }
  if (!Number.isSafeInteger(policy.maxEntryBytes) || policy.maxEntryBytes < 1) {
    throw new CacheReadPolicyError('invalid_max_entry_bytes', 'maxEntryBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(policy.lockTtlMs) || policy.lockTtlMs < 1) {
    throw new CacheReadPolicyError('invalid_lock_ttl', 'lockTtlMs must be a positive safe integer');
  }
  const lockWaitCount = policy.lockWaitCount ?? 3;
  if (!Number.isSafeInteger(lockWaitCount) || lockWaitCount < 1) {
    throw new CacheReadPolicyError('invalid_lock_wait_count', 'lockWaitCount must be a positive safe integer');
  }
  const lockWaitTimeoutMs = policy.lockWaitTimeoutMs ?? lockWaitCount * policy.lockTtlMs;
  if (!Number.isSafeInteger(lockWaitTimeoutMs) || lockWaitTimeoutMs < 1) {
    throw new CacheReadPolicyError('invalid_lock_wait_timeout', 'lockWaitTimeoutMs must be a positive safe integer');
  }
  return {
    domain: policy.domain,
    softTtlMs: policy.softTtlMs,
    hardTtlMs: policy.hardTtlMs,
    jitterMs,
    serveStale: policy.serveStale ?? false,
    maxEntryBytes: policy.maxEntryBytes,
    lockTtlMs: policy.lockTtlMs,
    lockWaitCount,
    lockWaitTimeoutMs,
  };
}

function isCacheUnavailable(error: unknown): boolean {
  return error instanceof CacheStoreError && error.category === CACHE_ERROR_CATEGORY.UNAVAILABLE;
}

async function readCache<T>(
  key: string,
  policy: NormalizedCacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
): Promise<CacheReadClassification<T>> {
  let raw: string | null;
  try {
    raw = await deps.store.get(key, signal);
  } catch (error) {
    if (isCacheUnavailable(error)) {
      return { kind: 'unavailable', category: CACHE_ERROR_CATEGORY.UNAVAILABLE };
    }
    throw error;
  }
  if (raw === null) return { kind: 'miss' };

  const decoded = decodeCacheEnvelope<T>(raw, { maxEntryBytes: policy.maxEntryBytes });
  if (decoded.kind === 'decode_error') {
    return { kind: 'decode_error', category: CACHE_ERROR_CATEGORY.DECODE_ERROR };
  }
  const envelope = decoded.envelope;
  if (deps.validateCachedValue !== undefined && !deps.validateCachedValue(envelope.value)) {
    return { kind: 'decode_error', category: CACHE_ERROR_CATEGORY.DECODE_ERROR };
  }
  const now = deps.clock();
  if (now < envelope.softExpiresAtMs) {
    return {
      kind: 'fresh_hit',
      value: envelope.value,
      writtenAtMs: envelope.writtenAtMs,
      hardExpiresAtMs: envelope.hardExpiresAtMs,
      entryBytes: decoded.utf8Bytes,
    };
  }
  if (now < envelope.hardExpiresAtMs) {
    return {
      kind: 'soft_expired',
      value: envelope.value,
      writtenAtMs: envelope.writtenAtMs,
      softExpiresAtMs: envelope.softExpiresAtMs,
      hardExpiresAtMs: envelope.hardExpiresAtMs,
      entryBytes: decoded.utf8Bytes,
    };
  }
  return { kind: 'miss' };
}

/**
 * Reads a cache key through the T04 policy. The initial cache read happens
 * before singleflight so a fresh hit never touches the flight; misses and
 * refreshes enter the per-domain singleflight for the whole lock dance.
 */
export async function readThrough<T>(
  key: string,
  policy: CacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
): Promise<ReadThroughResult<T>> {
  const normalized = normalizePolicy(policy);
  throwIfCacheAborted(signal);

  const classification = await readCache<T>(key, normalized, deps, signal);
  switch (classification.kind) {
    case 'fresh_hit':
      return {
        kind: 'cache_hit',
        value: classification.value,
        writtenAtMs: classification.writtenAtMs,
        hardExpiresAtMs: classification.hardExpiresAtMs,
        entryBytes: classification.entryBytes,
      };
    case 'soft_expired':
      if (normalized.serveStale) {
        return {
          kind: 'stale_hit',
          value: classification.value,
          writtenAtMs: classification.writtenAtMs,
          softExpiresAtMs: classification.softExpiresAtMs,
          hardExpiresAtMs: classification.hardExpiresAtMs,
          entryBytes: classification.entryBytes,
        };
      }
      return refresh<T>(key, normalized, deps, signal, 'soft_expired');
    case 'miss':
      return refresh<T>(key, normalized, deps, signal, 'miss');
    case 'decode_error':
      return refresh<T>(key, normalized, deps, signal, 'decode_error');
    case 'unavailable':
      return loadFromOrigin<T>(key, normalized, deps, signal, 'cache_unavailable');
  }
}

function refresh<T>(
  key: string,
  policy: NormalizedCacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
  startPath: CacheRefreshStartPath,
): Promise<ReadThroughResult<T>> {
  const flightKey = buildCacheSingleflightKey(policy.domain, key);
  return deps.singleflight.run(flightKey, signal, (flightSignal) =>
    refreshLeader<T>(key, policy, deps, flightSignal, startPath),
  );
}

async function refreshLeader<T>(
  key: string,
  policy: NormalizedCacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
  startPath: CacheRefreshStartPath,
): Promise<ReadThroughResult<T>> {
  const lockKey = buildCacheLockKey(key);
  const token = (deps.tokenFactory ?? defaultTokenFactory)();
  const sleep = deps.sleep ?? cacheDefaultSleep;
  const pollIntervalMs = computeCacheLockPollIntervalMs(policy.lockTtlMs);
  // Short polls fit far more attempts inside the budget than the old
  // one-sleep-per-lease cadence: the total deadline is the hard bound and
  // lockWaitCount stays a minimum, so attempts are never exhausted before a
  // crashed owner's lease can expire and be taken over.
  const attemptsCap = Math.max(policy.lockWaitCount, Math.ceil(policy.lockWaitTimeoutMs / pollIntervalMs));
  const deadline = deps.clock() + policy.lockWaitTimeoutMs;
  let lockHeld = false;
  let attempts = 0;

  try {
    while (attempts < attemptsCap && deps.clock() < deadline) {
      throwIfCacheAborted(signal);

      let acquired: boolean;
      try {
        acquired = await deps.store.setIfAbsent(lockKey, token, policy.lockTtlMs, signal);
      } catch (error) {
        if (isCacheUnavailable(error)) {
          return await loadFromOrigin<T>(key, policy, deps, signal, 'lock_unavailable');
        }
        throw error;
      }

      if (acquired) {
        lockHeld = true;
        return await loadFromOrigin<T>(key, policy, deps, signal, startPath);
      }

      // Another process owns the lock: poll at a short jittered interval
      // (never the full lease TTL) so a completed owner refresh is served
      // from cache quickly, while jitter desynchronizes concurrent waiters.
      await sleep(pollIntervalMs + sampleJitter(deps.random, pollIntervalMs), signal);
      const recheck = await readCache<T>(key, policy, deps, signal);
      switch (recheck.kind) {
        case 'fresh_hit':
          return {
            kind: 'cache_hit',
            value: recheck.value,
            writtenAtMs: recheck.writtenAtMs,
            hardExpiresAtMs: recheck.hardExpiresAtMs,
            entryBytes: recheck.entryBytes,
          };
        case 'soft_expired':
          if (policy.serveStale) {
            return {
              kind: 'stale_hit',
              value: recheck.value,
              writtenAtMs: recheck.writtenAtMs,
              softExpiresAtMs: recheck.softExpiresAtMs,
              hardExpiresAtMs: recheck.hardExpiresAtMs,
              entryBytes: recheck.entryBytes,
            };
          }
          break;
        case 'miss':
        case 'decode_error':
          break;
        case 'unavailable':
          return await loadFromOrigin<T>(key, policy, deps, signal, 'cache_unavailable');
      }
      attempts += 1;
    }

    // Lock budget exhausted: bulkhead-limited origin load, never writing
    // without a lock. serveStale=false means a stale value is never returned.
    return await loadFromOrigin<T>(key, policy, deps, signal, 'lock_wait_exceeded');
  } finally {
    if (lockHeld) {
      try {
        // Use a fresh, never-aborted signal: a cancelled request must still
        // release its own lock token.
        await deps.store.releaseIfOwner(lockKey, token, new AbortController().signal);
      } catch (error) {
        if (!isCacheUnavailable(error)) throw error;
        // Redis unavailable at unlock time: the lock TTL expires it naturally.
      }
    }
  }
}

async function loadFromOrigin<T>(
  key: string,
  policy: NormalizedCacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
  path: CacheRefreshPath,
): Promise<ReadThroughResult<T>> {
  let value: unknown;
  try {
    value = await deps.bulkhead.run(signal, (s) => deps.loader(s));
  } catch (error) {
    if (error instanceof CacheBulkheadError) {
      return { kind: 'fallback_rejected', reason: 'bulkhead_full' };
    }
    if (isCacheAbortError(error)) throw error;
    return { kind: 'loader_error', path, error };
  }
  if (value === null) return { kind: 'not_found', path };

  const write = await writeBackIfCacheable(key, policy, deps, signal, value);
  if (write.kind === 'ok') {
    return {
      kind: 'origin',
      value: value as T,
      path,
      cached: true,
      writtenAtMs: write.times.writtenAtMs,
      softExpiresAtMs: write.times.softExpiresAtMs,
      hardExpiresAtMs: write.times.hardExpiresAtMs,
      entryBytes: write.entryBytes,
    };
  }
  if (write.kind === 'unavailable') {
    return {
      kind: 'origin',
      value: value as T,
      path,
      cached: false,
      redisFailure: 'write_unavailable',
    };
  }
  return { kind: 'origin', value: value as T, path, cached: false };
}

type WriteBackResult =
  | { readonly kind: 'ok'; readonly times: CacheEnvelopeTimes; readonly entryBytes: number }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'unavailable' };

/**
 * Encodes and writes a successful loader value. Oversized/forbidden/invalid
 * values are never written (the origin result is still served). The envelope
 * times are computed by the writer from the policy; readers classify purely
 * with the injected clock. Jitter only ever subtracts from the hard TTL and is
 * additionally clamped so soft < hard always holds.
 */
async function writeBackIfCacheable(
  key: string,
  policy: NormalizedCacheReadPolicy,
  deps: CacheReadDependencies,
  signal: AbortSignal,
  value: unknown,
): Promise<WriteBackResult> {
  if (deps.validateCachedValue !== undefined && !deps.validateCachedValue(value)) return { kind: 'skipped' };
  const now = deps.clock();
  const jitter = computeHardJitter(policy, deps.random);
  const softExpiresAtMs = now + policy.softTtlMs;
  const hardExpiresAtMs = Math.max(now + policy.hardTtlMs - jitter, softExpiresAtMs + 1);
  const times: CacheEnvelopeTimes = { writtenAtMs: now, softExpiresAtMs, hardExpiresAtMs };

  const encoded = encodeCacheEnvelope(value, times, { maxEntryBytes: policy.maxEntryBytes });
  if (encoded.kind !== 'ok') return { kind: 'skipped' };

  const ttlMs = hardExpiresAtMs - now;
  try {
    await deps.store.set(key, encoded.encoded, ttlMs, signal);
    return { kind: 'ok', times, entryBytes: encoded.utf8Bytes };
  } catch (error) {
    if (isCacheUnavailable(error)) return { kind: 'unavailable' };
    throw error;
  }
}

function computeHardJitter(policy: NormalizedCacheReadPolicy, random: (() => number) | undefined): number {
  if (policy.jitterMs === 0) return 0;
  return sampleJitter(random, policy.jitterMs);
}

function defaultTokenFactory(): string {
  return randomUUID();
}

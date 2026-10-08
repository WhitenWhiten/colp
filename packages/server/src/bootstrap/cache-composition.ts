/**
 * T10 API cache composition (plan §6.4 T10 / §5) plus library bookmark-count
 * composition (plan §5.3 / §7 P5): owns the optional Redis runtime for the
 * API process, wires the T06-T08 Publication query decorators and the P4
 * bookmark-count decorator into the transport, and exposes readiness plus
 * graceful-close lifecycle.
 *
 * Composition rules (plan §5 / §6.4 T10):
 *
 * - mode=off  -> no Redis client is ever created, no decorator is built, and
 *   the Publication queries stay exactly on the reference PostgreSQL path.
 *   Domain flags cannot force a connection; they only gate domains when the
 *   master mode is shadow/serve. This includes CACHE_COLLECTION_BOOKMARK_COUNT_ENABLED.
 * - mode=shadow -> the cached reader runs (it reads/writes Redis and may
 *   re-load origin on miss), then the authoritative origin reader runs again
 *   and its result is ALWAYS returned. When the cached digest differs the
 *   mismatch is counted (`cache.shadow.digest_mismatch`) and the origin result
 *   is still served. The extra origin call on a cache miss is the accepted,
 *   documented shadow-mode cost: shadow exists to validate key/digest/write
 *   parity, not to save database work.
 * - mode=serve -> the cache-aside result is returned (hit serves the cache;
 *   miss or Redis-unavailable falls back to origin under the T04 bulkhead).
 *
 * Lifecycle:
 * - One CacheStore per API process (no global singleton); `close()` is
 *   idempotent and bounded and the transport onClose hook calls it.
 * - Readiness uses computeCacheReadiness: disabled for off; degraded when the
 *   breaker is open/half-open or the store reports degraded; healthy otherwise.
 *   KNOWN_CACHE_REQUIRED only affects the /ready probe (fail closed), never
 *   liveness and never per-request HTTP errors.
 *
 * The T05 failure policy wraps each complete domain cache attempt, including
 * the epoch read, so breaker, bulkhead, metrics and readiness share one state.
 */
import { createHash } from 'node:crypto';
import {
  CacheBulkhead,
  CacheCircuitBreaker,
  CacheSingleflight,
  COLLECTION_BOOKMARK_COUNT_CACHE_DOMAIN,
  computeCacheReadiness,
  createCacheFailurePolicy,
  createCollectionBookmarkCountCache,
  createRedisCacheStore,
  type CacheHealthState,
  type CacheReadinessState,
  type CacheStore,
  type CollectionBookmarkCountCache,
  type CollectionBookmarkCountCacheOrigin,
  type RedisCacheConnectionConfig,
  type RedisClientLike,
  type RedisClientOptions,
} from '../infrastructure/cache/index.js';
import {
  createPublicationDirectoryCache,
  createPublicationMetadataCache,
  createPublicationSnapshotCache,
  type PublicationDirectoryCacheReader,
  type PublicationMetadataCacheReader,
  type PublicationSnapshotCacheReader,
  type PublicationSnapshotCacheResult,
} from '../infrastructure/publication/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import {
  asCollectionBookmarkCountLookup,
  type CollectionBookmarkCountLookupPort,
} from '../modules/collections/index.js';
import {
  getPublicationCollectionMetadata,
  getPublicationDirectoryPage,
  getPublicationSnapshotPage,
} from '../modules/publication/index.js';
import type {
  PublicationDirectoryPageResult,
  PublicationMetadataResult,
} from '../modules/publication/index.js';
import type { CacheConfig, CacheEntryLimitsConfig, CacheTtlConfig } from './config.js';

/** Low-cardinality shadow-mode digest mismatch counter (plan §5/§6.4 T10). */
export const CACHE_SHADOW_DIGEST_MISMATCH_METRIC = 'cache.shadow.digest_mismatch';

/** Default fallback bulkhead capacity (origin-load concurrency cap). */
export const DEFAULT_CACHE_BULKHEAD_CAPACITY = 8;
/** Default consecutive Redis failures that open the readiness breaker. */
export const DEFAULT_CACHE_BREAKER_FAILURE_THRESHOLD = 3;
/** Default breaker cooldown before a half-open probe is admitted. */
export const DEFAULT_CACHE_BREAKER_COOLDOWN_MS = 1_000;

export interface CacheCompositionOptions {
  readonly config: CacheConfig;
  /** Report cache domains stay inert until the report feature itself is on. */
  readonly reportsEnabled?: boolean;
  readonly metrics?: Metrics;
  /** Test seam: replaces the Redis runtime factory. mode=off must never call it. */
  readonly createStore?: (config: RedisCacheConnectionConfig) => CacheStore;
  /** Test seam: pass through to createRedisCacheStore's createClient. */
  readonly createClient?: (url: string, options: RedisClientOptions) => RedisClientLike;
  /** Bounded graceful-close budget (ms) for the Redis runtime. */
  readonly closeTimeoutMs?: number;
  /** Injectable clock (ms) for cache freshness and the breaker; defaults to Date.now. */
  readonly clock?: () => number;
  /** Injectable RNG for envelope jitter (policy forces jitter 0; kept for seam parity). */
  readonly random?: () => number;
  /** Injectable distributed-lock token factory. */
  readonly tokenFactory?: () => string;
  /** Fallback bulkhead capacity; defaults to DEFAULT_CACHE_BULKHEAD_CAPACITY. */
  readonly bulkheadCapacity?: number;
  /** Breaker failure threshold; defaults to DEFAULT_CACHE_BREAKER_FAILURE_THRESHOLD. */
  readonly breakerFailureThreshold?: number;
  /** Breaker cooldown (ms); defaults to DEFAULT_CACHE_BREAKER_COOLDOWN_MS. */
  readonly breakerCooldownMs?: number;
  /** Cache key environment namespace; api.ts passes nodeEnv. */
  readonly environment?: string;
}

/** Capability payload for /ready/features/cache (structural match with health.ts). */
export interface ApiCacheCapabilityReadiness {
  readonly capability: 'cache';
  readonly status: 'ready' | 'degraded' | 'disabled' | 'not-ready';
  readonly mode?: 'off' | 'shadow' | 'serve';
  readonly required?: boolean;
  readonly storeHealth?: CacheHealthState;
  readonly circuitState?: 'closed' | 'open' | 'half_open';
  readonly reason?: string;
}

export interface ApiCacheComposition {
  readonly mode: 'off' | 'shadow' | 'serve';
  readonly required: boolean;
  /** Cached (or shadow-wrapped) Metadata reader; undefined when off/domain-disabled. */
  readonly metadataReader: PublicationMetadataCacheReader | undefined;
  /** Cached (or shadow-wrapped) Directory reader; undefined when off/domain-disabled. */
  readonly directoryReader: PublicationDirectoryCacheReader | undefined;
  /** Cached (or shadow-wrapped) Snapshot reader; undefined when off/domain-disabled. */
  readonly snapshotReader: PublicationSnapshotCacheReader | undefined;
  /**
   * Bind the process-local bookmark-count decorator to an origin COUNT port.
   * Undefined when mode=off or the domain flag is false. The returned cache
   * shares this composition's CacheStore and never opens a second Redis client.
   */
  readonly bookmarkCountCache:
    | ((origin: CollectionBookmarkCountCacheOrigin) => CollectionBookmarkCountCache)
    | undefined;
  readonly reportCache?: undefined;
  readiness(): Promise<CacheReadinessState>;
  capabilityReadiness(): Promise<ApiCacheCapabilityReadiness>;
  /** Bounded, idempotent close of the Redis client; no-op for mode=off. */
  close(): Promise<void>;
}

function domainPolicy(
  domain: string,
  ttl: CacheTtlConfig,
  limits: CacheEntryLimitsConfig,
): {
  readonly domain: string;
  readonly softTtlMs: number;
  readonly hardTtlMs: number;
  readonly jitterMs: number;
  readonly serveStale: false;
  readonly maxEntryBytes: number;
  readonly lockTtlMs: number;
  readonly lockWaitCount: number;
} {
  return {
    domain,
    softTtlMs: ttl.softTtlMs,
    hardTtlMs: ttl.hardTtlMs,
    jitterMs: 0,
    serveStale: false,
    maxEntryBytes: limits.maxEntryBytes,
    lockTtlMs: limits.lockTtlMs,
    lockWaitCount: 3,
  };
}

/** Plan §5.2: 0%–10% downward jitter on hard TTL; serveStale is forced false. */
function bookmarkCountPolicy(
  ttl: CacheTtlConfig,
  limits: CacheEntryLimitsConfig,
): {
  readonly domain: string;
  readonly softTtlMs: number;
  readonly hardTtlMs: number;
  readonly jitterMs: number;
  readonly serveStale: false;
  readonly maxEntryBytes: number;
  readonly lockTtlMs: number;
  readonly lockWaitCount: number;
} {
  return {
    domain: COLLECTION_BOOKMARK_COUNT_CACHE_DOMAIN,
    softTtlMs: ttl.softTtlMs,
    hardTtlMs: ttl.hardTtlMs,
    jitterMs: Math.floor(ttl.hardTtlMs * 0.1),
    serveStale: false,
    maxEntryBytes: limits.maxEntryBytes,
    lockTtlMs: limits.lockTtlMs,
    lockWaitCount: 3,
  };
}

function cacheDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
}

function shadowMetadataReader(
  cached: PublicationMetadataCacheReader,
  metrics: Metrics | undefined,
): PublicationMetadataCacheReader {
  return async (ports, input, signal) => {
    let cachedResult: PublicationMetadataResult | undefined;
    try {
      cachedResult = await cached(ports, input, signal);
    } catch {
      // The cache side failed (Redis unavailable, a negative entry, or a loader
      // error). The authoritative origin below decides the outcome.
    }
    const authoritative = await getPublicationCollectionMetadata(ports, input, signal);
    if (cachedResult !== undefined && cacheDigest(cachedResult) !== cacheDigest(authoritative)) {
      metrics?.increment(CACHE_SHADOW_DIGEST_MISMATCH_METRIC);
    }
    return authoritative;
  };
}

function shadowDirectoryReader(
  cached: PublicationDirectoryCacheReader,
  metrics: Metrics | undefined,
): PublicationDirectoryCacheReader {
  return async (ports, input, signal) => {
    let cachedResult: PublicationDirectoryPageResult | undefined;
    try {
      cachedResult = await cached(ports, input, signal);
    } catch {
      // Cache side failed; the authoritative origin decides.
    }
    const authoritative = await getPublicationDirectoryPage(ports, input, signal);
    // Compare the same route-visible fields while preserving the authoritative
    // projection for authenticated bypasses.
    const wire = Object.freeze({
      projection: authoritative.projection,
      directory: authoritative.directory,
      nextCursor: authoritative.nextCursor,
    });
    if (cachedResult !== undefined && cacheDigest(cachedResult) !== cacheDigest(wire)) {
      metrics?.increment(CACHE_SHADOW_DIGEST_MISMATCH_METRIC);
    }
    return authoritative;
  };
}

function shadowSnapshotReader(
  cached: PublicationSnapshotCacheReader,
  metrics: Metrics | undefined,
): PublicationSnapshotCacheReader {
  return async (ports, input, signal) => {
    let cachedResult: PublicationSnapshotCacheResult | undefined;
    try {
      cachedResult = await cached(ports, input, signal);
    } catch {
      // Cache side failed; the authoritative origin decides.
    }
    const authoritative = await getPublicationSnapshotPage(ports, input, signal);
    // Strip the internal ownerSubjectId authority fact the same way the
    // decorator does (toCachedValue), keeping the digest comparison stable.
    const wire = Object.freeze({
      projection: authoritative.projection,
      snapshot: authoritative.snapshot,
      nextCursor: authoritative.nextCursor,
      byteLength: authoritative.byteLength,
    });
    if (cachedResult !== undefined && cacheDigest(cachedResult) !== cacheDigest(wire)) {
      metrics?.increment(CACHE_SHADOW_DIGEST_MISMATCH_METRIC);
    }
    return wire;
  };
}

function countsWire(
  counts: ReadonlyMap<string, number>,
  ids: readonly string[],
): readonly number[] {
  return ids.map((id) => counts.get(id) ?? 0);
}

function shadowBookmarkCountLookup(
  cached: CollectionBookmarkCountCache,
  origin: CollectionBookmarkCountCacheOrigin,
  metrics: Metrics | undefined,
): CollectionBookmarkCountLookupPort {
  return {
    async lookupBookmarkCounts(entries) {
      let cachedResult: ReadonlyMap<string, number> | undefined;
      try {
        cachedResult = await cached.lookupBookmarkCounts(entries);
      } catch {
        // Cache side failed; the authoritative origin decides.
      }
      const ids = entries.map((entry) => entry.collectionId);
      const authoritative = ids.length === 0
        ? new Map<string, number>()
        : await origin.countBookmarks(ids);
      if (
        cachedResult !== undefined
        && cacheDigest(countsWire(cachedResult, ids)) !== cacheDigest(countsWire(authoritative, ids))
      ) {
        metrics?.increment(CACHE_SHADOW_DIGEST_MISMATCH_METRIC);
      }
      return authoritative;
    },
  };
}

/**
 * Bind the origin COUNT port to this process's cache composition.
 * off / domain-disabled → one GROUP BY and no Redis. shadow always returns
 * origin COUNT (mismatch counted). serve returns the cache lookup.
 */
export function composeCollectionBookmarkCountLookup(
  composition: ApiCacheComposition,
  origin: CollectionBookmarkCountCacheOrigin,
  metrics?: Metrics,
): CollectionBookmarkCountLookupPort {
  if (composition.bookmarkCountCache === undefined) {
    return asCollectionBookmarkCountLookup(origin);
  }
  const cached = composition.bookmarkCountCache(origin);
  if (composition.mode === 'shadow') {
    return shadowBookmarkCountLookup(cached, origin, metrics);
  }
  return cached;
}

export function createApiCacheComposition(options: CacheCompositionOptions): ApiCacheComposition {
  const { config, metrics } = options;
  const mode = config.redis.mode;
  const required = config.redis.required;
  const environment = options.environment ?? 'default';
  const key = { environment, keyPrefix: config.redis.keyPrefix };

  if (mode === 'off') {
    // Reference path: no Redis client, no decorator, no per-domain reader.
    return Object.freeze({
      mode,
      required,
      metadataReader: undefined,
      directoryReader: undefined,
      snapshotReader: undefined,
      bookmarkCountCache: undefined,
      reportCache: undefined,
      readiness: async (): Promise<CacheReadinessState> => 'disabled',
      capabilityReadiness: async (): Promise<ApiCacheCapabilityReadiness> => Object.freeze({
        capability: 'cache',
        status: 'disabled',
        mode: 'off',
        required,
      }),
      close: async (): Promise<void> => undefined,
    });
  }

  // shadow|serve: create the process-local Redis runtime exactly once.
  const store = options.createStore !== undefined
    ? options.createStore(config.redis)
    : createRedisCacheStore(config.redis, {
        ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
        ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      });
  const singleflight = new CacheSingleflight();
  const bulkhead = new CacheBulkhead(options.bulkheadCapacity ?? DEFAULT_CACHE_BULKHEAD_CAPACITY);
  const breaker = new CacheCircuitBreaker({
    failureThreshold: options.breakerFailureThreshold ?? DEFAULT_CACHE_BREAKER_FAILURE_THRESHOLD,
    cooldownMs: options.breakerCooldownMs ?? DEFAULT_CACHE_BREAKER_COOLDOWN_MS,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const clock = options.clock ?? Date.now;
  const failurePolicy = createCacheFailurePolicy(breaker, bulkhead, {
    clock,
    ...(metrics === undefined ? {} : { metrics }),
  });
  const deps = {
    store,
    singleflight,
    bulkhead,
    failurePolicy,
    clock,
    ...(metrics === undefined ? {} : { metrics }),
    ...(options.random === undefined ? {} : { random: options.random }),
    ...(options.tokenFactory === undefined ? {} : { tokenFactory: options.tokenFactory }),
  };

  let metadataReader: PublicationMetadataCacheReader | undefined;
  if (config.publication.metadataEnabled) {
    const cached = createPublicationMetadataCache({
      policy: domainPolicy('publication-metadata', config.publication.metadata, config.limits),
      deps,
      key,
    });
    metadataReader = mode === 'shadow' ? shadowMetadataReader(cached, metrics) : cached;
  }

  let directoryReader: PublicationDirectoryCacheReader | undefined;
  if (config.publication.directoryEnabled) {
    const cached = createPublicationDirectoryCache({
      policy: domainPolicy('publication-directory', config.publication.directory, config.limits),
      deps,
      key,
    });
    directoryReader = mode === 'shadow' ? shadowDirectoryReader(cached, metrics) : cached;
  }

  let snapshotReader: PublicationSnapshotCacheReader | undefined;
  if (config.publication.snapshotEnabled) {
    const cached = createPublicationSnapshotCache({
      policy: domainPolicy('publication-snapshot', config.publication.snapshot, config.limits),
      deps,
      key,
    });
    snapshotReader = mode === 'shadow' ? shadowSnapshotReader(cached, metrics) : cached;
  }

  let bookmarkCountCache:
    | ((origin: CollectionBookmarkCountCacheOrigin) => CollectionBookmarkCountCache)
    | undefined;
  if (config.collection.bookmarkCountEnabled) {
    const policy = bookmarkCountPolicy(config.collection.bookmarkCount, config.limits);
    bookmarkCountCache = (origin) => createCollectionBookmarkCountCache({
      store,
      origin,
      clock,
      singleflight,
      bulkhead,
      // T-11 (RDS-05): share the T05 breaker so an open circuit skips Redis
      // for bookmark counts exactly like the Publication domains.
      breaker,
      key,
      policy,
      ...(options.random === undefined ? {} : { random: options.random }),
      ...(options.tokenFactory === undefined ? {} : { tokenFactory: options.tokenFactory }),
    });
  }

  const reportCache = undefined;

  async function observeHealth(): Promise<{ readonly storeHealth: CacheHealthState; readonly state: CacheReadinessState }> {
    let storeHealth: CacheHealthState;
    try {
      storeHealth = await store.health();
    } catch {
      storeHealth = 'degraded';
    }
    return {
      storeHealth,
      state: computeCacheReadiness({ mode, circuitState: breaker.currentState, storeHealth }),
    };
  }

  const readiness = async (): Promise<CacheReadinessState> => (await observeHealth()).state;

  const capabilityReadiness = async (): Promise<ApiCacheCapabilityReadiness> => {
    const { storeHealth, state } = await observeHealth();
    return Object.freeze({
      capability: 'cache',
      status: state === 'healthy' ? 'ready' : state,
      mode,
      required,
      storeHealth,
      circuitState: breaker.currentState,
    });
  };

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= Promise.resolve().then(() => store.close());
    return closePromise;
  };

  return Object.freeze({
    mode,
    required,
    metadataReader,
    directoryReader,
    snapshotReader,
    bookmarkCountCache,
    reportCache,
    readiness,
    capabilityReadiness,
    close,
  });
}

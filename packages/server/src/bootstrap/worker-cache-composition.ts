/**
 * Worker-owned Redis cache composition.
 *
 * Keeping this boundary separate from the worker bootstrap makes the process
 * lifecycle readable while preserving the one-store/one-close invariant. The
 * API cache has a different composition and must never share this store.
 */
import {
  computeCacheReadiness,
  createRedisCacheStore,
  type CacheHealthState,
  type CacheReadinessState,
  type CacheStore,
  type RedisCacheConnectionConfig,
  type RedisClientLike,
  type RedisClientOptions,
} from '../infrastructure/cache/index.js';
import {
  CompositePublicationCachePurgeProvider,
  RedisPublicationCacheInvalidator,
  type PublicationCachePurgeProvider,
} from '../infrastructure/outbox/index.js';
import type { Metrics } from '../infrastructure/telemetry/index.js';
import type { CacheConfig, CacheMode } from './config.js';

/** T11 worker cache readiness gauge: 0=disabled, 1=degraded, 2=healthy. */
export const CACHE_WORKER_READINESS_METRIC = 'cache.worker.readiness';
export const CACHE_WORKER_READINESS_GAUGE = Object.freeze({
  disabled: 0,
  degraded: 1,
  healthy: 2,
} as const);

export interface WorkerCacheCompositionOptions {
  readonly config: CacheConfig;
  /** Existing CDN purge provider; becomes the composite cdn arm when Redis is enabled. */
  readonly cdn?: PublicationCachePurgeProvider;
  readonly metrics?: Metrics;
  /** Cache key environment namespace; worker.ts passes nodeEnv. */
  readonly environment?: string;
  /** T11 test seam: replaces the Redis runtime factory. mode=off must never call it. */
  readonly createStore?: (config: RedisCacheConnectionConfig) => CacheStore;
  /** T11 test seam: pass through to createRedisCacheStore's createClient. */
  readonly createClient?: (url: string, options: RedisClientOptions) => RedisClientLike;
  /** Bounded graceful-close budget (ms) for the Redis runtime. */
  readonly closeTimeoutMs?: number;
}

export interface WorkerCacheComposition {
  readonly mode: CacheMode;
  readonly required: boolean;
  /** The process-local worker Redis store; undefined for mode=off. */
  readonly store?: CacheStore;
  /** Composite provider when shadow/serve; undefined for mode=off. */
  readonly publicationCachePurgeProvider?: PublicationCachePurgeProvider;
  readonly reportCacheInvalidator?: undefined;
  /** Live readiness: disabled (off), healthy, or degraded (store health). */
  readiness(): Promise<CacheReadinessState>;
  /** Bounded, idempotent close; no-op for mode=off. */
  close(): Promise<void>;
}

/**
 * T11 worker cache composition (plan §6.4 T11 / §5).
 *
 * mode=off never creates a Redis client. In shadow/serve modes one worker-owned
 * store backs both publication and report invalidation. `close` is idempotent,
 * and readiness is derived from a live health probe rather than startup state.
 */
export function createWorkerCacheComposition(
  options: WorkerCacheCompositionOptions,
): WorkerCacheComposition {
  const { config, metrics, cdn } = options;
  const mode = config.redis.mode;
  const required = config.redis.required;

  if (mode === 'off') {
    return Object.freeze({
      mode,
      required,
      store: undefined,
      publicationCachePurgeProvider: undefined,
      reportCacheInvalidator: undefined,
      readiness: async (): Promise<CacheReadinessState> => 'disabled',
      close: async (): Promise<void> => undefined,
    });
  }

  const store = options.createStore !== undefined
    ? options.createStore(config.redis)
    : createRedisCacheStore(config.redis, {
        ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
        ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      });
  const invalidator = new RedisPublicationCacheInvalidator({
    store,
    key: {
      environment: options.environment ?? 'default',
      keyPrefix: config.redis.keyPrefix,
    },
    metrics,
  });
  const reportCacheInvalidator = undefined;
  const publicationCachePurgeProvider = new CompositePublicationCachePurgeProvider({
    invalidator,
    ...(cdn === undefined ? {} : { cdn }),
    metrics,
  });

  const readiness = async (): Promise<CacheReadinessState> => {
    let storeHealth: CacheHealthState;
    try {
      storeHealth = await store.health();
    } catch {
      storeHealth = 'degraded';
    }
    return computeCacheReadiness({ mode, circuitState: 'closed', storeHealth });
  };
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= Promise.resolve().then(() => store.close());
    return closePromise;
  };

  return Object.freeze({
    mode,
    required,
    store,
    publicationCachePurgeProvider,
    reportCacheInvalidator,
    readiness,
    close,
  });
}

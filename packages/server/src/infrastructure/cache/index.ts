/**
 * T02/T03/T04/T05 public export surface for the Redis hot-data cache.
 *
 * The T02 files in this module are pure contract code (no Redis client,
 * timers, network or database). T03 adds the Redis runtime adapter
 * (`redis-runtime.ts`): it is the only module in the repo that constructs an
 * ioredis client and it is re-exported here without leaking ioredis types
 * (only structural types such as `RedisClientLike`/`RedisClientOptions`).
 * T04 adds the domain-neutral read-through policy (`read-through-cache.ts`),
 * the in-process singleflight (`cache-singleflight.ts`), the fallback bulkhead
 * (`cache-bulkhead.ts`) and the shared abort classification (`cache-abort.ts`);
 * these are pure coordination code with no Redis client or ioredis types.
 * T05 adds the circuit breaker (`cache-circuit-breaker.ts`), the metrics
 * mapping (`cache-metrics.ts`), the failure/degradation policy assembly
 * (`cache-failure-policy.ts`) and the readiness fact (`cache-readiness.ts`);
 * these use the existing telemetry Metrics/redaction helpers only.
 * Bootstrap composes API/Worker-specific CacheStore instances through
 * `createRedisCacheStore` (T10/T11) and supplies one CacheSingleflight and one
 * CacheBulkhead per process; no global singleton exists.
 */
export * from './cache-guards.js';
export * from './cache-store.js';
export * from './cache-envelope.js';
export * from './cache-key-codec.js';
export * from './collection-bookmark-count-cache-codec.js';
export * from './collection-bookmark-count-cache.js';
export * from './cache-abort.js';
export * from './cache-singleflight.js';
export * from './cache-bulkhead.js';
export * from './read-through-cache.js';
export * from './cache-circuit-breaker.js';
export * from './cache-metrics.js';
export * from './cache-failure-policy.js';
export * from './cache-readiness.js';
export * from './redis-runtime.js';

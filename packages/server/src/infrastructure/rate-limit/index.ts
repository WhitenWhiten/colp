/**
 * P4A-RL03 public export surface for the Attachment distributed rate-limit
 * infrastructure (plan §8 RL03).
 *
 * This is the ONLY production layer that touches the Redis SDK for Attachment
 * admission (plan §2.2.5: independent client, ACL, key namespace, command
 * budget, readiness and fail strategy — never the Publication CacheStore):
 *
 *  - `rate-limit-lua.ts`: the FROZEN, versioned fixed-window script (server
 *    time + atomic INCR + first-write-only PEXPIRE) and its fail-closed reply
 *    parser;
 *  - `rate-limit-client.ts`: the independent bounded ioredis wrapper (command
 *    timeout, bounded reconnect, offline queue off, events never throw, no
 *    global singleton, idempotent close) behind structural types only;
 *  - `rate-limit-circuit-breaker.ts`: the consecutive-failure breaker feeding
 *    the store readiness fact;
 *  - `rate-limit-store.ts`: `createRedisRateLimitStore`, the RL02
 *    `RateLimitStore` adapter — EVALSHA with NOSCRIPT reload/retry, stable
 *    failure classification (unavailable|timeout|malformed|acl|internal,
 *    never `exhausted`), command timeout race, readiness, idempotent close;
 *  - `rate-limit-failure-policy.ts`: the PURE route failure policy —
 *    issue/download fail closed (503), complete runs the bounded in-process
 *    emergency limiter (RL02 `completeEmergency` budget) and reports
 *    fallback/denied verdicts replayable in unit tests (RL04 composes);
 *  - `rate-limit-route-facade.ts`: the RL04 route-facing facade composing the
 *    store + failure policy + local reference into the `off|shadow|enforce`
 *    semantics the three Attachment routes call (metrics/logs stay
 *    fixed-label, plan §2.3).
 *
 * Bootstrap/route composition is wired in RL04 (bootstrap + transport); the
 * module layer only ever sees the RL02 contract types.
 */
export * from './rate-limit-lua.js';
export * from './rate-limit-circuit-breaker.js';
export * from './rate-limit-client.js';
export {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';
export type {
  RedisFixedWindowAdmission,
  RedisFixedWindowDecision,
  RedisFixedWindowReadiness,
  RedisFixedWindowResult,
  RedisFixedWindowStore,
  RedisFixedWindowStoreConfig,
  RedisFixedWindowStoreOptions,
} from './redis-fixed-window-store.js';
export * from './auth-rate-limit-key-codec.js';
export * from './auth-rate-limit-store.js';
export * from './search-rate-limit-key-codec.js';
export * from './search-rate-limit-store.js';
export * from './mcp-rate-limit-key-codec.js';
export * from './mcp-rate-limit-store.js';
export * from './mcp-rate-limit-memory.js';
export * from './email-callback-rate-limit-key-codec.js';
export * from './email-callback-rate-limit-store.js';
export * from './effect-page-rate-limit.js';
export * from './effect-page-rate-limit-key-codec.js';
export * from './effect-page-rate-limit-store.js';
export * from './product-surface-rate-limit-key-codec.js';
export * from './product-surface-rate-limit-store.js';
export * from './publishing-insights-ingest-rate-limit-key-codec.js';
export * from './publishing-insights-ingest-rate-limit-store.js';
export * from './collaboration-invite-rate-limit-key-codec.js';
export * from './collaboration-invite-rate-limit-store.js';
export * from './sync-colp-rate-limit-key-codec.js';
export * from './sync-colp-rate-limit-store.js';
export * from './sync-admission-policy.js';
export * from './sync-admission-key-codec.js';
export * from './sync-admission-redis.js';

/**
 * T02 cache contract: CacheStore port, health state, error categories and the
 * unified cache lookup classification.
 *
 * This file is a pure contract. It never touches Redis, timers, the network or
 * a database and it must run in a plain unit environment. The concrete Redis
 * adapter is implemented by T03.
 */

export type CacheHealthState = 'healthy' | 'degraded';

/**
 * Internal cache error categories. These are stable classifications, never
 * HTTP errors: a Redis miss is a normal miss (not an exception), and a Redis
 * timeout/connection error becomes `cache_unavailable` which the failure
 * policy (T04/T05) converts into a bounded fallback to the authoritative
 * source. Bad cached values become `cache_decode_error` and are treated as a
 * miss plus a counter.
 */
export const CACHE_ERROR_CATEGORY = {
  /** Redis command timeout or connection failure. */
  UNAVAILABLE: 'cache_unavailable',
  /** Invalid envelope, schema mismatch, oversized value or forbidden field. */
  DECODE_ERROR: 'cache_decode_error',
} as const;

export type CacheErrorCategory = (typeof CACHE_ERROR_CATEGORY)[keyof typeof CACHE_ERROR_CATEGORY];

export type CacheLookupKind =
  | 'fresh_hit'
  | 'miss'
  | 'soft_expired'
  | 'decode_error'
  | 'unavailable';

/**
 * Unified result of a cache read for one key. T02 only defines the contract;
 * the domain-neutral read-through policy (T04) produces these values from the
 * CacheStore and the envelope codec. `decode_error` and `unavailable` always
 * carry the stable category so callers never reclassify or rethrow to HTTP.
 */
export type CacheLookupResult<T> =
  | {
      readonly kind: 'fresh_hit';
      readonly value: T;
      readonly writtenAtMs: number;
      readonly hardExpiresAtMs: number;
    }
  | { readonly kind: 'miss' }
  | {
      readonly kind: 'soft_expired';
      readonly value: T;
      readonly softExpiresAtMs: number;
      readonly hardExpiresAtMs: number;
    }
  | { readonly kind: 'decode_error'; readonly category: typeof CACHE_ERROR_CATEGORY.DECODE_ERROR }
  | { readonly kind: 'unavailable'; readonly category: typeof CACHE_ERROR_CATEGORY.UNAVAILABLE };

/**
 * Stable error thrown by CacheStore implementations (T03) when a Redis command
 * fails. The category is always `cache_unavailable`; the caller maps it to a
 * fallback instead of propagating it to HTTP. Cache misses return `null` from
 * `get` and are never an error.
 */
export class CacheStoreError extends Error {
  readonly category: CacheErrorCategory;
  constructor(category: CacheErrorCategory, message: string) {
    super(message);
    this.name = 'CacheStoreError';
    this.category = category;
  }
}

/**
 * Stable cache-layer port. Signatures follow the fixed contract in
 * 12-redis-hot-data-cache-plan.md §6.3. All operations accept an AbortSignal;
 * `health()` reflects current connection state only and is not business
 * readiness (KNOWN_CACHE_REQUIRED semantics arrive in T10/T11). `close()` is
 * bounded and must be safe to call more than once.
 */
export interface CacheStore {
  /** Reads the raw stored string. Redis miss returns null (not an exception). */
  get(key: string, signal: AbortSignal): Promise<string | null>;
  /** Stores a codec-encoded envelope with an absolute hard TTL in milliseconds. */
  set(key: string, encodedValue: string, hardTtlMs: number, signal: AbortSignal): Promise<void>;
  /** Atomic SET NX PX lock acquire; resolves true only for the single owner. */
  setIfAbsent(key: string, token: string, lockTtlMs: number, signal: AbortSignal): Promise<boolean>;
  /** Token-guarded unlock; must compare and delete on the Redis side, never GET-then-DEL. */
  releaseIfOwner(key: string, token: string, signal: AbortSignal): Promise<boolean>;
  /**
   * Atomically INCR + PEXPIRE the epoch key and resolve the new positive
   * integer epoch. The caller never supplies an epoch override value.
   */
  rotateEpoch(key: string, epochTtlMs: number, signal: AbortSignal): Promise<number>;
  /** Current connection state: healthy | degraded. */
  health(signal?: AbortSignal): Promise<CacheHealthState>;
  /** Bounded, idempotent close. Never leaves sockets or timers behind. */
  close(): Promise<void>;
}

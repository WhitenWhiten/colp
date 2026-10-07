/**
 * Product-route and social-surface rate-limit port + Redis adapter.
 *
 * Thin configuration over `createRedisFixedWindowStore`: product-surface
 * purpose, prefix, and HMAC pepper. Denied quota and failed Redis outcomes
 * stay distinct.
 */
import {
  PRODUCT_SURFACE_RATE_LIMIT_DEFAULT_PREFIX,
  PRODUCT_SURFACE_RATE_LIMIT_PURPOSES,
  assertProductSurfaceRateLimitSubject,
  buildProductSurfaceRateLimitKey,
  type ProductSurfaceRateLimitPurpose,
} from './product-surface-rate-limit-key-codec.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';

export interface ProductSurfaceRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export type ProductSurfaceRateLimitFailureClass =
  | 'unavailable'
  | 'timeout'
  | 'malformed'
  | 'acl'
  | 'internal';

export interface ProductSurfaceRateLimitFailure {
  readonly class: ProductSurfaceRateLimitFailureClass;
  readonly code: string;
}

export type ProductSurfaceRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: ProductSurfaceRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: ProductSurfaceRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: ProductSurfaceRateLimitFailure };

export type ProductSurfaceRateLimitReadinessStatus = 'healthy' | 'degraded';
export type ProductSurfaceRateLimitReadinessReason =
  | 'none'
  | 'connecting'
  | 'last_command_failed'
  | 'closed';

export interface ProductSurfaceRateLimitReadiness {
  readonly status: ProductSurfaceRateLimitReadinessStatus;
  readonly reason: ProductSurfaceRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

export interface ProductSurfaceRateLimiter {
  consume(subject: string): Promise<ProductSurfaceRateLimitOutcome>;
  readiness(): ProductSurfaceRateLimitReadiness;
  readonly purpose: ProductSurfaceRateLimitPurpose;
  close(): Promise<void>;
}

export interface RedisProductSurfaceRateLimitStoreOptions {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly purpose: ProductSurfaceRateLimitPurpose;
  readonly keyPrefix?: string;
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly createClient?: RateLimitRedisClientFactory;
  readonly now?: () => number;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly closeTimeoutMs?: number;
}

export function createRedisProductSurfaceRateLimitStore(
  options: RedisProductSurfaceRateLimitStoreOptions,
): ProductSurfaceRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisProductSurfaceRateLimitStore requires a Redis URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisProductSurfaceRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisProductSurfaceRateLimitStore requires a non-empty environment token');
  }
  if (!PRODUCT_SURFACE_RATE_LIMIT_PURPOSES.includes(options.purpose)) {
    throw new Error('createRedisProductSurfaceRateLimitStore requires a sealed product-surface purpose');
  }
  for (const [name, value] of [
    ['maxRequests', options.maxRequests],
    ['windowMs', options.windowMs],
    ['commandTimeoutMs', options.commandTimeoutMs],
    ['connectTimeoutMs', options.connectTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`createRedisProductSurfaceRateLimitStore ${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(options.maxRetriesPerRequest) || options.maxRetriesPerRequest < 0) {
    throw new Error('createRedisProductSurfaceRateLimitStore maxRetriesPerRequest must be a non-negative safe integer');
  }

  const keyPrefix = options.keyPrefix ?? PRODUCT_SURFACE_RATE_LIMIT_DEFAULT_PREFIX[options.purpose];
  const inner = createRedisFixedWindowStore<string>({
    redisUrl: options.redisUrl,
    commandTimeoutMs: options.commandTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
    createClient: options.createClient,
    now: options.now,
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
    closeTimeoutMs: options.closeTimeoutMs,
    resolveAdmission: (subject, nowMs) => {
      assertProductSurfaceRateLimitSubject(subject);
      return {
        key: buildProductSurfaceRateLimitKey({
          keyPrefix,
          environment: options.environment,
          keySecret: options.keySecret,
          purpose: options.purpose,
          subject,
          windowStartEpochMs: Math.floor(nowMs / options.windowMs) * options.windowMs,
        }),
        rateMax: options.maxRequests,
        windowMs: options.windowMs,
      };
    },
  });

  return {
    purpose: options.purpose,
    consume: async (subject) => mapFrozenQuotaOutcome(await inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds })),
    readiness: () => inner.readiness(),
    close: () => inner.close(),
  };
}

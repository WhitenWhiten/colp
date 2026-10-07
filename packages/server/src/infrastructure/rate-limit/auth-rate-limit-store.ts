/**
 * FIX-M-001 auth rate-limit port + Redis adapter.
 *
 * Thin configuration over `createRedisFixedWindowStore`: auth key codec,
 * single budget, and the `consume` port. Denied quota and failed Redis
 * outcomes stay distinct.
 */
import {
  AUTH_RATE_LIMIT_ROUTE_FAMILIES,
  assertAuthRateLimitClientIp,
  buildAuthRateLimitKey,
  type AuthRateLimitRouteFamily,
} from './auth-rate-limit-key-codec.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';

export interface AuthRateLimitSubject {
  readonly routeFamily: AuthRateLimitRouteFamily;
  /** Trusted client IP after proxy resolution (Fastify request.ip). */
  readonly clientIp: string;
}

export interface AuthRateLimitDecision {
  readonly allowed: boolean;
  /** Ceil to the window rollover (seconds); 0 at rollover. */
  readonly retryAfterSeconds: number;
}

export type AuthRateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface AuthRateLimitFailure {
  readonly class: AuthRateLimitFailureClass;
  readonly code: string;
}

export type AuthRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: AuthRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: AuthRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: AuthRateLimitFailure };

export type AuthRateLimitReadinessStatus = 'healthy' | 'degraded';
export type AuthRateLimitReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface AuthRateLimitReadiness {
  readonly status: AuthRateLimitReadinessStatus;
  readonly reason: AuthRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

export interface AuthRateLimiter {
  consume(subject: AuthRateLimitSubject): Promise<AuthRateLimitOutcome>;
  readiness(): AuthRateLimitReadiness;
  close(): Promise<void>;
}

export interface RedisAuthRateLimitStoreOptions {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
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

export function createRedisAuthRateLimitStore(options: RedisAuthRateLimitStoreOptions): AuthRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisAuthRateLimitStore requires AUTH_RATE_LIMIT_REDIS_URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisAuthRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisAuthRateLimitStore requires a non-empty environment token');
  }
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1) {
    throw new Error('createRedisAuthRateLimitStore maxRequests must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new Error('createRedisAuthRateLimitStore windowMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 1) {
    throw new Error('createRedisAuthRateLimitStore commandTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1) {
    throw new Error('createRedisAuthRateLimitStore connectTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxRetriesPerRequest) || options.maxRetriesPerRequest < 0) {
    throw new Error('createRedisAuthRateLimitStore maxRetriesPerRequest must be a non-negative safe integer');
  }

  const inner = createRedisFixedWindowStore<AuthRateLimitSubject>({
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
      if (!AUTH_RATE_LIMIT_ROUTE_FAMILIES.includes(subject.routeFamily)) {
        throw new RangeError('unknown auth rate-limit route family');
      }
      assertAuthRateLimitClientIp(subject.clientIp);
      return {
        key: buildAuthRateLimitKey({
          keyPrefix: options.keyPrefix,
          environment: options.environment,
          keySecret: options.keySecret,
          routeFamily: subject.routeFamily,
          clientIp: subject.clientIp,
          windowStartEpochMs: Math.floor(nowMs / options.windowMs) * options.windowMs,
        }),
        rateMax: options.maxRequests,
        windowMs: options.windowMs,
      };
    },
  });

  return {
    consume: async (subject) => mapFrozenQuotaOutcome(await inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds })),
    readiness: () => inner.readiness(),
    close: () => inner.close(),
  };
}

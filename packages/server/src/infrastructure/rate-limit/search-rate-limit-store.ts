/**
 * FIX-M-006 Search rate-limit port + Redis adapter (PUB-R03).
 *
 * Thin configuration over `createRedisFixedWindowStore`: search key codec and
 * independent anonymous/account budgets. Denied quota and failed Redis
 * outcomes stay distinct.
 */
import {
  SEARCH_RATE_LIMIT_ROUTE_FAMILIES,
  assertSearchRateLimitSubject,
  buildSearchRateLimitKey,
  type SearchRateLimitRouteFamily,
} from './search-rate-limit-key-codec.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';

export interface SearchRateLimitSubject {
  readonly family: SearchRateLimitRouteFamily;
  readonly subject: string;
}

export interface SearchRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export type SearchRateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface SearchRateLimitFailure {
  readonly class: SearchRateLimitFailureClass;
  readonly code: string;
}

export type SearchRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: SearchRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: SearchRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: SearchRateLimitFailure };

export type SearchRateLimitReadinessStatus = 'healthy' | 'degraded';
export type SearchRateLimitReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface SearchRateLimitReadiness {
  readonly status: SearchRateLimitReadinessStatus;
  readonly reason: SearchRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

export interface SearchRateLimiter {
  consume(subject: SearchRateLimitSubject): Promise<SearchRateLimitOutcome>;
  readiness(): SearchRateLimitReadiness;
  readonly policy: Readonly<Record<SearchRateLimitRouteFamily, string>>;
  close(): Promise<void>;
}

export interface RedisSearchRateLimitStoreOptions {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly keyPrefix?: string;
  readonly anonymousMaxRequests: number;
  readonly accountMaxRequests: number;
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

export function createRedisSearchRateLimitStore(options: RedisSearchRateLimitStoreOptions): SearchRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisSearchRateLimitStore requires SEARCH_RATE_LIMIT_REDIS_URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisSearchRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisSearchRateLimitStore requires a non-empty environment token');
  }
  if (!Number.isSafeInteger(options.anonymousMaxRequests) || options.anonymousMaxRequests < 1) {
    throw new Error('createRedisSearchRateLimitStore anonymousMaxRequests must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.accountMaxRequests) || options.accountMaxRequests < 1) {
    throw new Error('createRedisSearchRateLimitStore accountMaxRequests must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new Error('createRedisSearchRateLimitStore windowMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.commandTimeoutMs) || options.commandTimeoutMs < 1) {
    throw new Error('createRedisSearchRateLimitStore commandTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs < 1) {
    throw new Error('createRedisSearchRateLimitStore connectTimeoutMs must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxRetriesPerRequest) || options.maxRetriesPerRequest < 0) {
    throw new Error('createRedisSearchRateLimitStore maxRetriesPerRequest must be a non-negative safe integer');
  }

  const inner = createRedisFixedWindowStore<SearchRateLimitSubject>({
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
      if (!SEARCH_RATE_LIMIT_ROUTE_FAMILIES.includes(subject.family)) {
        throw new RangeError('unknown search rate-limit family');
      }
      assertSearchRateLimitSubject(subject.subject);
      const rateMax = subject.family === 'anonymous'
        ? options.anonymousMaxRequests
        : options.accountMaxRequests;
      return {
        key: buildSearchRateLimitKey({
          keyPrefix: options.keyPrefix,
          environment: options.environment,
          keySecret: options.keySecret,
          family: subject.family,
          subject: subject.subject,
          windowStartEpochMs: Math.floor(nowMs / options.windowMs) * options.windowMs,
        }),
        rateMax,
        windowMs: options.windowMs,
      };
    },
  });

  return {
    policy: Object.freeze({
      anonymous: `search:anonymous:${options.anonymousMaxRequests}:${options.windowMs}`,
      account: `search:account:${options.accountMaxRequests}:${options.windowMs}`,
    }),
    consume: async (subject) => mapFrozenQuotaOutcome(await inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds })),
    readiness: () => inner.readiness(),
    close: () => inner.close(),
  };
}

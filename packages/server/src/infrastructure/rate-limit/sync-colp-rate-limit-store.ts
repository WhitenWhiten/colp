/**
 * P-09 Sync COLP push/pull rate-limit port + Redis adapter.
 *
 * Thin configuration over `createRedisFixedWindowStore`: sync key codec and
 * independent push/pull budgets. Denied quota and failed Redis outcomes stay
 * distinct.
 */
import {
  SYNC_COLP_RATE_LIMIT_ROUTE_FAMILIES,
  assertSyncColpRateLimitSubject,
  buildSyncColpRateLimitKey,
  type SyncColpRateLimitRouteFamily,
} from './sync-colp-rate-limit-key-codec.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';

export interface SyncColpRateLimitSubject {
  readonly family: SyncColpRateLimitRouteFamily;
  readonly clientIp: string;
}

export interface SyncColpRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export type SyncColpRateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface SyncColpRateLimitFailure {
  readonly class: SyncColpRateLimitFailureClass;
  readonly code: string;
}

export type SyncColpRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: SyncColpRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: SyncColpRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: SyncColpRateLimitFailure };

export type SyncColpRateLimitReadinessStatus = 'healthy' | 'degraded';
export type SyncColpRateLimitReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface SyncColpRateLimitReadiness {
  readonly status: SyncColpRateLimitReadinessStatus;
  readonly reason: SyncColpRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

export interface SyncColpRateLimiter {
  consume(subject: SyncColpRateLimitSubject): Promise<SyncColpRateLimitOutcome>;
  readiness(): SyncColpRateLimitReadiness;
  readonly policy: Readonly<Record<SyncColpRateLimitRouteFamily, string>>;
  close(): Promise<void>;
}

export interface RedisSyncColpRateLimitStoreOptions {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly keyPrefix?: string;
  readonly pushMaxRequests: number;
  readonly pushWindowMs: number;
  readonly pullMaxRequests: number;
  readonly pullWindowMs: number;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly createClient?: RateLimitRedisClientFactory;
  readonly now?: () => number;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly closeTimeoutMs?: number;
}

export function createRedisSyncColpRateLimitStore(
  options: RedisSyncColpRateLimitStoreOptions,
): SyncColpRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisSyncColpRateLimitStore requires SYNC_RATE_LIMIT_REDIS_URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisSyncColpRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisSyncColpRateLimitStore requires a non-empty environment token');
  }
  for (const [name, value] of [
    ['pushMaxRequests', options.pushMaxRequests],
    ['pushWindowMs', options.pushWindowMs],
    ['pullMaxRequests', options.pullMaxRequests],
    ['pullWindowMs', options.pullWindowMs],
    ['commandTimeoutMs', options.commandTimeoutMs],
    ['connectTimeoutMs', options.connectTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`createRedisSyncColpRateLimitStore ${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(options.maxRetriesPerRequest) || options.maxRetriesPerRequest < 0) {
    throw new Error('createRedisSyncColpRateLimitStore maxRetriesPerRequest must be a non-negative safe integer');
  }

  const inner = createRedisFixedWindowStore<SyncColpRateLimitSubject>({
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
      if (!SYNC_COLP_RATE_LIMIT_ROUTE_FAMILIES.includes(subject.family)) {
        throw new RangeError('unknown sync rate-limit family');
      }
      assertSyncColpRateLimitSubject(subject.clientIp);
      const rateMax = subject.family === 'push' ? options.pushMaxRequests : options.pullMaxRequests;
      const windowMs = subject.family === 'push' ? options.pushWindowMs : options.pullWindowMs;
      return {
        key: buildSyncColpRateLimitKey({
          ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
          environment: options.environment,
          keySecret: options.keySecret,
          family: subject.family,
          subject: subject.clientIp,
          windowStartEpochMs: Math.floor(nowMs / windowMs) * windowMs,
        }),
        rateMax,
        windowMs,
      };
    },
  });

  return {
    policy: Object.freeze({
      push: `sync:push:${options.pushMaxRequests}:${options.pushWindowMs}`,
      pull: `sync:pull:${options.pullMaxRequests}:${options.pullWindowMs}`,
    }),
    consume: async (subject) => mapFrozenQuotaOutcome(await inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds })),
    readiness: () => inner.readiness(),
    close: () => inner.close(),
  };
}

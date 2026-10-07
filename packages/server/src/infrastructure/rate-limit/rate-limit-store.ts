/**
 * P4A-RL03 Redis adapter for the RL02 `RateLimitStore` port (plan §8 RL03).
 *
 * Thin configuration over `createRedisFixedWindowStore`: Attachment key codec,
 * route budgets, and the RL02 `check` port. The shared factory owns EVALSHA,
 * NOSCRIPT reload, the command-timeout race, the circuit breaker, and
 * fail-closed classification (`denied` vs `failed` are never conflated).
 */
import type {
  AttachmentRateLimitConfig,
  RateLimitCheckInput,
  RateLimitStore,
  RateLimitStoreOutcome,
  RateLimitStoreReadiness,
} from '../../modules/attachments/index.js';
import {
  assertAttachmentRateLimitConfig,
  buildAttachmentRateLimitKey,
  resolveRouteRatePolicy,
  windowStartFor,
} from '../../modules/attachments/index.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  type RedisFixedWindowResult,
} from './redis-fixed-window-store.js';

export {
  RateLimitCommandTimeoutError,
  RateLimitMalformedReplyError,
  classifyRateLimitError,
} from './redis-fixed-window-store.js';
export type {
  ClassifiedRateLimitError,
  RateLimitFailureClass,
} from './redis-fixed-window-store.js';

export interface RedisRateLimitStoreOptions {
  /** Full RL02 config; validated fail-closed inside the factory. */
  readonly config: AttachmentRateLimitConfig;
  /** Deployment environment token for the key codec (1-64 chars, no colon). */
  readonly environment: string;
  /** Resolved HMAC secret bytes (never logged, never serialized). */
  readonly keySecret: Buffer;
  /** Test seam: replace the real ioredis client with a scripted fake. */
  readonly createClient?: RateLimitRedisClientFactory;
  /**
   * Injectable host clock; used ONLY as the codec window seed and readiness
   * timestamps — the authoritative window identity comes from Redis server
   * time inside the Lua script (plan §2.3).
   */
  readonly now?: () => number;
  /** Circuit breaker: consecutive failures that open it (default 3). */
  readonly failureThreshold?: number;
  /** Circuit breaker: cooldown before a half-open probe (default 1000ms). */
  readonly cooldownMs?: number;
  /** Graceful-close budget (default RATE_LIMIT_REDIS_CLOSE_TIMEOUT_MS). */
  readonly closeTimeoutMs?: number;
}

export function createRedisRateLimitStore(options: RedisRateLimitStoreOptions): RateLimitStore {
  assertAttachmentRateLimitConfig(options.config);
  if (options.config.mode === 'off') {
    throw new Error('createRedisRateLimitStore refuses ATTACHMENTS_RATE_LIMIT_MODE=off (off must not create a Redis client)');
  }
  if (options.config.redisUrl === null) {
    throw new Error('createRedisRateLimitStore requires ATTACHMENTS_RATE_LIMIT_REDIS_URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisRateLimitStore requires a non-empty environment token');
  }

  const inner = createRedisFixedWindowStore<RateLimitCheckInput>({
    redisUrl: options.config.redisUrl,
    commandTimeoutMs: options.config.commandTimeoutMs,
    connectTimeoutMs: options.config.connectTimeoutMs,
    maxRetriesPerRequest: options.config.maxRetriesPerRequest,
    createClient: options.createClient,
    now: options.now,
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
    closeTimeoutMs: options.closeTimeoutMs,
    resolveAdmission: (input, nowMs) => {
      const policy = resolveRouteRatePolicy(options.config, input.routeClass);
      const seedWindow = windowStartFor(input.nowEpochMs ?? nowMs, policy.rateWindowMs);
      return {
        key: buildAttachmentRateLimitKey({
          keyPrefix: options.config.keyPrefix,
          environment: options.environment,
          keySecret: options.keySecret,
          routeClass: input.routeClass,
          subject: input.subject,
          windowStartEpochMs: seedWindow,
        }),
        rateMax: policy.rateMax,
        windowMs: policy.rateWindowMs,
      };
    },
  });

  return {
    check: (input) => mapAttachmentOutcome(inner.consume(input)),
    readiness: () => inner.readiness() as RateLimitStoreReadiness,
    close: () => inner.close(),
  };
}

async function mapAttachmentOutcome(pending: Promise<RedisFixedWindowResult>): Promise<RateLimitStoreOutcome> {
  const result = await pending;
  if (result.kind === 'failed') {
    return Object.freeze({ kind: 'failed', failure: Object.freeze(result.failure) });
  }
  const decision = Object.freeze({
    allowed: result.decision.allowed,
    remaining: result.decision.remaining,
    retryAfterSeconds: result.decision.retryAfterSeconds,
    windowStartEpochMs: result.decision.windowStartEpochMs,
  });
  return result.kind === 'allowed'
    ? Object.freeze({ kind: 'allowed', decision })
    : Object.freeze({ kind: 'denied', decision });
}

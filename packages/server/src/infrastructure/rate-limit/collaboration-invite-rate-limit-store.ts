/**
 * Collaboration invite rate-limit port (S-04).
 *
 * Family `collaboration-invite` is independent from auth/search/insights
 * purpose strings. Quota identity is HMAC'd with a dedicated pepper before
 * it reaches Redis or the in-memory map. Fail-closed: quota denial is 429;
 * store failure (including memory maxBuckets exhaustion) is 503 without a
 * fabricated Retry-After. Authenticated writes never fail open.
 */
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
  type RedisFixedWindowStore,
} from './redis-fixed-window-store.js';
import {
  COLLABORATION_ACCEPT_DECLINE_LIMIT,
  COLLABORATION_ACCEPT_DECLINE_WINDOW_MS,
  COLLABORATION_INVITE_POST_LIMIT,
  COLLABORATION_INVITE_POST_WINDOW_MS,
  COLLABORATION_INVITE_RATE_LIMIT_FAMILY,
  buildCollaborationInviteRateLimitKey,
  type CollaborationInviteRateLimitAction,
} from './collaboration-invite-rate-limit-key-codec.js';

export interface CollaborationInviteRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export type CollaborationInviteRateLimitFailureClass =
  | 'unavailable'
  | 'timeout'
  | 'malformed'
  | 'acl'
  | 'internal';

export interface CollaborationInviteRateLimitFailure {
  readonly class: CollaborationInviteRateLimitFailureClass;
  readonly code: string;
}

export type CollaborationInviteRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: CollaborationInviteRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: CollaborationInviteRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: CollaborationInviteRateLimitFailure };

export interface CollaborationInviteRateLimiter {
  consumeInvite(principalId: string): Promise<CollaborationInviteRateLimitOutcome>;
  consumeAcceptOrDecline(principalId: string): Promise<CollaborationInviteRateLimitOutcome>;
  readiness(): { readonly status: 'healthy' | 'degraded'; readonly reason: string };
  readonly policy: Readonly<{ readonly [COLLABORATION_INVITE_RATE_LIMIT_FAMILY]: string }>;
  close(): Promise<void>;
}

export interface MemoryCollaborationInviteRateLimiterOptions {
  readonly environment?: string;
  readonly keySecret: Buffer;
  readonly now?: () => number;
  readonly inviteLimit?: number;
  readonly acceptLimit?: number;
  /**
   * Hard cap on tracked buckets (default 100_000). At capacity a request
   * for a NEW subject returns `failed` (503) rather than silently
   * allocating another bucket.
   */
  readonly maxBuckets?: number;
  /** Minimum interval between TTL sweeps (default 60s). */
  readonly sweepIntervalMs?: number;
}

export interface MemoryCollaborationInviteRateLimiter extends CollaborationInviteRateLimiter {
  reset(): void;
  size(): number;
}

const DEFAULT_MEMORY_MAX_BUCKETS = 100_000;
const DEFAULT_MEMORY_SWEEP_INTERVAL_MS = 60_000;

export function createMemoryCollaborationInviteRateLimiter(
  options: MemoryCollaborationInviteRateLimiterOptions,
): MemoryCollaborationInviteRateLimiter {
  const environment = options.environment ?? 'test';
  const now = options.now ?? Date.now;
  const inviteLimit = options.inviteLimit ?? COLLABORATION_INVITE_POST_LIMIT;
  const acceptLimit = options.acceptLimit ?? COLLABORATION_ACCEPT_DECLINE_LIMIT;
  const maxBuckets = options.maxBuckets ?? DEFAULT_MEMORY_MAX_BUCKETS;
  if (!Number.isSafeInteger(maxBuckets) || maxBuckets < 1) {
    throw new Error('collaboration-invite memory rate limiter maxBuckets must be a positive safe integer');
  }
  const sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_MEMORY_SWEEP_INTERVAL_MS;
  if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 1) {
    throw new Error('collaboration-invite memory rate limiter sweepIntervalMs must be a positive safe integer');
  }
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweepAt = now();

  const consume = (
    principalId: string,
    action: CollaborationInviteRateLimitAction,
    maxRequests: number,
    windowMs: number,
  ): CollaborationInviteRateLimitOutcome => {
    const t = now();
    if (t - lastSweepAt >= sweepIntervalMs) {
      lastSweepAt = t;
      for (const [bucketKey, existing] of buckets) {
        if (t >= existing.resetAt) buckets.delete(bucketKey);
      }
    }
    const windowStartEpochMs = Math.floor(t / windowMs) * windowMs;
    const key = buildCollaborationInviteRateLimitKey({
      environment,
      keySecret: options.keySecret,
      principalId,
      action,
      windowStartEpochMs,
    });
    let bucket = buckets.get(key);
    if (!bucket || t >= bucket.resetAt) {
      if (!bucket && buckets.size >= maxBuckets) {
        return {
          kind: 'failed',
          failure: { class: 'unavailable', code: 'rate_limit_capacity_exhausted' },
        };
      }
      bucket = { count: 0, resetAt: windowStartEpochMs + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= maxRequests) {
      return {
        kind: 'denied',
        decision: {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)),
        },
      };
    }
    bucket.count += 1;
    return { kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0 } };
  };

  return {
    async consumeInvite(principalId) {
      return consume(principalId, 'invite', inviteLimit, COLLABORATION_INVITE_POST_WINDOW_MS);
    },
    async consumeAcceptOrDecline(principalId) {
      return consume(principalId, 'accept-or-decline', acceptLimit, COLLABORATION_ACCEPT_DECLINE_WINDOW_MS);
    },
    readiness() {
      return { status: 'healthy', reason: 'none' };
    },
    async close() {},
    reset() {
      buckets.clear();
      lastSweepAt = now();
    },
    size() {
      return buckets.size;
    },
    policy: Object.freeze({
      [COLLABORATION_INVITE_RATE_LIMIT_FAMILY]:
        `collaboration-invite:1:${COLLABORATION_INVITE_POST_LIMIT}/${COLLABORATION_ACCEPT_DECLINE_LIMIT}`,
    }),
  };
}

export interface RedisCollaborationInviteRateLimitStoreOptions {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly keyPrefix?: string;
  readonly inviteLimit?: number;
  readonly acceptLimit?: number;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly createClient?: RateLimitRedisClientFactory;
  readonly now?: () => number;
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly closeTimeoutMs?: number;
}

interface CollaborationInviteAdmission {
  readonly principalId: string;
  readonly action: CollaborationInviteRateLimitAction;
}

export function createRedisCollaborationInviteRateLimitStore(
  options: RedisCollaborationInviteRateLimitStoreOptions,
): CollaborationInviteRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisCollaborationInviteRateLimitStore requires a redis URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisCollaborationInviteRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisCollaborationInviteRateLimitStore requires a non-empty environment token');
  }
  return new RedisCollaborationInviteRateLimitStore(options);
}

class RedisCollaborationInviteRateLimitStore implements CollaborationInviteRateLimiter {
  readonly policy: Readonly<{ readonly [COLLABORATION_INVITE_RATE_LIMIT_FAMILY]: string }>;
  private readonly inner: RedisFixedWindowStore<CollaborationInviteAdmission>;

  constructor(options: RedisCollaborationInviteRateLimitStoreOptions) {
    const inviteLimit = options.inviteLimit ?? COLLABORATION_INVITE_POST_LIMIT;
    const acceptLimit = options.acceptLimit ?? COLLABORATION_ACCEPT_DECLINE_LIMIT;
    this.policy = Object.freeze({
      [COLLABORATION_INVITE_RATE_LIMIT_FAMILY]:
        `collaboration-invite:1:${COLLABORATION_INVITE_POST_LIMIT}/${COLLABORATION_ACCEPT_DECLINE_LIMIT}`,
    });
    this.inner = createRedisFixedWindowStore<CollaborationInviteAdmission>({
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
        const windowMs = subject.action === 'invite'
          ? COLLABORATION_INVITE_POST_WINDOW_MS
          : COLLABORATION_ACCEPT_DECLINE_WINDOW_MS;
        return {
          key: buildCollaborationInviteRateLimitKey({
            ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
            environment: options.environment,
            keySecret: options.keySecret,
            principalId: subject.principalId,
            action: subject.action,
            windowStartEpochMs: Math.floor(nowMs / windowMs) * windowMs,
          }),
          rateMax: subject.action === 'invite' ? inviteLimit : acceptLimit,
          windowMs,
        };
      },
    });
  }

  consumeInvite(principalId: string): Promise<CollaborationInviteRateLimitOutcome> {
    return this.mapConsume({ principalId, action: 'invite' });
  }

  consumeAcceptOrDecline(principalId: string): Promise<CollaborationInviteRateLimitOutcome> {
    return this.mapConsume({ principalId, action: 'accept-or-decline' });
  }

  private async mapConsume(
    subject: CollaborationInviteAdmission,
  ): Promise<CollaborationInviteRateLimitOutcome> {
    return mapFrozenQuotaOutcome(await this.inner.consume(subject), (decision) =>
      Object.freeze({ allowed: decision.allowed, retryAfterSeconds: decision.retryAfterSeconds }));
  }

  readiness() {
    const snapshot = this.inner.readiness();
    return { status: snapshot.status, reason: snapshot.reason };
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

export interface ComposeCollaborationInviteRateLimiterOptions {
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly shared: {
    readonly enabled: boolean;
    readonly redisUrl: string | null;
    readonly keyPrefix: string;
    readonly commandTimeoutMs: number;
    readonly connectTimeoutMs: number;
    readonly maxRetriesPerRequest: number;
  };
  readonly createClient?: RateLimitRedisClientFactory;
}

/**
 * Production composition for the collaboration-invite limiter. Shared flag
 * true constructs the Redis adapter (HMAC pepper is the caller-supplied
 * collaboration-invite secret, never auth/search/insights peppers). Shared
 * flag false keeps the bounded in-process map (test / explicit single-process).
 */
export function composeCollaborationInviteRateLimiter(
  options: ComposeCollaborationInviteRateLimiterOptions,
): CollaborationInviteRateLimiter {
  if (!options.shared.enabled) {
    return createMemoryCollaborationInviteRateLimiter({
      keySecret: options.keySecret,
      environment: options.environment,
    });
  }
  if (options.shared.redisUrl === null || options.shared.redisUrl.length === 0) {
    throw new Error(
      'API composition refused: COLLABORATION_INVITE_RATE_LIMIT_SHARED=true requires COLLABORATION_INVITE_RATE_LIMIT_REDIS_URL',
    );
  }
  return createRedisCollaborationInviteRateLimitStore({
    redisUrl: options.shared.redisUrl,
    environment: options.environment,
    keySecret: options.keySecret,
    keyPrefix: options.shared.keyPrefix,
    commandTimeoutMs: options.shared.commandTimeoutMs,
    connectTimeoutMs: options.shared.connectTimeoutMs,
    maxRetriesPerRequest: options.shared.maxRetriesPerRequest,
    ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
  });
}

import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';
import { buildSyncAdmissionKey } from './sync-admission-key-codec.js';
import {
  SYNC_ADMISSION_PURPOSES,
  type SyncAdmissionBudgets,
  type SyncAdmissionPolicy,
  type SyncAdmissionPurpose,
} from './sync-admission-policy.js';

export function createRedisSyncAdmissionPolicy(options: {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly keyPrefix?: string;
  readonly budgets: SyncAdmissionBudgets;
  readonly commandTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxRetriesPerRequest: number;
  readonly createClient?: RateLimitRedisClientFactory;
  readonly now?: () => number;
}): SyncAdmissionPolicy {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisSyncAdmissionPolicy requires a Redis URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisSyncAdmissionPolicy requires a non-empty HMAC key secret');
  }
  const inner = createRedisFixedWindowStore<{
    readonly purpose: SyncAdmissionPurpose;
    readonly lane: 'preauth' | 'subject';
    readonly identity: string;
  }>({
    redisUrl: options.redisUrl,
    commandTimeoutMs: options.commandTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
    createClient: options.createClient,
    now: options.now,
    resolveAdmission: (subject, nowMs) => {
      if (!SYNC_ADMISSION_PURPOSES.includes(subject.purpose)) {
        throw new RangeError('unknown sync admission purpose');
      }
      const budget = options.budgets[subject.purpose];
      if (budget === undefined) {
        throw new RangeError(`sync admission budget missing for ${subject.purpose}`);
      }
      return {
        key: buildSyncAdmissionKey({
          ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
          environment: options.environment,
          keySecret: options.keySecret,
          purpose: subject.purpose,
          subject: `${subject.lane}:${subject.identity}`,
          windowStartEpochMs: Math.floor(nowMs / budget.windowMs) * budget.windowMs,
        }),
        rateMax: budget.maxRequests,
        windowMs: budget.windowMs,
      };
    },
  });
  const consume = async (
    purpose: SyncAdmissionPurpose,
    lane: 'preauth' | 'subject',
    identity: string,
  ) => {
    const outcome = mapFrozenQuotaOutcome(
      await inner.consume({ purpose, lane, identity }),
      (decision) => Object.freeze({
        allowed: decision.allowed,
        retryAfterSeconds: decision.retryAfterSeconds,
      }),
    );
    if (outcome.kind === 'failed') {
      return { kind: 'failed' as const, reason: 'limiter_unavailable' as const };
    }
    return {
      kind: outcome.kind === 'denied' ? 'denied' as const : 'allowed' as const,
      retryAfterSeconds: outcome.decision.retryAfterSeconds,
    };
  };
  return {
    admitPreAuth: (input) => consume(input.purpose, 'preauth', input.clientKey),
    admitSubject: (input) => consume(input.purpose, 'subject', input.subjectKey),
    readiness: () => {
      const snap = inner.readiness();
      return { status: snap.status, reason: snap.reason };
    },
    close: () => inner.close(),
  };
}

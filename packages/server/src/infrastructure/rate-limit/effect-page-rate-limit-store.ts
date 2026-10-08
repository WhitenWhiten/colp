/**
 * PERIPH-P1-c Redis adapter for the Sync effect-page rate-limit port.
 *
 * Sequential subject-then-effect consume matches the in-process memory
 * adapter. The Redis loop itself is `createRedisFixedWindowStore`.
 */
import {
  EFFECT_PAGE_RATE_LIMIT_DEFAULT_PREFIX,
  EFFECT_PAGE_RATE_LIMIT_ROUTE_FAMILIES,
  buildEffectPageRateLimitKey,
  effectPageRateLimitEffectFacts,
  effectPageRateLimitSubjectFacts,
  type EffectPageRateLimitRouteFamily,
} from './effect-page-rate-limit-key-codec.js';
import type {
  EffectPageRateLimitOutcome,
  EffectPageRateLimitReadiness,
  EffectPageRateLimitSubject,
  EffectPageRateLimiter,
} from './effect-page-rate-limit.js';
import type { RateLimitRedisClientFactory } from './rate-limit-client.js';
import {
  createRedisFixedWindowStore,
  mapFrozenQuotaOutcome,
} from './redis-fixed-window-store.js';

export interface RedisEffectPageRateLimitStoreOptions {
  readonly redisUrl: string;
  readonly environment: string;
  readonly keySecret: Buffer;
  readonly keyPrefix?: string;
  readonly subjectMaxRequests: number;
  readonly effectMaxRequests: number;
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

interface EffectPageAdmission {
  readonly family: EffectPageRateLimitRouteFamily;
  readonly facts: string;
  readonly rateMax: number;
}

export function createRedisEffectPageRateLimitStore(
  options: RedisEffectPageRateLimitStoreOptions,
): EffectPageRateLimiter {
  if (typeof options.redisUrl !== 'string' || options.redisUrl.length === 0) {
    throw new Error('createRedisEffectPageRateLimitStore requires a Redis URL');
  }
  if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length === 0) {
    throw new Error('createRedisEffectPageRateLimitStore requires a non-empty HMAC key secret buffer');
  }
  if (typeof options.environment !== 'string' || options.environment.length === 0) {
    throw new Error('createRedisEffectPageRateLimitStore requires a non-empty environment token');
  }
  for (const [name, value] of [
    ['subjectMaxRequests', options.subjectMaxRequests],
    ['effectMaxRequests', options.effectMaxRequests],
    ['windowMs', options.windowMs],
    ['commandTimeoutMs', options.commandTimeoutMs],
    ['connectTimeoutMs', options.connectTimeoutMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`createRedisEffectPageRateLimitStore ${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(options.maxRetriesPerRequest) || options.maxRetriesPerRequest < 0) {
    throw new Error('createRedisEffectPageRateLimitStore maxRetriesPerRequest must be a non-negative safe integer');
  }

  const keyPrefix = options.keyPrefix ?? EFFECT_PAGE_RATE_LIMIT_DEFAULT_PREFIX;
  const inner = createRedisFixedWindowStore<EffectPageAdmission>({
    redisUrl: options.redisUrl,
    commandTimeoutMs: options.commandTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
    createClient: options.createClient,
    now: options.now,
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
    closeTimeoutMs: options.closeTimeoutMs,
    resolveAdmission: (admission, nowMs) => {
      if (!EFFECT_PAGE_RATE_LIMIT_ROUTE_FAMILIES.includes(admission.family)) {
        throw new RangeError('unknown effect-page rate-limit family');
      }
      return {
        key: buildEffectPageRateLimitKey({
          keyPrefix,
          environment: options.environment,
          keySecret: options.keySecret,
          family: admission.family,
          facts: admission.facts,
          windowStartEpochMs: Math.floor(nowMs / options.windowMs) * options.windowMs,
        }),
        rateMax: admission.rateMax,
        windowMs: options.windowMs,
      };
    },
  });

  const consumeFamily = async (
    family: EffectPageRateLimitRouteFamily,
    facts: string,
    rateMax: number,
  ): Promise<EffectPageRateLimitOutcome> => {
    const result = await inner.consume({ family, facts, rateMax });
    return mapFrozenQuotaOutcome(result, (decision) => Object.freeze({
      allowed: decision.allowed,
      retryAfterSeconds: decision.retryAfterSeconds,
      family,
    }));
  };

  return {
    async consume(subject: EffectPageRateLimitSubject): Promise<EffectPageRateLimitOutcome> {
      const subjectOutcome = await consumeFamily(
        'subject',
        effectPageRateLimitSubjectFacts(subject),
        options.subjectMaxRequests,
      );
      if (subjectOutcome.kind !== 'allowed') {
        if (subjectOutcome.kind === 'denied') {
          return Object.freeze({
            kind: 'denied',
            decision: Object.freeze({
              allowed: false,
              retryAfterSeconds: subjectOutcome.decision.retryAfterSeconds,
              family: 'subject' as const,
            }),
          });
        }
        return subjectOutcome;
      }
      const effectOutcome = await consumeFamily(
        'effect',
        effectPageRateLimitEffectFacts(subject),
        options.effectMaxRequests,
      );
      if (effectOutcome.kind === 'denied') {
        return Object.freeze({
          kind: 'denied',
          decision: Object.freeze({
            allowed: false,
            retryAfterSeconds: effectOutcome.decision.retryAfterSeconds,
            family: 'effect' as const,
          }),
        });
      }
      if (effectOutcome.kind === 'failed') return effectOutcome;
      return Object.freeze({
        kind: 'allowed',
        decision: Object.freeze({
          allowed: true,
          retryAfterSeconds: 0,
          family: 'subject' as const,
        }),
      });
    },
    readiness: () => inner.readiness() as EffectPageRateLimitReadiness,
    close: () => inner.close(),
  };
}

/**
 * P4A-RL04 API rate-limit composition (plan §2.2.5/§2.2.6, §8 RL04, §13.1).
 *
 * Production wiring for the distributed Attachment admission limiter in the
 * API process:
 *
 *  - `mode=off` creates NO Redis client and never resolves the HMAC key
 *    secret (zero Redis connections, plan §13.1 step 1); the bounded local
 *    reference behavior (I10 semantics) stays active through the facade's
 *    local limiter;
 *  - `shadow`/`enforce` resolve the HMAC key secret by its opaque reference,
 *    create ONE `RateLimitStore` (shared by every Attachment route, plan
 *    §2.2.5: independent client/ACL/key namespace, never the Publication
 *    cache) and ONE route facade that owns the mode semantics;
 *  - the fixed-label decision metrics go through the production
 *    `AttachmentMetricsStore` (sealed `rateLimitDecision` dimension, plan
 *    §13.2) and `shadow_mismatch` through the optional infrastructure
 *    counter (same pattern as `cache.shadow.digest_mismatch`);
 *  - readiness exposes the RL02 policy verdict: only `enforce + required`
 *    with a degraded store blocks the attachments capability; shadow and
 *    optional enforce degrade without blocking (plan §13.1 step 3/4);
 *  - `close()` is bounded and idempotent and the API onClose flow calls it
 *    (graceful close, plan §8 RL04);
 *  - the I10 local reference limiter for the download route is owned HERE
 *    (default production policy; injectable for deterministic tests) and the
 *    same instance is NOT passed into the use case — the facade consumes
 *    exactly one local attempt per request, so the download composition
 *    passes a permissive limiter to `authorizeOwnerDownload`.
 *
 * Config reload is NOT a runtime operation: `ATTACHMENTS_RATE_LIMIT_*` is
 * parsed once in `loadConfig`; changing the mode/budgets requires an API
 * restart (rollback = `ATTACHMENTS_RATE_LIMIT_MODE=off` + restart, plan
 * §13.3; counters wait for their natural TTL — no FLUSHDB).
 */
import type { Metrics } from '../infrastructure/telemetry/index.js';
import {
  createAttachmentRouteRateLimitFacade,
  createRedisRateLimitStore,
  type RateLimitRedisClientFactory,
  type AttachmentRouteRateLimitFacadeDeps,
} from '../infrastructure/rate-limit/index.js';
import {
  createAttachmentMetricsStore,
  createDeliveryRateLimiter,
  evaluateAttachmentRateLimitReadiness,
  rateLimitSubjectHmac,
  type AttachmentMetricOperation,
  type AttachmentMetricRateLimitDecision,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitLogEntry,
  type AttachmentMetricsStore,
  type AttachmentRateLimitReadinessVerdict,
  type DeliveryRateLimiter,
  type RateLimitStore,
} from '../modules/attachments/index.js';

/** Infra-level shadow-mode mismatch counter (plan §13.2). */
export const ATTACHMENT_RATE_LIMIT_SHADOW_MISMATCH_METRIC = 'attachments.rate_limit.shadow_mismatch';

export interface ComposeAttachmentRateLimitOptions {
  /** Full RL02 config (mode/budgets/refs); `off` creates no client. */
  readonly config: AttachmentRateLimitConfig;
  /** Key codec environment token (nodeEnv); 1-64 chars, no colon. */
  readonly environment: string;
  /**
   * Resolves the HMAC key secret by its opaque reference. Never called in
   * `off` mode; the resolved value is never logged or serialized.
   */
  readonly resolveKeySecret: (ref: string) => Promise<Buffer | string>;
  /** Infrastructure metrics bridge for `attachments.rate_limit.shadow_mismatch`. */
  readonly metrics?: Metrics;
  /** Test seam: replaces the ioredis client factory (never called in `off`). */
  readonly createClient?: RateLimitRedisClientFactory;
  /** Bounded graceful-close budget (ms) for the Redis runtime. */
  readonly closeTimeoutMs?: number;
  /** Circuit breaker consecutive failures that open it (default 3). */
  readonly failureThreshold?: number;
  /** Circuit breaker cooldown before a half-open probe (default 1000ms). */
  readonly cooldownMs?: number;
  /** Injectable decision clock (ms); defaults to the wall clock. */
  readonly clock?: () => number;
  /**
   * The I10 bounded local reference limiter for the download route
   * (off/shadow modes); defaults to the production policy. The SAME instance
   * must never be passed into `authorizeOwnerDownload` (the facade consumes
   * the local attempt exactly once).
   */
  readonly localLimiter?: DeliveryRateLimiter;
  /** Fixed-class structured admission logger (never subject/key/URL text). */
  readonly logger?: (entry: AttachmentRateLimitLogEntry) => void;
}

export interface AttachmentRateLimitComposition {
  readonly facade: ReturnType<typeof createAttachmentRouteRateLimitFacade>;
  /** Production fixed-label decision store (bounded, module-owned). */
  readonly metricsStore: AttachmentMetricsStore;
  readonly mode: 'off' | 'shadow' | 'enforce';
  /** The owned local reference limiter (download; off/shadow modes). */
  readonly localLimiter: DeliveryRateLimiter;
  /** RL02 policy verdict: enforce+required + degraded blocks attachments. */
  readiness(): AttachmentRateLimitReadinessVerdict;
  /** Bounded, idempotent close; a no-op for mode=off (no client). */
  close(): Promise<void>;
}

/**
 * Production composition. Fail-closed: `shadow`/`enforce` without a resolvable
 * key secret or a bounded configuration throw here, before any route can be
 * registered; `off` never resolves the secret and never creates a client.
 */
export async function composeAttachmentRateLimit(
  options: ComposeAttachmentRateLimitOptions,
): Promise<AttachmentRateLimitComposition> {
  const { config } = options;
  let store: RateLimitStore | null = null;
  let keySecret: Buffer | undefined;
  if (config.mode !== 'off') {
    if (config.keySecretRef === null) {
      throw new Error('composeAttachmentRateLimit requires ATTACHMENTS_RATE_LIMIT_KEY_SECRET in shadow/enforce mode');
    }
    const resolved = await options.resolveKeySecret(config.keySecretRef);
    keySecret = Buffer.isBuffer(resolved) ? resolved : Buffer.from(resolved, 'utf8');
    if (keySecret.length === 0) {
      throw new Error('composeAttachmentRateLimit requires a non-empty HMAC key secret');
    }
    store = createRedisRateLimitStore({
      config,
      environment: options.environment,
      keySecret,
      ...(options.createClient === undefined ? {} : { createClient: options.createClient }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
      ...(options.failureThreshold === undefined ? {} : { failureThreshold: options.failureThreshold }),
      ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
      ...(options.clock === undefined ? {} : { now: options.clock }),
    });
  }

  const metricsStore = createAttachmentMetricsStore();
  const localLimiter = options.localLimiter ?? createDeliveryRateLimiter();
  const metricRecord = (operation: AttachmentMetricOperation, decision: AttachmentMetricRateLimitDecision): void => {
    metricsStore.record({
      operation,
      state: decision === 'allowed' ? 'ok' : decision === 'denied' ? 'denied' : 'retryable',
      errorClass: decision === 'allowed' || decision === 'denied' ? 'none' : 'provider_retryable',
      sizeBucket: 'zero',
      latencyBucket: 'under_1s',
      rateLimitDecision: decision,
    });
  };

  const facadeDeps: AttachmentRouteRateLimitFacadeDeps = {
    config,
    store,
    localLimiter,
    metrics: {
      recordDecision: metricRecord,
      incrementShadowMismatch: () => {
        options.metrics?.increment(ATTACHMENT_RATE_LIMIT_SHADOW_MISMATCH_METRIC);
      },
    },
    ...(options.logger === undefined ? {} : { log: options.logger }),
    ...(options.clock === undefined ? {} : { now: options.clock }),
    ...(config.mode === 'enforce'
      ? {
          subjectKeyFor: (subject) =>
            // The bounded emergency subject key: base64url-truncated HMAC over
            // principal + NUL + scope (plan §2.3) — never raw identity text.
            rateLimitSubjectHmac(keySecret!, subject),
        }
      : {}),
  };
  const facade = createAttachmentRouteRateLimitFacade(facadeDeps);

  return Object.freeze({
    facade,
    metricsStore,
    mode: config.mode,
    localLimiter,
    readiness(): AttachmentRateLimitReadinessVerdict {
      return evaluateAttachmentRateLimitReadiness({
        mode: config.mode,
        required: config.required,
        storeStatus: facade.readiness().status,
      });
    },
    async close(): Promise<void> {
      await facade.close();
    },
  });
}

/**
 * Resolves the rate-limit HMAC key secret VALUE by its opaque reference,
 * mirroring the worker R2 resolver: ref `known/prod/ratelimit/hmac` reads
 * `ATTACHMENTS_RATE_LIMIT_KEY_SECRET_HMAC` (the ref names which secret,
 * never a value). Fails closed on unknown refs or missing values. The
 * resolved value is used directly as the codec HMAC key and is never logged
 * or serialized (plan §12 artifact ban).
 */
export async function resolveApiRateLimitKeySecret(ref: string): Promise<Buffer> {
  const suffix = ref.split('/').filter(Boolean).pop()
    ?.replace(/[^A-Za-z0-9]/g, '_').toUpperCase() ?? '';
  if (suffix.length === 0) {
    throw new Error(`API composition refused: invalid ATTACHMENTS_RATE_LIMIT_KEY_SECRET ref ${ref}`);
  }
  const value = process.env[`ATTACHMENTS_RATE_LIMIT_KEY_SECRET_${suffix}`]?.trim();
  if (!value) {
    throw new Error(
      `API composition refused: ATTACHMENTS_RATE_LIMIT_KEY_SECRET_${suffix} is required to resolve ${ref}`,
    );
  }
  return Buffer.from(value, 'utf8');
}

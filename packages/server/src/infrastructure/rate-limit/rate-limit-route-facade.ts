/**
 * P4A-RL04 route composition of the distributed admission limiter (plan
 * §2.2.2-§2.2.4, §4.1.9/§4.2.7, §8 RL04).
 *
 * This module implements the RL02/RL04 `AttachmentRouteRateLimitFacade` on
 * top of the RL03 store + failure policy. It is the ONLY place where the
 * mode semantics (`off|shadow|enforce`) turn into route decisions:
 *
 *  - `off`     -> the facade never touches Redis (the composition must not
 *                 even create a store); the download route keeps the bounded
 *                 process-local reference limiter (I10 semantics) and
 *                 issue/complete are allowed exactly like the RL01 baseline;
 *  - `shadow`  -> the local reference decision runs unchanged (download keeps
 *                 the I10 429 semantics; issue/complete have no local
 *                 limiter and are allowed), the Redis decision runs ALONGSIDE
 *                 and is recorded but never denies: every disagreement is a
 *                 `shadow_mismatch` metric/log entry (plan §13.2);
 *  - `enforce` -> Redis decides. Quota exhaustion is a denied DECISION (429
 *                 with real Retry-After + RateLimit-Policy); Redis
 *                 unavailable makes issue/download fail closed (503 with NO
 *                 fabricated quota facts, plan §4.1.10) while `complete` —
 *                 the recovery entry for already-uploaded objects — keeps
 *                 serving through the BOUNDED in-process emergency limiter
 *                 (RL02 `completeEmergency` budget) and reports
 *                 `fallback`/`fallback_denied` evidence (plan §2.2.3,
 *                 §4.2.7: business recovery success AND degraded evidence are
 *                 asserted together by the RL04 suites).
 *
 * The local reference attempt is consumed HERE (exactly once, before any
 * database work): the route composition therefore passes a permissive local
 * limiter into the download use case so the I10 budget is never double-spent.
 *
 * Metrics/logs only carry the sealed RL01 decision dimension and fixed route/
 * mode/failure-class labels — never a subject, principal, Collection, key,
 * URL or HMAC (plan §2.3). The emergency subject key is the codec's
 * base64url-truncated HMAC (bounded, no raw identity).
 */
import type {
  AttachmentAdmissionOutcome,
  AttachmentMetricOperation,
  AttachmentRateLimitConfig,
  AttachmentRateLimitLogEntry,
  AttachmentRateLimitDecision,
  AttachmentRouteRateLimitFacade,
  DeliveryRateLimiter,
  RateLimitCheckInput,
  RateLimitStore,
  RateLimitStoreReadiness,
  RateLimitSubject,
} from '../../modules/attachments/index.js';
import {
  admissionOutcomeMetricDecision,
  assertAttachmentRateLimitDecision,
  resolveRouteRatePolicy,
  retryAfterSecondsFor,
  type AttachmentMetricRateLimitDecision,
} from '../../modules/attachments/index.js';
import { EmergencyRateLimiter } from './rate-limit-failure-policy.js';
import {
  applyRouteFailurePolicy,
  routeFailureVerdictToAdmissionOutcome,
} from './rate-limit-failure-policy.js';

/** Optional fixed-label metrics sink (module store + infra shadow counter). */
export interface AttachmentRouteRateLimitMetrics {
  readonly recordDecision: (
    operation: AttachmentMetricOperation,
    decision: AttachmentMetricRateLimitDecision,
  ) => void;
  /** Infra-level `attachments.rate_limit.shadow_mismatch` counter. */
  readonly incrementShadowMismatch: () => void;
}

export interface AttachmentRouteRateLimitFacadeDeps {
  /** Full RL02 config; `off` must never carry a store (no Redis client). */
  readonly config: AttachmentRateLimitConfig;
  /**
   * The distributed store; MUST be null in `off` mode (zero Redis
   * connections, plan §13.1 step 1) and MUST be present in
   * `shadow`/`enforce`.
   */
  readonly store: RateLimitStore | null;
  /** Bounded in-process emergency limiter for `complete` (default: config budget). */
  readonly emergency?: EmergencyRateLimiter;
  /**
   * Builds the bounded emergency subject key from the HMAC codec (never the
   * raw subject); required for `enforce` (the emergency only runs there).
   */
  readonly subjectKeyFor?: (subject: RateLimitSubject) => string;
  /**
   * The I10 bounded process-local reference limiter for the download route
   * (`off`/`shadow` modes; optional because issue/complete have no local
   * limiter — their reference decision is always allowed).
   */
  readonly localLimiter?: DeliveryRateLimiter;
  readonly metrics?: AttachmentRouteRateLimitMetrics;
  /** Fixed-class structured logger (never subject/key/URL text). */
  readonly log?: (entry: AttachmentRateLimitLogEntry) => void;
  /** Injectable decision clock (ms); defaults to the wall clock. */
  readonly now?: () => number;
}

export interface LocalReferenceDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

/**
 * Factory for the route-facing facade. Fail-closed construction: `off` mode
 * refuses a store (a client would violate the zero-connection contract),
 * `shadow`/`enforce` refuse a missing store, and `enforce` refuses a missing
 * emergency subject-key builder.
 */
export function createAttachmentRouteRateLimitFacade(
  deps: AttachmentRouteRateLimitFacadeDeps,
): AttachmentRouteRateLimitFacade {
  if (deps.config.mode === 'off') {
    if (deps.store !== null) {
      throw new Error('createAttachmentRouteRateLimitFacade refuses a store in ATTACHMENTS_RATE_LIMIT_MODE=off');
    }
  } else if (deps.store === null) {
    throw new Error(
      'createAttachmentRouteRateLimitFacade requires a store in shadow/enforce mode',
    );
  }
  if (deps.config.mode === 'enforce' && deps.subjectKeyFor === undefined) {
    throw new Error('createAttachmentRouteRateLimitFacade requires subjectKeyFor in enforce mode');
  }
  return new AttachmentRouteRateLimitFacadeImpl(deps);
}

class AttachmentRouteRateLimitFacadeImpl implements AttachmentRouteRateLimitFacade {
  readonly config: AttachmentRateLimitConfig;
  private readonly store: RateLimitStore | null;
  private readonly emergency: EmergencyRateLimiter;
  private readonly subjectKeyFor: ((subject: RateLimitSubject) => string) | undefined;
  private readonly localLimiter: DeliveryRateLimiter | undefined;
  private readonly metrics: AttachmentRouteRateLimitMetrics | undefined;
  private readonly log: ((entry: AttachmentRateLimitLogEntry) => void) | undefined;
  private readonly now: () => number;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(deps: AttachmentRouteRateLimitFacadeDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.emergency = deps.emergency ?? new EmergencyRateLimiter(deps.config);
    this.subjectKeyFor = deps.subjectKeyFor;
    this.localLimiter = deps.localLimiter;
    this.metrics = deps.metrics;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
  }

  get mode(): 'off' | 'shadow' | 'enforce' {
    return this.config.mode;
  }

  async checkAdmission(input: RateLimitCheckInput): Promise<AttachmentAdmissionOutcome> {
    if (this.closed) {
      return Object.freeze({
        kind: 'unavailable',
        mode: this.config.mode,
        failure: Object.freeze({ class: 'unavailable', code: 'rate_limit_facade_closed' }),
      });
    }
    const nowEpochMs = input.nowEpochMs ?? this.now();
    switch (this.config.mode) {
      case 'off':
        return this.checkOff(input, nowEpochMs);
      case 'shadow':
        return this.checkShadow(input, nowEpochMs);
      case 'enforce':
        return this.checkEnforce(input, nowEpochMs);
    }
  }

  readiness(): RateLimitStoreReadiness {
    // The store-level readiness fact; the bootstrap composition turns it into
    // the policy verdict (enforce+required blocks, everything else degrades).
    return this.store === null
      ? Object.freeze({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: this.now() })
      : this.store.readiness();
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      await this.store?.close();
    })();
    return this.closePromise;
  }

  // -------------------------------------------------------------------------
  // off: bounded local reference only (I10 semantics), zero Redis
  // -------------------------------------------------------------------------

  private checkOff(input: RateLimitCheckInput, nowEpochMs: number): AttachmentAdmissionOutcome {
    const policy = resolveRouteRatePolicy(this.config, input.routeClass);
    const local = this.localReference(input, nowEpochMs);
    if (local.allowed) {
      const decision = this.allowedDecision(policy.rateMax, policy.rateWindowMs, nowEpochMs);
      this.record(input.routeClass, 'allowed');
      this.emitLog(input.routeClass, 'allowed', null, false);
      return Object.freeze({ kind: 'allowed', mode: 'off', decision });
    }
    const decision = this.deniedDecision(local.retryAfterSeconds, policy.rateWindowMs, nowEpochMs);
    this.record(input.routeClass, 'denied');
    this.emitLog(input.routeClass, 'denied', null, false);
    return Object.freeze({ kind: 'denied', mode: 'off', decision });
  }

  // -------------------------------------------------------------------------
  // shadow: local reference decides; Redis runs alongside and never denies
  // -------------------------------------------------------------------------

  private async checkShadow(input: RateLimitCheckInput, nowEpochMs: number): Promise<AttachmentAdmissionOutcome> {
    const policy = resolveRouteRatePolicy(this.config, input.routeClass);
    const local = this.localReference(input, nowEpochMs);
    const redis = await this.store!.check({
      routeClass: input.routeClass,
      subject: input.subject,
      nowEpochMs,
    });

    if (redis.kind === 'failed') {
      // A Redis failure in shadow mode never changes the route decision; the
      // fixed failure class is recorded so the shadow rollout can observe
      // command errors without denying traffic (plan §13.2).
      this.emitLog(input.routeClass, local.allowed ? 'allowed' : 'denied', redis.failure.class, false);
    } else {
      const mismatch = redis.kind === 'denied' ? local.allowed : !local.allowed;
      if (mismatch) this.metrics?.incrementShadowMismatch();
      this.emitLog(input.routeClass, local.allowed ? 'allowed' : 'denied', null, mismatch);
    }

    if (local.allowed) {
      const decision = redis.kind === 'allowed' ? redis.decision
        : this.allowedDecision(policy.rateMax, policy.rateWindowMs, nowEpochMs);
      this.record(input.routeClass, 'allowed');
      return Object.freeze({ kind: 'allowed', mode: 'shadow', decision });
    }
    const decision = this.deniedDecision(local.retryAfterSeconds, policy.rateWindowMs, nowEpochMs);
    this.record(input.routeClass, 'denied');
    return Object.freeze({ kind: 'denied', mode: 'shadow', decision });
  }

  // -------------------------------------------------------------------------
  // enforce: Redis decides; issue/download fail closed, complete falls back
  // -------------------------------------------------------------------------

  private async checkEnforce(input: RateLimitCheckInput, nowEpochMs: number): Promise<AttachmentAdmissionOutcome> {
    const policy = resolveRouteRatePolicy(this.config, input.routeClass);
    const redis = await this.store!.check({
      routeClass: input.routeClass,
      subject: input.subject,
      nowEpochMs,
    });
    if (redis.kind === 'allowed') {
      this.record(input.routeClass, 'allowed');
      this.emitLog(input.routeClass, 'allowed', null, false);
      return Object.freeze({ kind: 'allowed', mode: 'enforce', decision: redis.decision });
    }
    if (redis.kind === 'denied') {
      this.record(input.routeClass, 'denied');
      this.emitLog(input.routeClass, 'denied', null, false);
      return Object.freeze({ kind: 'denied', mode: 'enforce', decision: redis.decision });
    }

    // Infrastructure failure (never a quota fact): route-specific policy.
    const subjectKey = this.subjectKeyFor!(input.subject);
    const verdict = applyRouteFailurePolicy({
      routeClass: input.routeClass,
      failure: redis.failure,
      emergency: this.emergency,
      subjectKey,
      nowEpochMs,
    });
    const outcome = routeFailureVerdictToAdmissionOutcome(verdict, 'enforce');
    const decision = admissionOutcomeMetricDecision(outcome);
    this.record(input.routeClass, decision);
    this.emitLog(input.routeClass, decision, redis.failure.class, false);
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /**
   * The local reference decision: the I10 bounded limiter for download
   * (consuming exactly one attempt), always-allowed for issue/complete/status
   * (no local limiter exists; the RL01 baseline admits them).
   */
  private localReference(input: RateLimitCheckInput, nowEpochMs: number): LocalReferenceDecision {
    if (input.routeClass === 'download' && this.localLimiter !== undefined) {
      const result = this.localLimiter.check(input.subject.principalId, new Date(nowEpochMs));
      return { allowed: result.allowed, retryAfterSeconds: result.retryAfterSeconds };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private allowedDecision(
    rateMax: number,
    rateWindowMs: number,
    nowEpochMs: number,
  ): AttachmentRateLimitDecision {
    return this.decision(true, rateMax, 0, rateWindowMs, nowEpochMs);
  }

  private deniedDecision(
    retryAfterSeconds: number,
    rateWindowMs: number,
    nowEpochMs: number,
  ): AttachmentRateLimitDecision {
    const windowStartEpochMs = Math.floor(nowEpochMs / rateWindowMs) * rateWindowMs;
    const retryAfter = retryAfterSeconds > 0
      ? retryAfterSeconds
      : retryAfterSecondsFor(windowStartEpochMs, rateWindowMs, nowEpochMs);
    return this.decision(false, 0, retryAfter, rateWindowMs, nowEpochMs);
  }

  private decision(
    allowed: boolean,
    remaining: number,
    retryAfterSeconds: number,
    rateWindowMs: number,
    nowEpochMs: number,
  ): AttachmentRateLimitDecision {
    const windowStartEpochMs = Math.floor(nowEpochMs / rateWindowMs) * rateWindowMs;
    const retryAfter = allowed ? 0 : retryAfterSeconds;
    const decision = Object.freeze({ allowed, remaining, retryAfterSeconds: retryAfter, windowStartEpochMs });
    assertAttachmentRateLimitDecision(decision);
    return decision;
  }

  private record(routeClass: RateLimitCheckInput['routeClass'], decision: AttachmentMetricRateLimitDecision): void {
    this.metrics?.recordDecision(routeClass, decision);
  }

  private emitLog(
    routeClass: AttachmentRateLimitLogEntry['routeClass'],
    decision: AttachmentMetricRateLimitDecision,
    failureClass: AttachmentRateLimitLogEntry['failureClass'],
    shadowMismatch: boolean,
  ): void {
    this.log?.(Object.freeze({
      routeClass,
      mode: this.config.mode,
      decision,
      failureClass,
      shadowMismatch,
    }));
  }
}

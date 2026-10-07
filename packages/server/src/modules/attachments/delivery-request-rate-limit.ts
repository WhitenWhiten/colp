/**
 * FIX-L-049 request-level rate-limit port for the isolated delivery host
 * (audit KA-P4-AM-14).
 *
 * The credential-free delivery origin previously had NO request-level
 * throttling on its actual GET/HEAD path: a leaked capability could be
 * replayed inside its TTL to consume DB+R2+bandwidth, and floods of invalid
 * tokens still paid verification. This module freezes the PORT and sealed
 * types of the delivery request limiter WITHOUT any implementation:
 *
 *  - two budgets, `ip` and `token`, are separate key namespaces and can
 *    NEVER share a counter: the trusted-IP bucket is the low-cost flood
 *    stopper (checked before verification, so invalid floods are bounded),
 *    the token-digest bucket bounds replays of one leaked/expired
 *    capability before DB/R2;
 *  - GET/HEAD SHARE the token budget (the subject is the token only, never
 *    the method) and Range never opens a separate bucket;
 *  - the raw client IP and the raw capability token (a bearer secret) only
 *    ever exist inside the HMAC input of the key codec — never in a Redis
 *    key, log, metric or error;
 *  - quota exhaustion is a DENIED decision (fixed 429 with Retry-After),
 *    while `unavailable`/`timeout`/`malformed`/`acl`/`internal` are FAILURE
 *    classes that transports map to an explicit 503 (a limiter outage must
 *    never silently admit unlimited traffic);
 *  - `denied` and `failed` are never conflated; invalid/expired capabilities
 *    keep the existing zero-body 404 concealment policy.
 *
 * The in-memory adapter (single-instance default) and the shared Redis
 * adapter (multi-replica; WAF/CDN edge control is the deployment-level
 * alternative) both implement this port — the transport only ever sees the
 * port.
 */
export const DELIVERY_REQUEST_RATE_LIMIT_POLICIES = Object.freeze([
  'ip', 'token',
] as const);
export type DeliveryRequestRateLimitPolicy = (typeof DELIVERY_REQUEST_RATE_LIMIT_POLICIES)[number];

/**
 * The admission subject. `facts` is the canonical subject text: the trusted
 * client IP for `ip` (the direct peer, never a spoofable forwarded header)
 * or the raw capability token for `token`. It is bounded and validated
 * fail-closed by the adapters/codec; the raw text never reaches a key or a
 * log.
 */
export interface DeliveryRequestRateLimitSubject {
  readonly policy: DeliveryRequestRateLimitPolicy;
  readonly facts: string;
}

/** The fixed-window quota decision (quota facts only; never a failure). */
export interface DeliveryRequestRateLimitDecision {
  readonly allowed: boolean;
  /** Ceil to the window rollover (seconds); 0 at rollover. */
  readonly retryAfterSeconds: number;
}

/** Stable infrastructure failure classes (same sealed taxonomy as RL02/RL03). */
export type DeliveryRequestRateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface DeliveryRequestRateLimitFailure {
  readonly class: DeliveryRequestRateLimitFailureClass;
  readonly code: string;
}

export type DeliveryRequestRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: DeliveryRequestRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: DeliveryRequestRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: DeliveryRequestRateLimitFailure };

export type DeliveryRequestRateLimitReadinessStatus = 'healthy' | 'degraded';
export type DeliveryRequestRateLimitReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface DeliveryRequestRateLimitReadiness {
  readonly status: DeliveryRequestRateLimitReadinessStatus;
  readonly reason: DeliveryRequestRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

/**
 * The delivery GET/HEAD request-level limiter port. The in-memory adapter
 * (single-instance deployments and tests) and the shared Redis adapter both
 * implement it; multi-replica delivery deployments MUST inject the shared
 * adapter (or rely on WAF/CDN edge control).
 */
export interface DeliveryRequestLimiter {
  consume(subject: DeliveryRequestRateLimitSubject): Promise<DeliveryRequestRateLimitOutcome>;
  readiness(): DeliveryRequestRateLimitReadiness;
  close(): Promise<void>;
}

/** One fixed-window budget (shared shape of both policies). */
export interface DeliveryRequestLimitBudget {
  /** Allowed attempts per fixed window. */
  readonly maxRequests: number;
  /** Fixed window length in ms. */
  readonly windowMs: number;
}

// ---------------------------------------------------------------------------
// Default budgets and hard ceilings (validated fail-closed everywhere)
// ---------------------------------------------------------------------------

/** Trusted-IP flood budget: generous for a legitimate NATed client. */
export const DELIVERY_REQUEST_LIMIT_IP_MAX_DEFAULT = 600;
export const DELIVERY_REQUEST_LIMIT_IP_WINDOW_MS_DEFAULT = 60_000;
/** Token replay budget: legitimate short-term downloads make a handful of
 * GET/HEAD/Range requests per capability, so 120/min leaves ample headroom
 * while bounding a leaked-token replay to a small fixed cost. */
export const DELIVERY_REQUEST_LIMIT_TOKEN_MAX_DEFAULT = 120;
export const DELIVERY_REQUEST_LIMIT_TOKEN_WINDOW_MS_DEFAULT = 60_000;
export const DELIVERY_REQUEST_LIMIT_MAX_REQUESTS_CEILING = 10_000;
export const DELIVERY_REQUEST_LIMIT_WINDOW_MAX_MS = 3_600_000;

/**
 * Fail-closed budget validation shared by every adapter. Programmer/
 * deployment-input guard, never an HTTP error.
 */
export function assertDeliveryRequestLimitBudget(policy: DeliveryRequestRateLimitPolicy, budget: DeliveryRequestLimitBudget): void {
  if (!Number.isSafeInteger(budget.maxRequests)
    || budget.maxRequests < 1
    || budget.maxRequests > DELIVERY_REQUEST_LIMIT_MAX_REQUESTS_CEILING) {
    throw new RangeError(`delivery ${policy} budget maxRequests must be a safe integer 1..${DELIVERY_REQUEST_LIMIT_MAX_REQUESTS_CEILING}`);
  }
  if (!Number.isSafeInteger(budget.windowMs)
    || budget.windowMs < 1
    || budget.windowMs > DELIVERY_REQUEST_LIMIT_WINDOW_MAX_MS) {
    throw new RangeError(`delivery ${policy} budget windowMs must be a safe integer 1..${DELIVERY_REQUEST_LIMIT_WINDOW_MAX_MS}`);
  }
}

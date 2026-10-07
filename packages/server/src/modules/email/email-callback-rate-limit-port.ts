/**
 * FIX-L-061 trusted-IP ingress budget port for the email callback surface
 * (audit KA-P5-SOC-16).
 *
 * The callback surface previously had NO request-level limiter: the legacy
 * MNS path fetched its signing certificate (whitelisted-host URL) BEFORE RSA
 * verification, so an unauthenticated flood could rotate certificate paths
 * and consume outbound connections + certificate/crypto work. This module
 * freezes the PORT and sealed types of the ingress limiter WITHOUT any
 * implementation:
 *
 *  - ONE budget, `ip`, keyed on the TRUSTED client IP (Fastify `request.ip`,
 *    which honors X-Forwarded-For only through the configured trusted-ingress
 *    allowlist — never a spoofable forwarded header read directly). The
 *    budget is consumed at the route BEFORE body parsing/signature
 *    verification/certificate fetching, so invalid floods are bounded at the
 *    cheapest possible point;
 *  - the raw client IP only ever exists inside the HMAC input of the key
 *    codec — never in a Redis key, log, metric or error;
 *  - quota exhaustion is a DENIED decision (fixed 429 with Retry-After),
 *    while `unavailable`/`timeout`/`malformed`/`acl`/`internal` are FAILURE
 *    classes that the route maps to an explicit 503 (a limiter outage must
 *    never silently admit unlimited traffic);
 *  - `denied` and `failed` are never conflated; the default budget (600
 *    requests/min/IP) leaves legitimate provider redelivery retries ample
 *    headroom.
 *
 * The in-memory adapter (single-instance default) and the shared Redis
 * adapter (multi-replica; WAF/CDN edge control is the deployment-level
 * alternative) both implement this port — the transport only ever sees the
 * port.
 */
export const EMAIL_CALLBACK_RATE_LIMIT_POLICIES = Object.freeze([
  'ip',
] as const);
export type EmailCallbackRateLimitPolicy = (typeof EMAIL_CALLBACK_RATE_LIMIT_POLICIES)[number];

/**
 * The admission subject. `facts` is the canonical subject text: the trusted
 * client IP (the direct peer, never a spoofable forwarded header). It is
 * bounded and validated fail-closed by the adapters/codec; the raw text never
 * reaches a key or a log.
 */
export interface EmailCallbackRateLimitSubject {
  readonly policy: EmailCallbackRateLimitPolicy;
  readonly facts: string;
}

/** The fixed-window quota decision (quota facts only; never a failure). */
export interface EmailCallbackRateLimitDecision {
  readonly allowed: boolean;
  /** Ceil to the window rollover (seconds); 0 at rollover. */
  readonly retryAfterSeconds: number;
}

/** Stable infrastructure failure classes (same sealed taxonomy as RL02/RL03). */
export type EmailCallbackRateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface EmailCallbackRateLimitFailure {
  readonly class: EmailCallbackRateLimitFailureClass;
  readonly code: string;
}

export type EmailCallbackRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: EmailCallbackRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: EmailCallbackRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: EmailCallbackRateLimitFailure };

export type EmailCallbackRateLimitReadinessStatus = 'healthy' | 'degraded';
export type EmailCallbackRateLimitReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface EmailCallbackRateLimitReadiness {
  readonly status: EmailCallbackRateLimitReadinessStatus;
  readonly reason: EmailCallbackRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

/** The fixed-window IP budget (per trusted peer IP). */
export interface EmailCallbackRateLimitBudget {
  readonly maxRequests: number;
  readonly windowMs: number;
}

/** Bounded budget ceilings (mirror the FIX-L-049 delivery budgets). */
export const EMAIL_CALLBACK_RATE_LIMIT_MAX_REQUESTS_CEILING = 10_000;
export const EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MAX_MS = 3_600_000;
/** Default IP budget: generous for legitimate provider retries, bounded for floods. */
export const EMAIL_CALLBACK_RATE_LIMIT_IP_MAX_DEFAULT = 600;
export const EMAIL_CALLBACK_RATE_LIMIT_IP_WINDOW_MS_DEFAULT = 60_000;

/** Fail-closed budget validation used by the adapters and the bootstrap. */
export function assertEmailCallbackRateLimitBudget(budget: EmailCallbackRateLimitBudget): void {
  if (!Number.isSafeInteger(budget.maxRequests) || budget.maxRequests < 1
      || budget.maxRequests > EMAIL_CALLBACK_RATE_LIMIT_MAX_REQUESTS_CEILING) {
    throw new Error(
      `email callback rate limit maxRequests must be a safe integer in 1..${EMAIL_CALLBACK_RATE_LIMIT_MAX_REQUESTS_CEILING}`,
    );
  }
  if (!Number.isSafeInteger(budget.windowMs) || budget.windowMs < 1
      || budget.windowMs > EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MAX_MS) {
    throw new Error(
      `email callback rate limit windowMs must be a safe integer in 1..${EMAIL_CALLBACK_RATE_LIMIT_WINDOW_MAX_MS}`,
    );
  }
}

/**
 * The email callback ingress limiter port. The in-memory adapter
 * (single-instance default) and the shared Redis adapter (multi-replica)
 * implement it; the route only ever sees this port.
 */
export interface EmailCallbackRateLimiter {
  /** Consume one admission attempt for the subject; bounded/validated fail-closed. */
  consume(subject: EmailCallbackRateLimitSubject): Promise<EmailCallbackRateLimitOutcome>;
  /** Store-level readiness fact (healthy/degraded). */
  readiness(): EmailCallbackRateLimitReadiness;
  /** Graceful shutdown (idempotent; the in-memory adapter owns no resources). */
  close(): Promise<void>;
}

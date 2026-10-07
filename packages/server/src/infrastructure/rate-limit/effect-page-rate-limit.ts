/**
 * FIX-M-013 (SYNC-R08) effect-page rate-limit port.
 *
 * The Sync effect-page endpoint was the only Sync data endpoint without a
 * request limiter: every page read opens a transaction, re-validates Pull
 * authority and walks the digest chain, so a legitimate session could page
 * through up to 1024 pages and amplify DB cost. This port is the replaceable
 * admission interface: the single-instance deployment uses the in-process
 * memory adapter (transport/http-security), and a multi-instance deployment
 * can inject a shared adapter implementing the same contract.
 *
 * Key contract (enforced by adapters):
 *  - the SUBJECT total bucket keys on trusted client IP + session + replica;
 *  - the per-EFFECT sub-bucket adds the effect id;
 *  - page indices are deliberately NOT part of any key: a client rotating
 *    pages must never mint a fresh budget.
 *
 * Fail-closed contract (mirrors FIX-M-001/FIX-M-006):
 *  - quota exhaustion is a DENIED decision (429 with Retry-After) — never a
 *    failure class;
 *  - store failures are FAILED outcomes that transport maps to an explicit
 *    503 without fabricating quota facts.
 */
export interface EffectPageRateLimitSubject {
  /** Trusted client IP after proxy resolution (Fastify request.ip). */
  readonly clientIp: string;
  readonly sessionId: string;
  readonly replicaId: string;
  readonly effectId: string;
}

/** Which bucket denied the request: the subject total or the per-effect sub-bucket. */
export type EffectPageRateLimitFamily = 'subject' | 'effect';

/** The effect-page quota decision (quota facts only; never a failure). */
export interface EffectPageRateLimitDecision {
  readonly allowed: boolean;
  /** Ceil to the window rollover (seconds); 0 at rollover. */
  readonly retryAfterSeconds: number;
  readonly family: EffectPageRateLimitFamily;
}

/** Stable infrastructure failure classes (same sealed taxonomy as auth/search). */
export type EffectPageRateLimitFailureClass = 'unavailable' | 'timeout' | 'malformed' | 'acl' | 'internal';

export interface EffectPageRateLimitFailure {
  readonly class: EffectPageRateLimitFailureClass;
  readonly code: string;
}

export type EffectPageRateLimitOutcome =
  | { readonly kind: 'allowed'; readonly decision: EffectPageRateLimitDecision }
  | { readonly kind: 'denied'; readonly decision: EffectPageRateLimitDecision }
  | { readonly kind: 'failed'; readonly failure: EffectPageRateLimitFailure };

export type EffectPageRateLimitReadinessStatus = 'healthy' | 'degraded';
export type EffectPageRateLimitReadinessReason = 'none' | 'connecting' | 'last_command_failed' | 'closed';

export interface EffectPageRateLimitReadiness {
  readonly status: EffectPageRateLimitReadinessStatus;
  readonly reason: EffectPageRateLimitReadinessReason;
  readonly lastCheckedAtEpochMs: number;
}

/**
 * The effect-page rate-limit port. The in-memory adapter (transport) and any
 * future shared adapter both implement it; multi-instance production
 * compositions MUST inject a shared adapter.
 */
export interface EffectPageRateLimiter {
  consume(subject: EffectPageRateLimitSubject): Promise<EffectPageRateLimitOutcome>;
  readiness(): EffectPageRateLimitReadiness;
  close(): Promise<void>;
}

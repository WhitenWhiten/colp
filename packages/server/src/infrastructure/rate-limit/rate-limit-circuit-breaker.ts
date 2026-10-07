/**
 * P4A-RL03 rate-limit circuit breaker (plan §8 RL03).
 *
 * Deliberately independent from the Publication `CacheCircuitBreaker` (plan
 * §2.2.5: the Attachment limiter owns its client, ACL, key namespace,
 * readiness and fail strategy; nothing is reused from the cache layer).
 *
 * After `failureThreshold` CONSECUTIVE Redis failures the breaker opens and
 * the store stops issuing meaningless commands (fast `unavailable`). After
 * `cooldownMs` the breaker admits exactly ONE half-open probe: a successful
 * probe closes the breaker, a failed probe re-opens it immediately with a
 * fresh cooldown. The clock is injectable so tests advance cooldowns
 * deterministically; the breaker is pure coordination — it never talks to
 * Redis and never throws from `allowRequest`.
 */
export type RateLimitCircuitState = 'closed' | 'open' | 'half_open';

/** Default consecutive failures that open the breaker (store factory default). */
export const RATE_LIMIT_CIRCUIT_DEFAULT_FAILURE_THRESHOLD = 3;
/** Default cooldown before a half-open probe (store factory default). */
export const RATE_LIMIT_CIRCUIT_DEFAULT_COOLDOWN_MS = 1_000;

export interface RateLimitCircuitBreakerOptions {
  /** Consecutive Redis failures that open the breaker (>= 1). */
  readonly failureThreshold: number;
  /** Cooldown in ms before the breaker admits a single half-open probe (>= 0). */
  readonly cooldownMs: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  readonly clock?: () => number;
}

export class RateLimitCircuitBreaker {
  private state: RateLimitCircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private probeInFlight = false;

  constructor(private readonly options: RateLimitCircuitBreakerOptions) {
    if (!Number.isSafeInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new Error('RateLimitCircuitBreaker failureThreshold must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.cooldownMs) || options.cooldownMs < 0) {
      throw new Error('RateLimitCircuitBreaker cooldownMs must be a non-negative safe integer');
    }
  }

  get currentState(): RateLimitCircuitState {
    return this.state;
  }

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * True when a Redis command may be issued:
   *  - closed: always true;
   *  - open + cooldown elapsed: transitions to half_open, reserves the single
   *    probe and returns true for that one caller only;
   *  - half_open with a probe already in flight: false (only one probe).
   */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.now() - this.openedAtMs < this.options.cooldownMs) return false;
      this.state = 'half_open';
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  /** Records a successful Redis interaction: resets the streak, closes after a successful probe. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.probeInFlight = false;
    }
  }

  /**
   * Records a Redis failure: opens the breaker at the threshold from closed,
   * re-opens it immediately when the single half-open probe fails. Failures
   * recorded while open are ignored (no commands are sent anyway).
   */
  recordFailure(): void {
    if (this.state === 'open') return;
    this.consecutiveFailures += 1;
    if (this.state === 'half_open') {
      this.state = 'open';
      this.probeInFlight = false;
      this.openedAtMs = this.now();
      return;
    }
    if (this.consecutiveFailures >= this.options.failureThreshold) {
      this.state = 'open';
      this.openedAtMs = this.now();
    }
  }

  /** Resets to a fresh closed state (startup/lifecycle only). */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAtMs = 0;
    this.probeInFlight = false;
  }

  private now(): number {
    return this.options.clock?.() ?? Date.now();
  }
}

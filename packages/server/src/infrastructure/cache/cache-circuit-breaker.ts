/**
 * T05 short-time circuit breaker (plan §6.4 T05 / §5).
 *
 * Guards the Redis layer so that after `failureThreshold` consecutive Redis
 * failures the breaker opens and callers stop issuing meaningless retries or
 * commands to a broken cache. After `cooldownMs` the breaker admits exactly one
 * half-open probe: if that single probe succeeds the breaker closes; if it
 * fails the breaker re-opens immediately. A probe cancelled by its client is
 * settled via `recordAbort`: the probe slot is released without counting a
 * failure (and never as a success), so the next caller probes again and a real
 * outage is still discovered.
 *
 * Isolation rules:
 * - The clock is injectable so tests advance cooldowns deterministically
 *   without real sleeps; every instance owns its own state, so no test's
 *   failure streak can pollute another.
 * - The breaker is pure coordination: it never talks to Redis, never throws
 *   from `allowRequest`, and is safe to share across all cache domains in one
 *   process (T10/T11 may also create one breaker per store).
 */
export type CacheCircuitState = 'closed' | 'open' | 'half_open';

export interface CacheCircuitBreakerOptions {
  /** Consecutive Redis failures that open the breaker (>= 1). */
  readonly failureThreshold: number;
  /** Cooldown in ms before the breaker admits a single half-open probe (>= 0). */
  readonly cooldownMs: number;
  /** Injectable clock (ms). Defaults to Date.now. */
  readonly clock?: () => number;
}

export class CacheCircuitBreaker {
  private state: CacheCircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private probeInFlight = false;

  constructor(private readonly options: CacheCircuitBreakerOptions) {
    if (!Number.isSafeInteger(options.failureThreshold) || options.failureThreshold < 1) {
      throw new Error('CacheCircuitBreaker failureThreshold must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.cooldownMs) || options.cooldownMs < 0) {
      throw new Error('CacheCircuitBreaker cooldownMs must be a non-negative safe integer');
    }
  }

  get currentState(): CacheCircuitState {
    return this.state;
  }

  get consecutiveFailureCount(): number {
    return this.consecutiveFailures;
  }

  /**
   * Returns true when a Redis command may be issued:
   * - closed: always true (and stays closed);
   * - open + cooldown elapsed: transitions to half_open, reserves the single
   *   probe and returns true for that one caller only;
   * - half_open with a probe already in flight: false (only one probe);
   * - half_open after a cancelled probe (`recordAbort` released the slot): true
   *   again — the next caller probes without waiting for a new cooldown.
   */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.now() - this.openedAtMs < this.options.cooldownMs) return false;
      this.state = 'half_open';
      this.probeInFlight = true;
      return true;
    }
    // half_open: exactly one probe at a time; a cancelled probe releases the
    // slot (recordAbort) so the next caller re-probes without a new cooldown.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  /** Records a successful Redis interaction: resets the streak and closes after a successful probe. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.probeInFlight = false;
    }
  }

  /**
   * Records a Redis failure: opens the breaker at the threshold from closed,
   * and re-opens it immediately when the single half-open probe fails.
   * Failures recorded while open are ignored (no commands are sent anyway).
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

  /**
   * Settles a half-open probe that was cancelled by the client without a
   * verdict: the probe slot is released so the next caller can probe again.
   * Cancellation is not a Redis failure — the failure streak is untouched —
   * and never a success, so a real outage is still discovered by the next
   * probe. No-op unless a half-open probe is actually in flight.
   */
  recordAbort(): void {
    if (this.state === 'half_open' && this.probeInFlight) {
      this.probeInFlight = false;
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

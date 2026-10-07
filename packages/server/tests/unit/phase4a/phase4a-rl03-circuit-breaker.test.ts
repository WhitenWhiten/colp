/**
 * P4A-RL03 independent circuit breaker (plan §8 RL03: "circuit/health：基于
 * 连续失败计数或类似机制的断路器").
 *
 * Deliberately independent from the Publication `CacheCircuitBreaker` (plan
 * §2.2.5: the rate-limit store has its own client, ACL, key namespace and fail
 * strategy; nothing may be reused from the cache layer). Semantics:
 *
 *  - after `failureThreshold` CONSECUTIVE Redis failures the breaker opens and
 *    the store stops issuing meaningless commands (fast `unavailable`);
 *  - after `cooldownMs` the breaker admits exactly ONE half-open probe; a
 *    successful probe closes the breaker, a failed probe re-opens it;
 *  - the clock is injectable so tests advance cooldowns deterministically;
 *  - the breaker is pure coordination: it never talks to Redis and never
 *    throws from `allowRequest`.
 *
 * No Redis, no timers beyond the injectable clock.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RateLimitCircuitBreaker,
  type RateLimitCircuitState,
} from '../../../src/infrastructure/rate-limit/index.js';

function makeBreaker(overrides: Partial<{ failureThreshold: number; cooldownMs: number; clock: () => number }> = {}): {
  breaker: RateLimitCircuitBreaker;
  now: { value: number };
} {
  const now = { value: 0 };
  return {
    breaker: new RateLimitCircuitBreaker({
      failureThreshold: overrides.failureThreshold ?? 3,
      cooldownMs: overrides.cooldownMs ?? 1_000,
      clock: overrides.clock ?? (() => now.value),
    }),
    now,
  };
}

test('a fresh breaker is closed and admits requests', () => {
  const { breaker } = makeBreaker();
  assert.equal(breaker.currentState, 'closed');
  assert.equal(breaker.consecutiveFailureCount, 0);
  assert.equal(breaker.allowRequest(), true);
});

test('constructor rejects invalid thresholds and cooldowns fail-closed', () => {
  assert.throws(() => new RateLimitCircuitBreaker({ failureThreshold: 0, cooldownMs: 100 }), /failureThreshold/);
  assert.throws(() => new RateLimitCircuitBreaker({ failureThreshold: 1.5, cooldownMs: 100 }), /failureThreshold/);
  assert.throws(() => new RateLimitCircuitBreaker({ failureThreshold: 1, cooldownMs: -1 }), /cooldownMs/);
  assert.throws(() => new RateLimitCircuitBreaker({ failureThreshold: 1, cooldownMs: 1.5 }), /cooldownMs/);
});

test('consecutive failures open the breaker at the threshold; successes reset the streak', () => {
  const { breaker, now } = makeBreaker({ failureThreshold: 3 });
  breaker.recordSuccess();
  breaker.recordSuccess();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'closed', 'below the threshold the breaker stays closed');
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'open', 'the third consecutive failure opens the breaker');
  assert.equal(breaker.consecutiveFailureCount, 3);
  assert.equal(breaker.allowRequest(), false, 'an open breaker refuses requests');

  // A success while open is not observed (no commands are sent), and a
  // failure while open is ignored — the open state is driven by the cooldown.
  now.value += 500;
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'open');
  assert.equal(breaker.allowRequest(), false, 'still inside the cooldown');
});

test('after the cooldown exactly one half-open probe is admitted; success closes the breaker', () => {
  const { breaker, now } = makeBreaker({ failureThreshold: 1 });
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'open');

  now.value += 999;
  assert.equal(breaker.allowRequest(), false, 'cooldown not yet elapsed');
  now.value += 1;
  assert.equal(breaker.allowRequest(), true, 'cooldown elapsed: exactly one probe is admitted');
  assert.equal(breaker.currentState, 'half_open');
  assert.equal(breaker.allowRequest(), false, 'only one probe may be in flight');

  breaker.recordSuccess();
  assert.equal(breaker.currentState, 'closed', 'a successful probe closes the breaker');
  assert.equal(breaker.consecutiveFailureCount, 0);
  assert.equal(breaker.allowRequest(), true);
});

test('a failed half-open probe re-opens the breaker immediately with a fresh cooldown', () => {
  const { breaker, now } = makeBreaker({ failureThreshold: 2, cooldownMs: 1_000 });
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'open');

  now.value += 1_000;
  assert.equal(breaker.allowRequest(), true, 'probe admitted');
  now.value += 100;
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'open', 'the failed probe re-opens the breaker');
  assert.equal(breaker.allowRequest(), false, 'the fresh cooldown starts at the probe failure');

  now.value += 999;
  assert.equal(breaker.allowRequest(), false, 'still inside the fresh cooldown');
  now.value += 1;
  assert.equal(breaker.allowRequest(), true, 'a new probe is admitted after the fresh cooldown');
});

test('reset returns a fresh closed breaker', () => {
  const { breaker, now } = makeBreaker({ failureThreshold: 1 });
  breaker.recordFailure();
  now.value += 5_000;
  assert.equal(breaker.allowRequest(), true);
  breaker.recordFailure();
  assert.equal(breaker.currentState, 'open');
  breaker.reset();
  assert.equal(breaker.currentState, 'closed');
  assert.equal(breaker.consecutiveFailureCount, 0);
  assert.equal(breaker.allowRequest(), true);
});

test('the circuit state is one of the sealed values (readiness contract)', () => {
  const { breaker } = makeBreaker();
  const states: readonly RateLimitCircuitState[] = ['closed', 'open', 'half_open'];
  assert.ok(states.includes(breaker.currentState));
});

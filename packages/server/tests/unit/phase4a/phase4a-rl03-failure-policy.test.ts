/**
 * P4A-RL03 route-specific failure policy replay (plan §2.2.2-§2.2.3, §8 RL03
 * "issue/download fail-closed 与 complete fallback 策略重放", §4.2.7).
 *
 * The policy is a PURE module (no Redis client, no timers): when the store
 * reports an infrastructure FAILURE — never a quota denial (plan §4.1.10) —
 * the route class decides the HTTP semantics:
 *
 *  - issue/download fail closed -> `unavailable` (503), no fabricated quota
 *    facts;
 *  - complete is the recovery entry for already-uploaded objects: it keeps
 *    serving through the BOUNDED in-process emergency limiter whose budget is
 *    the RL02 `completeEmergency` policy, reports `fallback` while the budget
 *    lasts and `denied` once the emergency budget is exhausted; the limiter
 *    never admits unbounded subjects (bounded map + fail-closed at capacity).
 *
 * Every decision can be REPLAYED with an injected clock, which is exactly how
 * §4.2.7-style tests pin budget exhaustion, window rollover and the
 * issue/download vs complete split without any Redis.
 *
 * No Redis, no PostgreSQL, no browser.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT,
  ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT,
} from '../../../src/modules/attachments/index.js';
import {
  EmergencyRateLimiter,
  applyRouteFailurePolicy,
  routeFailureVerdictToAdmissionOutcome,
  type RouteFailureVerdict,
} from '../../../src/infrastructure/rate-limit/index.js';
import type {
  AttachmentRateLimitConfig,
  AttachmentRateLimitDecision,
  RateLimitFailure,
} from '../../../src/modules/attachments/index.js';

const NOW_MS = 1_750_000_000_000;

function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl: 'redis://127.0.0.1:6379',
    keySecretRef: 'known/rl03/test/hmac',
    keyPrefix: 'known',
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }),
    completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: 60000 }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

const FAILURE: RateLimitFailure = Object.freeze({ class: 'timeout', code: 'rate_limit_command_timeout' });
const SUBJECT_KEY = 'known:test:ratelimit:v1:{att:subjecthmac}:complete';

function assertDecisionShape(decision: AttachmentRateLimitDecision, allowed: boolean, remaining: number): void {
  assert.equal(decision.allowed, allowed);
  assert.equal(decision.remaining, remaining);
  assert.ok(Number.isSafeInteger(decision.retryAfterSeconds) && decision.retryAfterSeconds >= 0);
  assert.ok(Number.isSafeInteger(decision.windowStartEpochMs) && decision.windowStartEpochMs >= 0);
}

// ---------------------------------------------------------------------------
// EmergencyRateLimiter: bounded in-process fixed-window budget
// ---------------------------------------------------------------------------

test('the emergency limiter enforces the RL02 completeEmergency budget and reports real decisions', () => {
  const clock = { value: NOW_MS };
  const emergency = new EmergencyRateLimiter(makeConfig({ completeEmergency: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }) }), { clock: () => clock.value });
  assert.deepEqual(emergency.budget, { routeClass: 'complete', rateMax: 2, rateWindowMs: 60000 });

  const first = emergency.check(SUBJECT_KEY);
  assert.equal(first.allowed, true);
  assert.equal(first.reason, 'within_budget');
  assertDecisionShape(first.decision, true, 1);
  assert.equal(first.decision.windowStartEpochMs, 1_749_999_960_000);

  const second = emergency.check(SUBJECT_KEY);
  assert.equal(second.allowed, true);
  assert.equal(second.reason, 'within_budget');
  assert.equal(second.decision.remaining, 0);

  const third = emergency.check(SUBJECT_KEY);
  assert.equal(third.allowed, false);
  assert.equal(third.reason, 'exhausted');
  assertDecisionShape(third.decision, false, 0);

  // A different subject has its own independent budget.
  const other = emergency.check(`${SUBJECT_KEY}:other`);
  assert.equal(other.allowed, true);
  assert.equal(other.reason, 'within_budget');
});

test('the emergency limiter rolls over into a fresh window (clock-injected, no sleeps)', () => {
  const clock = { value: NOW_MS };
  const emergency = new EmergencyRateLimiter(makeConfig({ completeEmergency: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }) }), { clock: () => clock.value });
  assert.equal(emergency.check(SUBJECT_KEY).allowed, true);
  assert.equal(emergency.check(SUBJECT_KEY).allowed, true);
  assert.equal(emergency.check(SUBJECT_KEY).allowed, false, 'budget exhausted inside the window');

  clock.value += 60_000; // deterministic rollover
  const next = emergency.check(SUBJECT_KEY);
  assert.equal(next.allowed, true, 'a new window restores the emergency budget');
  // NOW_MS is NOT window-aligned (NOW_MS mod 60_000 = 40_000), so the next
  // window starts at floor((NOW_MS + 60_000) / 60_000) * 60_000: exactly one
  // fixed window after the FIRST window start (1_749_999_960_000 + 60_000),
  // not at NOW_MS + 60_000.
  assert.equal(next.decision.windowStartEpochMs, 1_749_999_960_000 + 60_000);
  assert.equal(next.decision.remaining, 1);
});

test('the emergency limiter stays bounded: at capacity it fails closed and prunes stale windows', () => {
  const clock = { value: NOW_MS };
  const emergency = new EmergencyRateLimiter(
    makeConfig({ completeEmergency: Object.freeze({ rateMax: 5, rateWindowMs: 60000 }) }),
    { clock: () => clock.value, maxSubjects: 1 },
  );
  assert.equal(emergency.check('subject-A').allowed, true);
  const atCapacity = emergency.check('subject-B');
  assert.equal(atCapacity.allowed, false);
  assert.equal(atCapacity.reason, 'at_capacity', 'a full bounded map admits no new subject');

  // Window rollover prunes the stale entry, so a new subject is admitted again.
  clock.value += 60_000;
  assert.equal(emergency.check('subject-B').allowed, true, 'stale entries are pruned at capacity');
});

test('the emergency limiter validates its subject key and rejects unbounded constructions', () => {
  const emergency = new EmergencyRateLimiter(makeConfig());
  assert.throws(() => emergency.check(''), /subjectKey/);
  assert.throws(() => emergency.check('x'.repeat(513)), /subjectKey/);
  assert.throws(() => new EmergencyRateLimiter(makeConfig(), { maxSubjects: 0 }), /maxSubjects/);
  assert.throws(() => new EmergencyRateLimiter(makeConfig(), { maxSubjects: 1.5 }), /maxSubjects/);
  const unbounded = makeConfig({ completeEmergency: Object.freeze({ rateMax: 1001, rateWindowMs: 60000 }) });
  assert.throws(() => new EmergencyRateLimiter(unbounded), /emergency/);
  // Defaults follow the RL02 suggested config contract.
  assert.equal(ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT, 15);
  assert.equal(ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT, 60000);
});

// ---------------------------------------------------------------------------
// applyRouteFailurePolicy: replayable route split (plan §2.2.2-§2.2.3)
// ---------------------------------------------------------------------------

test('issue, download and status fail closed on every infrastructure failure (503), never denied', () => {
  const emergency = new EmergencyRateLimiter(makeConfig(), { clock: () => NOW_MS });
  for (const routeClass of ['issue', 'download', 'status'] as const) {
    const verdict = applyRouteFailurePolicy({
      routeClass,
      failure: FAILURE,
      emergency,
      subjectKey: SUBJECT_KEY,
      nowEpochMs: NOW_MS,
    });
    assert.deepEqual(verdict, { kind: 'fail_closed', failure: FAILURE }, `${routeClass} must fail closed`);
  }
});

test('complete replays: bounded emergency fallback, budget exhaustion, then window recovery (§4.2.7)', () => {
  const clock = { value: NOW_MS };
  const emergency = new EmergencyRateLimiter(makeConfig({ completeEmergency: Object.freeze({ rateMax: 2, rateWindowMs: 60000 }) }), { clock: () => clock.value });
  const input = { failure: FAILURE, emergency, subjectKey: SUBJECT_KEY, nowEpochMs: NOW_MS };

  const first = applyRouteFailurePolicy({ routeClass: 'complete', ...input });
  assert.equal(first.kind, 'fallback_allowed', 'complete falls back while the emergency budget lasts');
  if (first.kind === 'fallback_allowed') {
    assert.equal(first.failure, FAILURE);
    assertDecisionShape(first.decision, true, 1);
  }

  const second = applyRouteFailurePolicy({ routeClass: 'complete', ...input });
  assert.equal(second.kind, 'fallback_allowed');
  if (second.kind === 'fallback_allowed') assert.equal(second.decision.remaining, 0);

  const third = applyRouteFailurePolicy({ routeClass: 'complete', ...input });
  assert.equal(third.kind, 'fallback_denied', 'the emergency budget exhaustion is a real local quota fact');
  if (third.kind === 'fallback_denied') {
    assertDecisionShape(third.decision, false, 0);
    assert.equal(third.failure, FAILURE, 'the Redis failure stays observable in the verdict');
  }

  const recovered = applyRouteFailurePolicy({ routeClass: 'complete', ...input, nowEpochMs: NOW_MS + 60_000 });
  assert.equal(recovered.kind, 'fallback_allowed', 'the next window restores the bounded fallback');
});

test('complete at emergency capacity fails closed instead of admitting unbounded subjects', () => {
  const emergency = new EmergencyRateLimiter(
    makeConfig({ completeEmergency: Object.freeze({ rateMax: 5, rateWindowMs: 60000 }) }),
    { clock: () => NOW_MS, maxSubjects: 1 },
  );
  assert.equal(emergency.check('subject-A').allowed, true);
  const verdict = applyRouteFailurePolicy({ routeClass: 'complete', failure: FAILURE, emergency, subjectKey: 'subject-B', nowEpochMs: NOW_MS });
  assert.deepEqual(verdict, { kind: 'fail_closed', failure: FAILURE });
});

test('an unknown route class fails closed at runtime (defensive, sealed union is compile-time)', () => {
  const emergency = new EmergencyRateLimiter(makeConfig(), { clock: () => NOW_MS });
  const verdict = applyRouteFailurePolicy({
    routeClass: 'admin' as never,
    failure: FAILURE,
    emergency,
    subjectKey: SUBJECT_KEY,
    nowEpochMs: NOW_MS,
  });
  assert.deepEqual(verdict, { kind: 'fail_closed', failure: FAILURE });
});

// ---------------------------------------------------------------------------
// Verdict -> RL02 AttachmentAdmissionOutcome mapping (RL04 composition input)
// ---------------------------------------------------------------------------

test('verdicts map 1:1 onto the sealed admission outcome kinds', () => {
  const decision: AttachmentRateLimitDecision = { allowed: true, remaining: 14, retryAfterSeconds: 30, windowStartEpochMs: 0 };
  const verdicts: ReadonlyArray<{ verdict: RouteFailureVerdict; kind: 'unavailable' | 'fallback' | 'denied' }> = [
    { verdict: { kind: 'fail_closed', failure: FAILURE }, kind: 'unavailable' },
    { verdict: { kind: 'fallback_allowed', decision, failure: FAILURE }, kind: 'fallback' },
    { verdict: { kind: 'fallback_denied', decision, failure: FAILURE }, kind: 'denied' },
  ];
  for (const { verdict, kind } of verdicts) {
    const outcome = routeFailureVerdictToAdmissionOutcome(verdict, 'enforce');
    assert.equal(outcome.kind, kind);
    assert.equal(outcome.mode, 'enforce');
  }
  const unavailable = routeFailureVerdictToAdmissionOutcome({ kind: 'fail_closed', failure: FAILURE }, 'shadow');
  assert.deepEqual(unavailable, { kind: 'unavailable', mode: 'shadow', failure: FAILURE });
  const fallback = routeFailureVerdictToAdmissionOutcome({ kind: 'fallback_allowed', decision, failure: FAILURE }, 'enforce');
  assert.deepEqual(fallback, { kind: 'fallback', mode: 'enforce', decision, failure: FAILURE });
  const denied = routeFailureVerdictToAdmissionOutcome({ kind: 'fallback_denied', decision, failure: FAILURE }, 'enforce');
  assert.deepEqual(denied, { kind: 'denied', mode: 'enforce', decision });
});

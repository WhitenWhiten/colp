/**
 * P4A-RL02 route policy and decision classification contract (plan §2.2.2-
 * §2.2.4 failure semantics + §4.1.10 "503 vs 429" distinction + §8 RL02
 * test scope).
 *
 * The three route classes (issue, complete, download admission) each have a
 * fixed budget/window; `complete` additionally carries a BOUNDED in-process
 * emergency budget (15/60000) so a Redis outage can never turn into an
 * unbounded admission. The pure functions here pin the fixed-window math
 * (window rounding and retry-after) that the RL03 Lua adapter and the RL04
 * composition will reuse, and the outcome classifier keeps `exhausted`
 * (quota fact -> 429) strictly separate from `unavailable` (infrastructure
 * fact -> 503): an error can never be classified as a quota exhaustion.
 *
 * No Redis, no PostgreSQL, no browser.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT,
  ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_DOWNLOAD_RATE_MAX_DEFAULT,
  ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING,
  ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING,
  ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS,
  ATTACHMENTS_STATUS_RATE_MAX_DEFAULT,
  ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX_DEFAULT,
  ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS_DEFAULT,
  ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX_DEFAULT,
  ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS_DEFAULT,
  assertRateLimitPolicyBounded,
  emergencyFallbackPolicy,
  parseAttachmentRateLimitConfig,
  rateLimitOutcomeClass,
  resolveRouteRatePolicy,
  retryAfterSecondsFor,
  windowStartFor,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitDecision,
  type AttachmentRouteRatePolicy,
  type RateLimitStoreOutcome,
} from '../../../src/modules/attachments/index.js';

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ATTACHMENTS_RATE_LIMIT_MODE: 'enforce',
    ATTACHMENTS_RATE_LIMIT_REQUIRED: 'true',
    ATTACHMENTS_RATE_LIMIT_REDIS_URL: 'rediss://redis.internal:6379',
    ATTACHMENTS_RATE_LIMIT_KEY_SECRET: 'known/rl02/key/hmac',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl: 'rediss://redis.internal:6379',
    keySecretRef: 'known/rl02/key/hmac',
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

function decision(overrides: Partial<AttachmentRateLimitDecision> = {}): AttachmentRateLimitDecision {
  return { allowed: false, remaining: 0, retryAfterSeconds: 30, windowStartEpochMs: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// Route budget resolution
// ---------------------------------------------------------------------------

test('each route class resolves its own budget and window from the config', () => {
  const config = parseAttachmentRateLimitConfig(validEnv());
  assert.deepEqual(resolveRouteRatePolicy(config, 'issue'), {
    routeClass: 'issue', rateMax: 30, rateWindowMs: 60000,
  });
  assert.deepEqual(resolveRouteRatePolicy(config, 'complete'), {
    routeClass: 'complete', rateMax: 60, rateWindowMs: 60000,
  });
  assert.deepEqual(resolveRouteRatePolicy(config, 'download'), {
    routeClass: 'download', rateMax: 30, rateWindowMs: 60000,
  });
  // FIX-L-051: the status read resolves its own budget (KA-P4-AM-16).
  assert.deepEqual(resolveRouteRatePolicy(config, 'status'), {
    routeClass: 'status', rateMax: 60, rateWindowMs: 60000,
  });
  // The plan §2.3 defaults are pinned.
  assert.equal(ATTACHMENTS_UPLOAD_ISSUE_RATE_MAX_DEFAULT, 30);
  assert.equal(ATTACHMENTS_UPLOAD_ISSUE_RATE_WINDOW_MS_DEFAULT, 60000);
  assert.equal(ATTACHMENTS_UPLOAD_COMPLETE_RATE_MAX_DEFAULT, 60);
  assert.equal(ATTACHMENTS_UPLOAD_COMPLETE_RATE_WINDOW_MS_DEFAULT, 60000);
  assert.equal(ATTACHMENTS_DOWNLOAD_RATE_MAX_DEFAULT, 30);
  assert.equal(ATTACHMENTS_DOWNLOAD_RATE_WINDOW_MS_DEFAULT, 60000);
  assert.equal(ATTACHMENTS_STATUS_RATE_MAX_DEFAULT, 60);
  assert.equal(ATTACHMENTS_STATUS_RATE_WINDOW_MS_DEFAULT, 60000);
});

test('an unknown route class is rejected at runtime (fail closed)', () => {
  const config = parseAttachmentRateLimitConfig(validEnv());
  assert.throws(() => resolveRouteRatePolicy(config, 'admin' as never), /unknown rate-limit route class/);
});

test('a tampered budget is rejected at policy resolution time (fail closed)', () => {
  const config = makeConfig({
    routes: { ...makeConfig().routes, issue: { rateMax: 10001, rateWindowMs: 60000 } },
  });
  assert.throws(() => resolveRouteRatePolicy(config, 'issue'), /rateMax/);
  const configWindow = makeConfig({
    routes: { ...makeConfig().routes, download: { rateMax: 30, rateWindowMs: 3600001 } },
  });
  assert.throws(() => resolveRouteRatePolicy(configWindow, 'download'), /rateWindowMs/);
});

test('budgets are bounded by the compile-time ceilings', () => {
  assert.equal(ATTACHMENTS_RATE_LIMIT_RATE_MAX_HARD_CEILING, 10000);
  assert.equal(ATTACHMENTS_RATE_LIMIT_RATE_WINDOW_MAX_MS, 3600000);
  assert.doesNotThrow(() => assertRateLimitPolicyBounded(30, 60000, 'issue'));
  for (const [rateMax, rateWindowMs] of [
    [0, 60000],
    [-1, 60000],
    [10001, 60000],
    [30.5, 60000],
    [30, 0],
    [30, -1],
    [30, 3600001],
    [30, 60000.5],
  ] as const) {
    assert.throws(() => assertRateLimitPolicyBounded(rateMax, rateWindowMs, 'issue'), /safe integer|between/, `${rateMax}/${rateWindowMs} must fail`);
  }
});

// ---------------------------------------------------------------------------
// Complete emergency fallback budget (bounded in-process limiter policy)
// ---------------------------------------------------------------------------

test('complete carries a bounded emergency fallback budget', () => {
  const config = parseAttachmentRateLimitConfig(validEnv());
  const emergency = emergencyFallbackPolicy(config) as AttachmentRouteRatePolicy;
  assert.deepEqual(emergency, { routeClass: 'complete', rateMax: 15, rateWindowMs: 60000 });
  assert.equal(ATTACHMENTS_COMPLETE_EMERGENCY_RATE_MAX_DEFAULT, 15);
  assert.equal(ATTACHMENTS_COMPLETE_EMERGENCY_RATE_WINDOW_MS_DEFAULT, 60000);
  assert.equal(ATTACHMENTS_RATE_LIMIT_EMERGENCY_RATE_MAX_HARD_CEILING, 1000);
});

test('an unbounded emergency budget is rejected (emergency must stay bounded)', () => {
  const over = makeConfig({ completeEmergency: { rateMax: 1001, rateWindowMs: 60000 } });
  assert.throws(() => emergencyFallbackPolicy(over), /emergency/);
  const windowOver = makeConfig({ completeEmergency: { rateMax: 15, rateWindowMs: 3600001 } });
  assert.throws(() => emergencyFallbackPolicy(windowOver), /emergency|window/);
  const unsafe = makeConfig({ completeEmergency: { rateMax: 15.5, rateWindowMs: 60000 } });
  assert.throws(() => emergencyFallbackPolicy(unsafe), /emergency/);
});

// ---------------------------------------------------------------------------
// Fixed-window math (the rounding rule RL03's Lua and RL04 reuse)
// ---------------------------------------------------------------------------

test('window start is floor(now / windowMs) * windowMs', () => {
  assert.equal(windowStartFor(0, 60000), 0);
  assert.equal(windowStartFor(59999, 60000), 0);
  assert.equal(windowStartFor(60000, 60000), 60000);
  assert.equal(windowStartFor(1_750_000_000_123, 60000), 1_749_999_960_000);
  assert.equal(windowStartFor(1_234, 1_000), 1_000);
  assert.throws(() => windowStartFor(-1, 60000), /non-negative safe integer/);
  assert.throws(() => windowStartFor(1.5, 60000), /non-negative safe integer/);
  assert.throws(() => windowStartFor(0, 0), /positive safe integer/);
  assert.throws(() => windowStartFor(0, 60000.5), /positive safe integer/);
});

test('retry-after is the ceil of seconds to window rollover, 0 at rollover', () => {
  assert.equal(retryAfterSecondsFor(0, 60000, 30_000), 30);
  assert.equal(retryAfterSecondsFor(0, 60000, 1), 60);
  assert.equal(retryAfterSecondsFor(0, 60000, 59_999), 1);
  assert.equal(retryAfterSecondsFor(0, 60000, 60_000), 0);
  assert.equal(retryAfterSecondsFor(0, 60000, 60_001), 0);
  assert.equal(retryAfterSecondsFor(0, 1_000, 500), 1);
  assert.equal(retryAfterSecondsFor(0, 1_000, 999), 1);
  assert.equal(retryAfterSecondsFor(1_749_999_960_000, 60000, 1_749_999_990_000), 30);
  assert.throws(() => retryAfterSecondsFor(-1, 60000, 0), RangeError);
  assert.throws(() => retryAfterSecondsFor(0, 0, 0), RangeError);
});

// ---------------------------------------------------------------------------
// exhausted (quota fact) vs unavailable (infrastructure fact) — plan §4.1.10
// ---------------------------------------------------------------------------

test('a denied decision is classified as exhausted, never unavailable', () => {
  const denied: RateLimitStoreOutcome = {
    kind: 'denied',
    decision: decision({ allowed: false, remaining: 0 }),
  };
  assert.equal(rateLimitOutcomeClass(denied), 'exhausted');
});

test('every failure class is classified as unavailable, never exhausted', () => {
  for (const failureClass of ['unavailable', 'timeout', 'malformed', 'acl', 'internal'] as const) {
    const failed: RateLimitStoreOutcome = { kind: 'failed', failure: { class: failureClass, code: `rate_limit_${failureClass}` } };
    assert.equal(rateLimitOutcomeClass(failed), 'unavailable', `${failureClass} must map to unavailable`);
  }
});

test('allowed and complete-emergency fallback outcomes proceed (allowed-equivalent)', () => {
  const allowed: RateLimitStoreOutcome = {
    kind: 'allowed',
    decision: decision({ allowed: true, remaining: 29 }),
  };
  assert.equal(rateLimitOutcomeClass(allowed), 'allowed');
  const fallback = {
    kind: 'fallback' as const,
    mode: 'enforce' as const,
    decision: decision({ allowed: true, remaining: 14 }),
    failure: { class: 'timeout' as const, code: 'rate_limit_timeout' },
  };
  assert.equal(rateLimitOutcomeClass(fallback), 'allowed');
});

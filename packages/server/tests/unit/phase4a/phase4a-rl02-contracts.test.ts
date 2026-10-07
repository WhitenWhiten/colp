/**
 * P4A-RL02 distributed rate-limit PORT/contract surface (plan §2.2.5
 * independent RateLimitStore port + §8 RL02 "application/domain never
 * depends on ioredis types" + P01 frozen header contract).
 *
 * The contract layer is pure: `RateLimitStore` and
 * `AttachmentAdmissionRateLimiter` are structural ports that any adapter
 * (RL03 Redis or a mock) satisfies without ioredis types leaking into the
 * domain; the sealed unions (route classes, modes, failure classes) and the
 * readiness evaluator are exercised through typed mocks; the header mapping
 * freezes the P01 semantics — 429 carries Retry-After + RateLimit-Policy,
 * 503 `rate_limit_unavailable` carries NO fabricated Retry-After/RateLimit
 * quota fact, and allowed/fallback responses carry no quota headers.
 *
 * A source scan proves the RL02 contract files never import ioredis and
 * never reuse the CacheStore (`infrastructure/cache`) code: the rate-limit
 * lifecycle is fully orthogonal to KNOWN_CACHE_MODE.
 *
 * No Redis, no PostgreSQL, no browser.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS,
  ATTACHMENT_RATE_LIMIT_MODES,
  ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES,
  RATE_LIMIT_FAILURE_CLASSES,
  RATE_LIMIT_HEADER_RATE_LIMIT_POLICY,
  RATE_LIMIT_HEADER_RETRY_AFTER,
  admissionOutcomeMetricDecision,
  assertAttachmentRateLimitDecision,
  assertRateLimitStoreReadinessShape,
  evaluateAttachmentRateLimitReadiness,
  formatRateLimitPolicyHeader,
  mapRateLimitAdmissionToHttp,
  parseAttachmentRateLimitConfig,
  resolveRouteRatePolicy,
  type AttachmentAdmissionOutcome,
  type AttachmentAdmissionRateLimiter,
  type AttachmentRateLimitDecision,
  type RateLimitCheckInput,
  type RateLimitStore,
  type RateLimitStoreReadiness,
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

function decision(overrides: Partial<AttachmentRateLimitDecision> = {}): AttachmentRateLimitDecision {
  return { allowed: true, remaining: 29, retryAfterSeconds: 0, windowStartEpochMs: 0, ...overrides };
}

// ---------------------------------------------------------------------------
// Port shapes: structural, mockable, and free of ioredis types
// ---------------------------------------------------------------------------

test('a plain in-memory mock satisfies the RateLimitStore port (allowed/denied/failed)', async () => {
  let closed = 0;
  let lastInput: RateLimitCheckInput | undefined;
  const store: RateLimitStore = {
    async check(input) {
      lastInput = input;
      if (input.routeClass === 'issue') {
        return { kind: 'allowed', decision: decision() };
      }
      if (input.routeClass === 'complete') {
        return { kind: 'denied', decision: decision({ allowed: false, remaining: 0, retryAfterSeconds: 17 }) };
      }
      return { kind: 'failed', failure: { class: 'timeout', code: 'rate_limit_timeout' } };
    },
    readiness() {
      return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: 0 };
    },
    async close() {
      closed += 1;
    },
  };
  const allowed = await store.check({ routeClass: 'issue', subject: { principalId: 'p-1', scope: 'c-1' } });
  assert.equal(allowed.kind, 'allowed');
  const denied = await store.check({ routeClass: 'complete', subject: { principalId: 'p-1', scope: 'c-1' } });
  assert.equal(denied.kind, 'denied');
  const failed = await store.check({ routeClass: 'download', subject: { principalId: 'p-1', scope: 'c-1' } });
  assert.equal(failed.kind, 'failed');
  assert.equal(lastInput?.subject.principalId, 'p-1');
  await store.close();
  await store.close();
  assert.ok(closed >= 1, 'close must be callable more than once (idempotent)');
  assertRateLimitStoreReadinessShape(store.readiness());
});

test('a typed mock satisfies the AttachmentAdmissionRateLimiter facade port', async () => {
  const limiter: AttachmentAdmissionRateLimiter = {
    mode: 'enforce',
    async checkAdmission(input) {
      if (input.routeClass === 'download') {
        return {
          kind: 'unavailable',
          mode: 'enforce',
          failure: { class: 'unavailable', code: 'rate_limit_unavailable' },
        };
      }
      return { kind: 'allowed', mode: 'enforce', decision: decision() };
    },
    readiness() {
      return { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: 42 };
    },
    async close() { /* no-op */ },
  };
  const outcome = await limiter.checkAdmission({ routeClass: 'download', subject: { principalId: 'p-1', scope: 'c-1' } });
  assert.equal(outcome.kind, 'unavailable');
  assert.equal(limiter.mode, 'enforce');
});

test('decision values are validated (remaining/retryAfter/windowStart must be non-negative safe integers)', () => {
  assert.doesNotThrow(() => assertAttachmentRateLimitDecision(decision()));
  for (const bad of [
    { ...decision(), remaining: -1 },
    { ...decision(), remaining: 1.5 },
    { ...decision(), retryAfterSeconds: -1 },
    { ...decision(), retryAfterSeconds: 1.5 },
    { ...decision(), windowStartEpochMs: -1 },
    { ...decision(), windowStartEpochMs: 1.5 },
  ]) {
    assert.throws(() => assertAttachmentRateLimitDecision(bad as AttachmentRateLimitDecision), /rate_limit_decision/);
  }
});

// ---------------------------------------------------------------------------
// Sealed unions
// ---------------------------------------------------------------------------

test('route classes, modes and failure classes are sealed fixed sets', () => {
  // FIX-L-051: `status` is the owner-private read class (KA-P4-AM-16).
  assert.deepEqual(ATTACHMENT_RATE_LIMIT_ROUTE_CLASSES, ['issue', 'complete', 'download', 'status']);
  assert.deepEqual(ATTACHMENT_RATE_LIMIT_MODES, ['off', 'shadow', 'enforce']);
  assert.deepEqual(RATE_LIMIT_FAILURE_CLASSES, ['unavailable', 'timeout', 'malformed', 'acl', 'internal']);
  // `exhausted` is a quota decision, NOT an infrastructure failure class:
  // conflating the two would let an outage masquerade as a 429 (§4.1.10).
  assert.equal(RATE_LIMIT_FAILURE_CLASSES.includes('exhausted' as never), false);
});

test('admission outcomes map onto the RL01 sealed metric dimension', () => {
  const kinds = ['allowed', 'denied', 'unavailable', 'fallback'] as const;
  const expected = ['allowed', 'denied', 'unavailable', 'fallback'] as const;
  for (let index = 0; index < kinds.length; index += 1) {
    const dimension = admissionOutcomeMetricDecision({ kind: kinds[index] });
    assert.equal(dimension, expected[index]);
    assert.ok(ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS.includes(dimension), 'must be one of the sealed RL01 dimensions');
  }
});

// ---------------------------------------------------------------------------
// Readiness contract shape and evaluation (mockable store states)
// ---------------------------------------------------------------------------

test('the store readiness shape is fail-closed: unknown status/reason/timestamp rejected', () => {
  const valid: RateLimitStoreReadiness = { status: 'healthy', reason: 'none', lastCheckedAtEpochMs: 0 };
  assert.doesNotThrow(() => assertRateLimitStoreReadinessShape(valid));
  for (const bad of [
    { ...valid, status: 'unknown' },
    { ...valid, status: 'degraded', reason: 'something_else' },
    { ...valid, reason: '' },
    { ...valid, lastCheckedAtEpochMs: -1 },
    { ...valid, lastCheckedAtEpochMs: 1.5 },
  ]) {
    assert.throws(() => assertRateLimitStoreReadinessShape(bad as RateLimitStoreReadiness), /rate_limit_store_readiness/);
  }
});

test('mode off is always healthy; a healthy store keeps every mode healthy', () => {
  for (const mode of ['off', 'shadow', 'enforce'] as const) {
    const off = evaluateAttachmentRateLimitReadiness({ mode: 'off', required: false, storeStatus: 'degraded' });
    assert.deepEqual(off, { status: 'healthy', blocksAttachments: false, reason: 'none' });
    const healthy = evaluateAttachmentRateLimitReadiness({ mode, required: true, storeStatus: 'healthy' });
    assert.deepEqual(healthy, { status: 'healthy', blocksAttachments: false, reason: 'none' });
  }
});

test('a degraded store degrades shadow/enforce; only enforce+required blocks attachments', () => {
  const shadow = evaluateAttachmentRateLimitReadiness({ mode: 'shadow', required: false, storeStatus: 'degraded' });
  assert.deepEqual(shadow, { status: 'degraded', blocksAttachments: false, reason: 'redis_unavailable' });
  const enforceOptional = evaluateAttachmentRateLimitReadiness({ mode: 'enforce', required: false, storeStatus: 'degraded' });
  assert.deepEqual(enforceOptional, { status: 'degraded', blocksAttachments: false, reason: 'redis_unavailable' });
  const enforceRequired = evaluateAttachmentRateLimitReadiness({ mode: 'enforce', required: true, storeStatus: 'degraded' });
  assert.deepEqual(enforceRequired, { status: 'degraded', blocksAttachments: true, reason: 'redis_unavailable' });
});

// ---------------------------------------------------------------------------
// Header mapping contract (P01 frozen semantics; RL02 pure functions)
// ---------------------------------------------------------------------------

test('429 maps Retry-After and the fixed RateLimit-Policy header, never quota on 503', () => {
  const config = parseAttachmentRateLimitConfig(validEnv());
  const issuePolicy = resolveRouteRatePolicy(config, 'issue');

  const denied: AttachmentAdmissionOutcome = {
    kind: 'denied',
    mode: 'enforce',
    decision: decision({ allowed: false, remaining: 0, retryAfterSeconds: 17, windowStartEpochMs: 0 }),
  };
  const mapped429 = mapRateLimitAdmissionToHttp(denied, issuePolicy);
  assert.equal(mapped429.status, 429);
  assert.equal(mapped429.headers[RATE_LIMIT_HEADER_RETRY_AFTER], '17');
  assert.equal(mapped429.headers[RATE_LIMIT_HEADER_RATE_LIMIT_POLICY], 'attachments-issue:30:60000');
  assert.deepEqual(Object.keys(mapped429.headers).sort(), ['RateLimit-Policy', 'Retry-After']);

  const unavailable: AttachmentAdmissionOutcome = {
    kind: 'unavailable',
    mode: 'enforce',
    failure: { class: 'unavailable', code: 'rate_limit_unavailable' },
  };
  const mapped503 = mapRateLimitAdmissionToHttp(unavailable, issuePolicy);
  assert.equal(mapped503.status, 503);
  assert.deepEqual(mapped503.headers, {});
  // Even if the failure payload mentions Retry-After-like text, the 503 must
  // not fabricate a quota fact.
  const weirdFailure: AttachmentAdmissionOutcome = {
    kind: 'unavailable',
    mode: 'enforce',
    failure: { class: 'timeout', code: 'retry-after:999' },
  };
  const mapped503b = mapRateLimitAdmissionToHttp(weirdFailure, issuePolicy);
  assert.equal(mapped503b.status, 503);
  assert.deepEqual(mapped503b.headers, {});
});

test('allowed and complete-emergency fallback responses carry no quota headers', () => {
  const config = parseAttachmentRateLimitConfig(validEnv());
  const completePolicy = resolveRouteRatePolicy(config, 'complete');
  const allowed: AttachmentAdmissionOutcome = {
    kind: 'allowed',
    mode: 'shadow',
    decision: decision(),
  };
  const mapped = mapRateLimitAdmissionToHttp(allowed, completePolicy);
  assert.equal(mapped.status, undefined);
  assert.deepEqual(mapped.headers, {});
  const fallback: AttachmentAdmissionOutcome = {
    kind: 'fallback',
    mode: 'enforce',
    decision: decision({ remaining: 14 }),
    failure: { class: 'timeout', code: 'rate_limit_timeout' },
  };
  const mappedFallback = mapRateLimitAdmissionToHttp(fallback, completePolicy);
  assert.equal(mappedFallback.status, undefined);
  assert.deepEqual(mappedFallback.headers, {});
});

test('RateLimit-Policy is formatted per the frozen OpenAPI pattern', () => {
  assert.equal(formatRateLimitPolicyHeader('issue', 30, 60000), 'attachments-issue:30:60000');
  assert.equal(formatRateLimitPolicyHeader('complete', 60, 60000), 'attachments-complete:60:60000');
  assert.equal(formatRateLimitPolicyHeader('download', 30, 60000), 'attachments-download:30:60000');
  for (const value of [
    formatRateLimitPolicyHeader('issue', 30, 60000),
    formatRateLimitPolicyHeader('complete', 60, 60000),
    formatRateLimitPolicyHeader('download', 30, 60000),
  ]) {
    assert.match(value, /^attachments-[a-z-]+:[0-9]+:[0-9]+$/u);
  }
  assert.throws(() => formatRateLimitPolicyHeader('admin' as never, 30, 60000), RangeError);
  assert.throws(() => formatRateLimitPolicyHeader('issue', 10001, 60000), RangeError);
  assert.throws(() => formatRateLimitPolicyHeader('issue', 30, 3600001), RangeError);
});

// ---------------------------------------------------------------------------
// CacheStore orthogonality + no ioredis in the domain contract layer
// ---------------------------------------------------------------------------

/** The five RL02 contract files (nothing else may carry the contract layer). */
const RL02_CONTRACT_SOURCE_FILES = [
  'rate-limit-contracts.ts',
  'rate-limit-config.ts',
  'rate-limit-key-codec.ts',
  'rate-limit-route-policy.ts',
  'rate-limit-header-mapping.ts',
] as const;

test('RL02 contract files never import ioredis and never reuse the CacheStore', () => {
  for (const file of RL02_CONTRACT_SOURCE_FILES) {
    const source = readFileSync(new URL(`../../../src/modules/attachments/${file}`, import.meta.url), 'utf8');
    assert.ok(!source.includes("from 'ioredis'"), `${file} must not import ioredis`);
    assert.ok(!source.includes('from "ioredis"'), `${file} must not import ioredis`);
    assert.ok(!source.includes('infrastructure/cache'), `${file} must not reuse CacheStore code`);
    assert.ok(!source.includes('KNOWN_CACHE_MODE'), `${file} must stay orthogonal to KNOWN_CACHE_MODE`);
  }
});

test('RL02 contract files import only module-layer or node builtins', () => {
  for (const file of RL02_CONTRACT_SOURCE_FILES) {
    const source = readFileSync(new URL(`../../../src/modules/attachments/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/^import\s+[\s\S]*?from '([^']+)'/gmu)) {
      const specifier = match[1]!;
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('node:'),
        `${file} must only import sibling module files or node builtins, got '${specifier}'`,
      );
    }
  }
});

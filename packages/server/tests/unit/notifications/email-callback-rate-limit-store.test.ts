/**
 * FIX-L-061 trusted-IP ingress budget for the email callback surface
 * (audit KA-P5-SOC-16).
 *
 * The suite pins, from the bottom up:
 *
 *  - the HMAC key codec: the `ip` policy namespace is hash-tagged
 *    `{ecb:<hmac>}` so a raw client IP can NEVER reach the key text, and
 *    fail-closed subject validation (policy/length/control characters);
 *  - the bounded in-memory adapter (single-instance default): per-IP fixed
 *    windows, denied decisions with retry-after, window rollover, the
 *    max-bucket overload policy and default-budget sizing that leaves
 *    legitimate provider retries ample headroom;
 *  - the shared Redis adapter (multi-replica) over a scripted client:
 *    frozen-Lua reply mapping (allowed/denied with retry-after), codec keys
 *    at the wire, stable failure classification, the consecutive-failure
 *    circuit breaker, NOSCRIPT reload/retry and idempotent close.
 *
 * Real Redis atomicity/TTL/multi-instance sharing is proven by the RL03/RL05
 * Redis suites; this file uses the scripted-client unit scope of the
 * FIX-L-049 delivery store suite.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  type EmailCallbackRateLimiter,
  type EmailCallbackRateLimitOutcome,
} from '../../../src/modules/notifications/index.js';
import {
  EMAIL_CALLBACK_RATE_LIMIT_IP_MAX_DEFAULT,
  EMAIL_CALLBACK_RATE_LIMIT_IP_WINDOW_MS_DEFAULT,
} from '../../../src/modules/notifications/index.js';
import {
  buildEmailCallbackRateLimitKey,
  createMemoryEmailCallbackRateLimiter,
  createRedisEmailCallbackRateLimiter,
  emailCallbackRateLimitSubjectHmac,
  parseEmailCallbackRateLimitKey,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';

const ENVIRONMENT = 'test';
const KEY_PREFIX = 'l061-unit';
const KEY_SECRET = Buffer.from('l061-unit-hmac-secret-0123456789abcdef', 'utf8');
const WINDOW_MS = 60_000;
const NOW_MS = 1_750_000_000_000;
const WINDOW_START = Math.floor(NOW_MS / WINDOW_MS) * WINDOW_MS;
const IP_A = '203.0.113.10';
const IP_B = '198.51.100.20';

function keyFor(facts: string, windowStartEpochMs = WINDOW_START): string {
  return buildEmailCallbackRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    facts,
    windowStartEpochMs,
  });
}

function assertFailed(outcome: EmailCallbackRateLimitOutcome, failureClass: string, code: string): void {
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.failure.class, failureClass, `expected failure class ${failureClass}`);
  assert.equal(outcome.failure.code, code);
}

// ---------------------------------------------------------------------------
// Key codec
// ---------------------------------------------------------------------------

describe('FIX-L-061 email callback request-limit key codec', () => {
  test('keys are canonical ip-policy keys whose subject is a hash-tagged {ecb:<hmac>} digest', () => {
    const key = keyFor(IP_A);
    const parsed = parseEmailCallbackRateLimitKey(key);
    assert.equal(parsed.kind, 'ok');
    if (parsed.kind !== 'ok') return;
    assert.equal(parsed.parts.keyPrefix, KEY_PREFIX);
    assert.equal(parsed.parts.environment, ENVIRONMENT);
    assert.equal(parsed.parts.schemaVersion, 1);
    assert.equal(parsed.parts.policy, 'ip');
    assert.equal(parsed.parts.subjectHmac, emailCallbackRateLimitSubjectHmac(KEY_SECRET, IP_A));
    assert.equal(parsed.parts.windowStartEpochMs, WINDOW_START);
    // The raw client IP never reaches the key text.
    assert.equal(key.includes(IP_A), false, 'raw facts never reach the key text');
    assert.equal(key.includes(KEY_SECRET.toString('utf8')), false);
    assert.match(key, /^l061-unit:test:ratelimit:v1:\{ecb:[A-Za-z0-9_-]{32}\}:ip:\d+$/u);
  });

  test('the same subject+window is stable; a different window seed changes the key', () => {
    assert.equal(keyFor(IP_A), keyFor(IP_A));
    assert.notEqual(keyFor(IP_A), keyFor(IP_A, WINDOW_START + WINDOW_MS));
    assert.notEqual(keyFor(IP_A), keyFor(IP_B), 'different IPs are different buckets');
  });

  test('fail-closed subject validation: empty/oversized/control-character facts', () => {
    assert.throws(() => emailCallbackRateLimitSubjectHmac(KEY_SECRET, ''), /facts/u);
    assert.throws(() => emailCallbackRateLimitSubjectHmac(KEY_SECRET, 'x'.repeat(65)), /facts/u);
    assert.throws(() => emailCallbackRateLimitSubjectHmac(KEY_SECRET, `${IP_A}\n`), /control/u);
    assert.throws(() => keyFor(IP_A, -1), /window/u);
    // An IPv6 literal is <= 45 chars and must be admitted (the ip ceiling is 64).
    assert.equal(emailCallbackRateLimitSubjectHmac(
      KEY_SECRET, '2001:db8::1234:5678:9abc:def0:1234').length, 32);
  });

  test('the parser rejects non-canonical keys (raw facts can never pass as the subject segment)', () => {
    assert.equal(parseEmailCallbackRateLimitKey(keyFor(IP_A)).kind, 'ok');
    assert.equal(parseEmailCallbackRateLimitKey(keyFor(IP_A).replace('{ecb:', '{dlv:')).kind, 'rejected');
    assert.equal(parseEmailCallbackRateLimitKey(
      `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{ecb:${'a'.repeat(32)}}:token:${WINDOW_START}`,
    ).kind, 'rejected', 'only the sealed ip policy token is admitted');
    assert.equal(parseEmailCallbackRateLimitKey(
      `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{ecb:${IP_A}}:ip:${WINDOW_START}`,
    ).kind, 'rejected', 'raw facts in the subject segment are non-canonical');
    assert.equal(parseEmailCallbackRateLimitKey('').kind, 'rejected');
  });
});

// ---------------------------------------------------------------------------
// In-memory adapter (single-instance default)
// ---------------------------------------------------------------------------

describe('FIX-L-061 in-memory adapter', () => {
  function clock(): { readonly now: () => number; advance(ms: number): void } {
    let value = NOW_MS;
    return {
      now: () => value,
      advance(ms: number) {
        value += ms;
      },
    };
  }

  test('per-IP budget: allowed up to the cap, then denied with retry-after; distinct IPs are isolated; windows roll over', async () => {
    const c = clock();
    const limiter = createMemoryEmailCallbackRateLimiter({
      ip: { maxRequests: 2, windowMs: WINDOW_MS },
      now: c.now,
    });
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_A })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_A })).kind, 'allowed');
    const third = await limiter.consume({ policy: 'ip', facts: IP_A });
    assert.equal(third.kind, 'denied');
    if (third.kind === 'denied') assert.ok(third.decision.retryAfterSeconds >= 1);
    // A different IP keeps its own budget.
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_B })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_B })).kind, 'allowed');
    // Window rollover resets the budget.
    c.advance(WINDOW_MS + 1);
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_A })).kind, 'allowed');
  });

  test('invalid subjects fail closed with an internal failure', async () => {
    const limiter = createMemoryEmailCallbackRateLimiter({ ip: { maxRequests: 2, windowMs: WINDOW_MS } });
    assertFailed(await limiter.consume({ policy: 'ip', facts: '' }), 'internal', 'rate_limit_invalid_input');
    assertFailed(await limiter.consume({ policy: 'ip', facts: 'x'.repeat(65) }), 'internal', 'rate_limit_invalid_input');
    assertFailed(await limiter.consume({ policy: 'ip', facts: `${IP_A}\n` }), 'internal', 'rate_limit_invalid_input');
  });

  test('bounded buckets: at capacity a NEW IP is denied while live budgets are preserved', async () => {
    const limiter = createMemoryEmailCallbackRateLimiter({
      ip: { maxRequests: 1, windowMs: 3_600_000 },
      maxBuckets: 1,
      sweepIntervalMs: 60_000,
      now: () => NOW_MS,
    });
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_A })).kind, 'allowed');
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_A })).kind, 'denied', 'the live bucket keeps its exhausted budget');
    const overloaded = await limiter.consume({ policy: 'ip', facts: IP_B });
    assert.equal(overloaded.kind, 'denied', 'a new IP at capacity is denied, never evicting a live bucket');
    if (overloaded.kind === 'denied') assert.ok(overloaded.decision.retryAfterSeconds >= 1);
  });

  test('the default budget is generous enough for legitimate provider retries', async () => {
    assert.equal(EMAIL_CALLBACK_RATE_LIMIT_IP_MAX_DEFAULT, 600);
    assert.equal(EMAIL_CALLBACK_RATE_LIMIT_IP_WINDOW_MS_DEFAULT, 60_000);
    const limiter = createMemoryEmailCallbackRateLimiter();
    for (let i = 0; i < EMAIL_CALLBACK_RATE_LIMIT_IP_MAX_DEFAULT; i += 1) {
      assert.equal((await limiter.consume({ policy: 'ip', facts: IP_A })).kind, 'allowed', `attempt ${i + 1}`);
    }
    assert.equal((await limiter.consume({ policy: 'ip', facts: IP_A })).kind, 'denied');
    assert.equal(limiter.size(), 1, 'one live bucket after the flood');
    limiter.reset();
    assert.equal(limiter.size(), 0);
  });
});

// ---------------------------------------------------------------------------
// Redis adapter (shared multi-replica) over a scripted client
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

/** ReplyError-shaped error like ioredis's redis-errors ReplyError. */
function replyError(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  // Default reply honors the wire invariant remaining = max(0, rateMax - count)
  // so the parser accepts it for any policy budget. The evalsha ARGV layout is
  // [key, rateMax, windowMs] (the key is KEYS[1], never ARGV[0]).
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> = async (_sha, args) => {
    const rateMax = Number(args[1]);
    return [1, 1, Math.max(0, rateMax - 1), 60, WINDOW_START];
  };

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  quit(): Promise<'OK'> { return Promise.resolve('OK'); }
  removeAllListeners(): this { return this; }
  on(): this { return this; }
  script(subcommand: 'LOAD', script: string): Promise<string> {
    this.calls.push({ kind: 'script_load', args: [subcommand, script] });
    return this.scriptLoadImpl(script);
  }
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.calls.push({ kind: 'evalsha', args: [sha, numkeys, ...args] });
    return this.evalshaImpl(sha, args);
  }
}

function makeRedisStore(
  fake: FakeRateLimitClient,
  overrides: {
    readonly ipMax?: number;
    readonly now?: () => number;
    readonly failureThreshold?: number;
    readonly cooldownMs?: number;
  } = {},
): EmailCallbackRateLimiter {
  return createRedisEmailCallbackRateLimiter({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    keyPrefix: KEY_PREFIX,
    ip: { maxRequests: overrides.ipMax ?? 2, windowMs: WINDOW_MS },
    commandTimeoutMs: 75,
    connectTimeoutMs: 1_000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _clientOptions: RateLimitRedisClientOptions) => fake,
    now: overrides.now,
    failureThreshold: overrides.failureThreshold,
    cooldownMs: overrides.cooldownMs,
  });
}

describe('FIX-L-061 Redis adapter (shared multi-replica)', () => {
  test('allowed/denied decisions map from the frozen Lua reply with the ip budget and codec keys', async () => {
    const fake = new FakeRateLimitClient();
    const store = makeRedisStore(fake, { ipMax: 2 });
    const allowed = await store.consume({ policy: 'ip', facts: IP_A });
    assert.equal(allowed.kind, 'allowed');

    const evalshaCalls = fake.calls.filter((call) => call.kind === 'evalsha');
    assert.equal(evalshaCalls.length, 1);
    // KEYS[1] is the codec key: ip-policy namespace, HMAC subject, seeded window.
    const ipKey = String(evalshaCalls[0]!.args[2]);
    assert.equal(parseEmailCallbackRateLimitKey(ipKey).kind, 'ok');
    assert.equal(ipKey.includes(IP_A), false, 'the raw IP never reaches the Redis key');
    // The ip budget flows as ARGV[1] (key is KEYS[1]).
    assert.equal(evalshaCalls[0]!.args[3], 2);

    // A denied reply passes the retry-after through as a quota decision (never a failure).
    fake.evalshaImpl = async (_sha, args) => {
      const rateMax = Number(args[1]);
      return [0, rateMax + 1, 0, 37, WINDOW_START];
    };
    const denied = await store.consume({ policy: 'ip', facts: IP_A });
    assert.equal(denied.kind, 'denied');
    if (denied.kind === 'denied') assert.equal(denied.decision.retryAfterSeconds, 37);
  });

  test('Redis failures map to stable failure classes and the circuit opens after the threshold', async () => {
    const fake = new FakeRateLimitClient();
    fake.evalshaImpl = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    };
    const store = makeRedisStore(fake, { failureThreshold: 1, cooldownMs: 60_000 });
    assertFailed(await store.consume({ policy: 'ip', facts: IP_A }), 'unavailable', 'rate_limit_unavailable');
    assertFailed(await store.consume({ policy: 'ip', facts: IP_A }), 'unavailable', 'rate_limit_circuit_open');
    assert.equal(store.readiness().status, 'degraded', 'the circuit state feeds the readiness fact');
  });

  test('a malformed script reply is protocol corruption: failed malformed, never a decision', async () => {
    const fake = new FakeRateLimitClient();
    fake.evalshaImpl = async () => [1, 1, 9_999, 60, WINDOW_START];
    const store = makeRedisStore(fake);
    assertFailed(await store.consume({ policy: 'ip', facts: IP_A }), 'malformed', 'rate_limit_malformed_reply');
  });

  test('NOSCRIPT reloads the frozen script exactly once and retries exactly once', async () => {
    const fake = new FakeRateLimitClient();
    let evalshaCalls = 0;
    fake.evalshaImpl = async (_sha, args) => {
      evalshaCalls += 1;
      if (evalshaCalls === 1) throw replyError('NOSCRIPT No matching script. Please use EVAL.');
      const rateMax = Number(args[1]);
      return [1, 1, Math.max(0, rateMax - 1), 60, WINDOW_START];
    };
    const store = makeRedisStore(fake);
    assert.equal((await store.consume({ policy: 'ip', facts: IP_A })).kind, 'allowed');
    assert.equal(evalshaCalls, 2, 'the retry is issued exactly once');
    assert.equal(fake.calls.filter((call) => call.kind === 'script_load').length, 2, 'the script is reloaded once');
  });

  test('close is idempotent and a closed store fails closed', async () => {
    const fake = new FakeRateLimitClient();
    const store = makeRedisStore(fake);
    // The runtime's lazy connect resolves on a microtask (health starts
    // degraded fail-closed), so await one consume before asserting the
    // healthy readiness fact (same pattern as the MCP delivery suite).
    assert.equal((await store.consume({ policy: 'ip', facts: IP_A })).kind, 'allowed');
    assert.equal(store.readiness().status, 'healthy');
    await store.close();
    await store.close();
    assertFailed(await store.consume({ policy: 'ip', facts: IP_A }), 'unavailable', 'rate_limit_store_closed');
    assert.equal(store.readiness().status, 'degraded');
  });
});

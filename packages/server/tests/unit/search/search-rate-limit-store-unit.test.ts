/**
 * FIX-M-006 Search rate-limit Redis store unit contract over a SCRIPTED fake
 * client (same scope rule as the auth store unit suite: "pure unit 可用
 * scripted client 定位错误").
 *
 * The fake client pinpoints the error paths that the real-Redis suite cannot
 * produce deterministically: malformed script replies, NOSCRIPT reload/retry,
 * command timeout vs immediate disconnect, ACL denial, circuit fast-fail and
 * close idempotency. It also proves the store consumes the SEARCH key codec
 * and the frozen Lua constant — the key sent to EVALSHA parses with the
 * search normalizer and never carries the raw client IP / account id / secret
 * text — and that the anonymous/account families route to their OWN budgets.
 *
 * This is NOT a Map/fake substitute for Redis: atomicity, real TTLs, server
 * time and multi-instance sharing are proven by the real Redis suite
 * (tests/integration/phase4a/phase4a-rl06-multi-replica-http-redis.integration.test.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RATE_LIMIT_LUA_SCRIPT,
  SEARCH_RATE_LIMIT_ROUTE_FAMILIES,
  buildSearchRateLimitKey,
  createRedisSearchRateLimitStore,
  parseSearchRateLimitKey,
  searchRateLimitSubjectHmac,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
  type SearchRateLimitOutcome,
  type SearchRateLimiter,
  type SearchRateLimitRouteFamily,
  type SearchRateLimitSubject,
} from '../../../src/infrastructure/rate-limit/index.js';

const ENVIRONMENT = 'test';
const KEY_PREFIX = 'search-unit';
const KEY_SECRET = Buffer.from('search-unit-hmac-secret', 'utf8');
const ANONYMOUS_MAX = 30;
const ACCOUNT_MAX = 120;
const WINDOW_MS = 60_000;
const NOW_MS = 1_750_000_000_000;
const WINDOW_START = 1_749_999_960_000;

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
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> = async () => [1, 1, ANONYMOUS_MAX - 1, 60, WINDOW_START];

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

function makeStore(
  fake: FakeRateLimitClient,
  overrides: {
    readonly anonymousMaxRequests?: number;
    readonly accountMaxRequests?: number;
    readonly windowMs?: number;
    readonly now?: () => number;
    readonly failureThreshold?: number;
    readonly cooldownMs?: number;
    readonly keySecret?: Buffer;
  } = {},
): SearchRateLimiter {
  return createRedisSearchRateLimitStore({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keySecret: overrides.keySecret ?? KEY_SECRET,
    keyPrefix: KEY_PREFIX,
    anonymousMaxRequests: overrides.anonymousMaxRequests ?? ANONYMOUS_MAX,
    accountMaxRequests: overrides.accountMaxRequests ?? ACCOUNT_MAX,
    windowMs: overrides.windowMs ?? WINDOW_MS,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _clientOptions: RateLimitRedisClientOptions) => fake,
    now: overrides.now,
    failureThreshold: overrides.failureThreshold,
    cooldownMs: overrides.cooldownMs,
  });
}

function subject(family: SearchRateLimitRouteFamily = 'anonymous', value = '203.0.113.10'): SearchRateLimitSubject {
  return { family, subject: value };
}

function expectedKey(family: SearchRateLimitRouteFamily, value: string, windowStartEpochMs: number): string {
  return buildSearchRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    family,
    subject: value,
    windowStartEpochMs,
  });
}

function assertFailure(outcome: SearchRateLimitOutcome, failureClass: string, code: string): void {
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.failure.class, failureClass, `expected failure class ${failureClass}`);
  assert.equal(outcome.failure.code, code);
}

// ---------------------------------------------------------------------------
// Success paths: script load + codec key integration
// ---------------------------------------------------------------------------

test('loads the frozen script once and turns a valid reply into an allowed decision over the search codec key', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, { now: () => NOW_MS });

  const outcome = await store.consume(subject('anonymous', '203.0.113.10'));
  assert.equal(outcome.kind, 'allowed');
  if (outcome.kind !== 'allowed') return;
  assert.deepEqual(outcome.decision, { allowed: true, retryAfterSeconds: 60 });

  assert.equal(fake.calls.length, 2, 'one script load + one evalsha');
  assert.equal(fake.calls[0]?.kind, 'script_load');
  assert.equal(fake.calls[0]?.args[1], RATE_LIMIT_LUA_SCRIPT, 'the EXACT frozen script is what gets loaded');
  assert.equal(fake.calls[1]?.kind, 'evalsha');

  // The key passed to EVALSHA is the search codec key with the seed window.
  const evalshaArgs = fake.calls[1]?.args as readonly unknown[];
  assert.equal(evalshaArgs[1], 1, 'one KEYS slot');
  const key = evalshaArgs[2] as string;
  assert.equal(key, expectedKey('anonymous', '203.0.113.10', WINDOW_START), 'the store consumes the search key codec');

  // Key isolation: the key parses canonically and carries no raw subject/secret.
  const parsed = parseSearchRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') {
    assert.equal(parsed.parts.keyPrefix, KEY_PREFIX);
    assert.equal(parsed.parts.environment, ENVIRONMENT);
    assert.equal(parsed.parts.family, 'anonymous');
    assert.equal(parsed.parts.subjectHmac, searchRateLimitSubjectHmac(KEY_SECRET, '203.0.113.10'));
    assert.equal(parsed.parts.windowStartEpochMs, WINDOW_START);
  }
  assert.equal(key.includes('203.0.113.10'), false);
  assert.equal(key.includes(KEY_SECRET.toString('utf8')), false);

  // A second check reuses the cached SHA (no further script load).
  const second = await store.consume(subject('anonymous', '203.0.113.10'));
  assert.equal(second.kind, 'allowed');
  assert.equal(fake.calls.filter((call) => call.kind === 'script_load').length, 1);
});

test('a denied reply becomes a denied DECISION (quota fact), never a failure class', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [0, ANONYMOUS_MAX, 0, 30, WINDOW_START];
  const store = makeStore(fake, { now: () => NOW_MS });
  const outcome = await store.consume(subject('anonymous', '198.51.100.20'));
  assert.equal(outcome.kind, 'denied');
  if (outcome.kind !== 'denied') return;
  assert.equal(outcome.decision.allowed, false);
  assert.equal(outcome.decision.retryAfterSeconds, 30);
});

test('the anonymous family routes to its OWN budget and the account family to its own (FIX-M-006 independent anonymous budget)', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, {
    now: () => NOW_MS,
    anonymousMaxRequests: 30,
    accountMaxRequests: 120,
  });
  await store.consume(subject('anonymous', '203.0.113.10'));
  await store.consume(subject('account', 'account-0000-0000-0000-000000000001'));
  const evalshaCalls = fake.calls.filter((call) => call.kind === 'evalsha');
  assert.equal(evalshaCalls.length, 2);
  // EVALSHA args: [sha, numkeys, key, rateMax, windowMs] — the rateMax must
  // be the FAMILY budget, never the other family's.
  const anonymousRateMax = evalshaCalls[0]?.args[3];
  const accountRateMax = evalshaCalls[1]?.args[3];
  assert.equal(anonymousRateMax, 30, 'anonymous uses the anonymous budget');
  assert.equal(accountRateMax, 120, 'account uses the account budget');
  assert.equal(evalshaCalls[0]?.args[4], WINDOW_MS);
  assert.equal(evalshaCalls[1]?.args[4], WINDOW_MS);

  // The account subject is HMAC'd exactly like the anonymous IP.
  const accountKey = evalshaCalls[1]?.args[2] as string;
  assert.equal(accountKey, expectedKey('account', 'account-0000-0000-0000-000000000001', WINDOW_START));
  assert.equal(accountKey.includes('account-0000-0000-0000-000000000001'), false, 'the raw account id never reaches the key');

  // The port exposes the fixed per-family quota facts for RateLimit-Policy.
  assert.equal(store.policy.anonymous, 'search:anonymous:30:60000');
  assert.equal(store.policy.account, 'search:account:120:60000');
});

test('different subjects and families hash to different keys; raw subjects never reach the command', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, { now: () => NOW_MS });
  await store.consume(subject('anonymous', '203.0.113.10'));
  await store.consume(subject('anonymous', '198.51.100.20'));
  await store.consume(subject('account', '203.0.113.10'));
  await store.consume(subject('account', 'account-0000-0000-0000-000000000002'));
  const keys = fake.calls.filter((call) => call.kind === 'evalsha').map((call) => call.args[2] as string);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 4, 'the subject HMAC + family segment isolate IPs, account ids and families');
  for (const key of keys) {
    assert.equal(key.includes('203.0.113.10'), false);
    assert.equal(key.includes('198.51.100.20'), false);
    assert.equal(key.includes('account-0000-0000-0000-000000000002'), false);
    assert.equal(parseSearchRateLimitKey(key).kind, 'ok');
  }
});

test('the sealed family tokens are exactly the two Search identity strategies (anonymous | account)', () => {
  assert.deepEqual(
    [...SEARCH_RATE_LIMIT_ROUTE_FAMILIES].sort(),
    ['account', 'anonymous'],
  );
});

// ---------------------------------------------------------------------------
// Error paths: stable classification
// ---------------------------------------------------------------------------

test('a malformed script reply is classified malformed and opens the circuit fast-fail', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [1, 5];
  const store = makeStore(fake, { now: () => NOW_MS, failureThreshold: 1 });
  const first = await store.consume(subject());
  assertFailure(first, 'malformed', 'rate_limit_malformed_reply');

  // The breaker opened after the single failure: the next check fails fast
  // with unavailable and never issues another Redis command.
  const second = await store.consume(subject());
  assertFailure(second, 'unavailable', 'rate_limit_circuit_open');
  assert.equal(fake.calls.filter((call) => call.kind === 'evalsha').length, 1, 'no command reaches the client while open');
});

test('NOSCRIPT reloads the script once and retries exactly once; a repeated NOSCRIPT is an internal failure', async () => {
  const fake = new FakeRateLimitClient();
  let noscriptRemaining = 1;
  fake.evalshaImpl = async (sha, args) => {
    if (noscriptRemaining > 0) {
      noscriptRemaining -= 1;
      throw replyError('NOSCRIPT No matching script. Please use EVAL.');
    }
    return [1, 1, ANONYMOUS_MAX - 1, 60, WINDOW_START];
  };
  const store = makeStore(fake, { now: () => NOW_MS });

  const outcome = await store.consume(subject());
  assert.equal(outcome.kind, 'allowed', 'the NOSCRIPT recovery retries and succeeds');
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ['script_load', 'evalsha', 'script_load', 'evalsha'],
    'reload happens exactly once between the two evalsha attempts',
  );

  // A second check is now served from the cached SHA (no reload needed).
  const second = await store.consume(subject());
  assert.equal(second.kind, 'allowed');
  assert.equal(fake.calls.filter((call) => call.kind === 'script_load').length, 2);

  // A NOSCRIPT that repeats after the reload is a stable internal failure.
  const stuck = new FakeRateLimitClient();
  stuck.evalshaImpl = async () => { throw replyError('NOSCRIPT No matching script. Please use EVAL.'); };
  const stuckStore = makeStore(stuck, { now: () => NOW_MS });
  const stuckOutcome = await stuckStore.consume(subject());
  assertFailure(stuckOutcome, 'internal', 'rate_limit_noscript');
  assert.equal(stuck.calls.filter((call) => call.kind === 'script_load').length, 2, 'initial load + one reload');
});

test('a hung command fails with the timeout class within the bounded command timeout', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => new Promise<never>(() => { /* never settles: server fully stopped, no RST */ });
  const store = makeStore(fake, { now: () => NOW_MS });
  const started = performance.now();
  const outcome = await store.consume(subject());
  const elapsed = performance.now() - started;
  assertFailure(outcome, 'timeout', 'rate_limit_command_timeout');
  assert.ok(elapsed < 2_000, `the timeout race bounds the command (${elapsed.toFixed(0)}ms)`);
});

test('an immediate disconnect fails fast with unavailable; a closed socket never becomes a denied decision', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => { throw new Error('Connection is closed.'); };
  const store = makeStore(fake, { now: () => NOW_MS });
  const started = performance.now();
  const outcome = await store.consume(subject());
  const elapsed = performance.now() - started;
  assertFailure(outcome, 'unavailable', 'rate_limit_unavailable');
  assert.ok(elapsed < 1_000, `an immediate disconnect fails fast (${elapsed.toFixed(0)}ms)`);
  assert.notEqual(outcome.kind, 'denied', 'an outage is never fabricated as quota exhaustion');
});

test('ACL denial, max-retries and key-malformed error replies map to stable failure classes', async () => {
  const cases: Array<{ error: () => Error; failureClass: string; code: string }> = [
    { error: () => replyError('NOAUTH Authentication required.'), failureClass: 'acl', code: 'rate_limit_acl_denied' },
    { error: () => replyError('NOPERM this user has no permissions to run this command'), failureClass: 'acl', code: 'rate_limit_acl_denied' },
    { error: () => Object.assign(new Error('Reconnecting 0 times'), { name: 'MaxRetriesPerRequestError' }), failureClass: 'unavailable', code: 'rate_limit_max_retries_exhausted' },
    { error: () => replyError('ERR RATE_LIMIT_KEY_MALFORMED'), failureClass: 'malformed', code: 'rate_limit_key_malformed' },
    { error: () => replyError('ERR WRONGTYPE Operation against a key holding the wrong kind of value'), failureClass: 'internal', code: 'rate_limit_wrongtype' },
    { error: () => replyError('ERR unknown command'), failureClass: 'internal', code: 'rate_limit_redis_error' },
    { error: () => new Error('connect ECONNREFUSED 127.0.0.1:6379'), failureClass: 'unavailable', code: 'rate_limit_unavailable' },
    { error: () => new Error('Command timed out'), failureClass: 'timeout', code: 'rate_limit_command_timeout' },
  ];
  for (const { error, failureClass, code } of cases) {
    const fake = new FakeRateLimitClient();
    fake.evalshaImpl = async () => { throw error(); };
    const store = makeStore(fake, { now: () => NOW_MS });
    const outcome = await store.consume(subject());
    assertFailure(outcome, failureClass, code);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle: closed store, idempotent close, readiness
// ---------------------------------------------------------------------------

test('a closed store fails fast and close is idempotent', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, { now: () => NOW_MS });
  await store.close();
  await store.close();
  const outcome = await store.consume(subject());
  assertFailure(outcome, 'unavailable', 'rate_limit_store_closed');
  assert.equal(fake.calls.filter((call) => call.kind === 'evalsha').length, 0, 'no command after close');
});

test('invalid subject input is an internal failure and never issues a Redis command', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, { now: () => NOW_MS });
  const emptySubject = await store.consume({ family: 'anonymous', subject: '' });
  assertFailure(emptySubject, 'internal', 'rate_limit_invalid_input');
  const controlCharacters = await store.consume({ family: 'anonymous', subject: 'a\u0000b' });
  assertFailure(controlCharacters, 'internal', 'rate_limit_invalid_input');
  const unknownFamily = await store.consume({ family: 'admin' as never, subject: '203.0.113.10' });
  assertFailure(unknownFamily, 'internal', 'rate_limit_invalid_input');
  assert.equal(fake.calls.length, 0, 'invalid input never reaches the client');
});

test('readiness reflects circuit failures, disconnects and the closed state', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, { now: () => NOW_MS, failureThreshold: 1 });
  await store.consume(subject());
  assert.deepEqual(
    { status: store.readiness().status, reason: store.readiness().reason },
    { status: 'healthy', reason: 'none' },
  );

  fake.evalshaImpl = async () => { throw new Error('Connection is closed.'); };
  await store.consume(subject());
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(store.readiness().reason, 'last_command_failed', 'the open circuit marks the readiness degraded');

  await store.close();
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(store.readiness().reason, 'closed');
  assert.ok(Number.isSafeInteger(store.readiness().lastCheckedAtEpochMs));
});

test('the factory fails closed on empty key secrets, empty environment tokens and invalid budgets', () => {
  const base = {
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keyPrefix: KEY_PREFIX,
    windowMs: WINDOW_MS,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
  } as const;
  assert.throws(
    () => createRedisSearchRateLimitStore({
      ...base,
      keySecret: Buffer.alloc(0),
      anonymousMaxRequests: ANONYMOUS_MAX,
      accountMaxRequests: ACCOUNT_MAX,
    }),
    /key secret/i,
  );
  assert.throws(
    () => createRedisSearchRateLimitStore({
      ...base,
      environment: '',
      keySecret: KEY_SECRET,
      anonymousMaxRequests: ANONYMOUS_MAX,
      accountMaxRequests: ACCOUNT_MAX,
    }),
    /environment/,
  );
  assert.throws(
    () => createRedisSearchRateLimitStore({
      ...base,
      keySecret: KEY_SECRET,
      anonymousMaxRequests: 0,
      accountMaxRequests: ACCOUNT_MAX,
    }),
    /anonymousMaxRequests/,
  );
  assert.throws(
    () => createRedisSearchRateLimitStore({
      ...base,
      keySecret: KEY_SECRET,
      anonymousMaxRequests: ANONYMOUS_MAX,
      accountMaxRequests: 0,
    }),
    /accountMaxRequests/,
  );
  assert.throws(
    () => createRedisSearchRateLimitStore({
      ...base,
      keySecret: KEY_SECRET,
      anonymousMaxRequests: ANONYMOUS_MAX,
      accountMaxRequests: ACCOUNT_MAX,
      windowMs: 0,
    }),
    /windowMs/,
  );
});

test('codec rejects non-canonical keys and raw-IP/account subjects fail closed', () => {
  const key = buildSearchRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    family: 'anonymous',
    subject: '203.0.113.10',
    windowStartEpochMs: WINDOW_START,
  });
  assert.equal(parseSearchRateLimitKey(key).kind, 'ok');
  // Wrong hash-tag segment (auth codec shape) must be rejected.
  assert.equal(parseSearchRateLimitKey(key.replace('{search:', '{auth:')).kind, 'rejected');
  // A key carrying the raw subject in the subject segment is non-canonical.
  assert.equal(parseSearchRateLimitKey(
    `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{search:203.0.113.10}:anonymous:${WINDOW_START}`,
  ).kind, 'rejected');
  // Unknown family token is rejected.
  assert.equal(parseSearchRateLimitKey(
    `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{search:${'a'.repeat(32)}}:admin:${WINDOW_START}`,
  ).kind, 'rejected');
  assert.throws(
    () => buildSearchRateLimitKey({
      keyPrefix: KEY_PREFIX,
      environment: ENVIRONMENT,
      keySecret: KEY_SECRET,
      family: 'admin' as never,
      subject: '203.0.113.10',
      windowStartEpochMs: WINDOW_START,
    }),
    /family/,
  );
});

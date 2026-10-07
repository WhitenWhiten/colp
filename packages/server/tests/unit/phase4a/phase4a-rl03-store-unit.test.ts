/**
 * P4A-RL03 RedisRateLimitStore unit contract over a SCRIPTED fake client
 * (plan §8 RL03 test scope: "pure unit 可用 scripted client 定位错误").
 *
 * The fake client pinpoints the error paths that the real-Redis suite cannot
 * produce deterministically: malformed script replies, NOSCRIPT reload/retry,
 * command timeout vs immediate disconnect (fast fail vs server fully stopped,
 * §4.2.5-style controllable means), ACL denial, circuit fast-fail and close
 * idempotency. It also proves the store consumes the PRODUCTION key codec and
 * the frozen Lua constant — the key sent to EVALSHA parses with the
 * production normalizer and never carries raw identity/secret text.
 *
 * This is NOT a Map/fake substitute for Redis: atomicity, real TTLs, server
 * time and multi-client sharing are proven by the real Redis suite.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'vitest';
import {
  buildAttachmentRateLimitKey,
  parseAttachmentRateLimitKey,
  rateLimitSubjectHmac,
  type AttachmentRateLimitConfig,
  type RateLimitSubject,
} from '../../../src/modules/attachments/index.js';
import {
  RATE_LIMIT_LUA_SCRIPT,
  createRedisRateLimitStore,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';
import type {
  RateLimitStore,
  RateLimitStoreOutcome,
} from '../../../src/modules/attachments/index.js';

const ENVIRONMENT = 'test';
const KEY_PREFIX = 'rl03-unit';
const KEY_SECRET = Buffer.from('rl03-unit-hmac-secret', 'utf8');
const RATE_MAX = 30;
const WINDOW_MS = 60_000;
const NOW_MS = 1_750_000_000_000;
const WINDOW_START = 1_749_999_960_000;

function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl: 'redis://127.0.0.1:6379',
    keySecretRef: 'known/rl03/unit/hmac',
    keyPrefix: KEY_PREFIX,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: RATE_MAX, rateWindowMs: WINDOW_MS }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: WINDOW_MS }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: WINDOW_MS }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: WINDOW_MS }),
    }),
    completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: WINDOW_MS }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

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
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> = async () => [1, 1, RATE_MAX - 1, 60, WINDOW_START];

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
  overrides: Partial<AttachmentRateLimitConfig> = {},
  options: { readonly now?: () => number; readonly failureThreshold?: number; readonly cooldownMs?: number } = {},
): RateLimitStore {
  return createRedisRateLimitStore({
    config: makeConfig(overrides),
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    createClient: (_url: string, _clientOptions: RateLimitRedisClientOptions) => fake,
    now: options.now,
    failureThreshold: options.failureThreshold,
    cooldownMs: options.cooldownMs,
  });
}

function subject(seed: string = randomUUID()): RateLimitSubject {
  return { principalId: `principal-${seed}`, scope: `collection-${seed}` };
}

function expectedKey(routeClass: 'issue' | 'complete' | 'download', subjectValue: RateLimitSubject, windowStartEpochMs: number): string {
  return buildAttachmentRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    routeClass,
    subject: subjectValue,
    windowStartEpochMs,
  });
}

function assertFailure(outcome: RateLimitStoreOutcome, failureClass: string, code: string): void {
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.failure.class, failureClass, `expected failure class ${failureClass}`);
  assert.equal(outcome.failure.code, code);
}

// ---------------------------------------------------------------------------
// Success paths: script load + codec key integration
// ---------------------------------------------------------------------------

test('loads the frozen script once and turns a valid reply into an allowed decision over the production codec key', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, {}, { now: () => NOW_MS });
  const owner = subject('alice');

  const outcome = await store.check({ routeClass: 'issue', subject: owner });
  assert.equal(outcome.kind, 'allowed');
  if (outcome.kind !== 'allowed') return;
  assert.deepEqual(outcome.decision, { allowed: true, remaining: 29, retryAfterSeconds: 60, windowStartEpochMs: WINDOW_START });

  assert.equal(fake.calls.length, 2, 'one script load + one evalsha');
  assert.equal(fake.calls[0]?.kind, 'script_load');
  assert.equal(fake.calls[0]?.args[1], RATE_LIMIT_LUA_SCRIPT, 'the EXACT frozen script is what gets loaded');
  assert.equal(fake.calls[1]?.kind, 'evalsha');

  // The key passed to EVALSHA is the production codec key with the seed window.
  const evalshaArgs = fake.calls[1]?.args as readonly unknown[];
  assert.equal(evalshaArgs[1], 1, 'one KEYS slot');
  const key = evalshaArgs[2] as string;
  assert.equal(key, expectedKey('issue', owner, WINDOW_START), 'the store consumes the production key codec');

  // Key isolation (plan §4.1.11): the key parses canonically and carries no
  // raw identity or secret text.
  const parsed = parseAttachmentRateLimitKey(key);
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') {
    assert.equal(parsed.parts.keyPrefix, KEY_PREFIX);
    assert.equal(parsed.parts.environment, ENVIRONMENT);
    assert.equal(parsed.parts.routeClass, 'issue');
    assert.equal(parsed.parts.subjectHmac, rateLimitSubjectHmac(KEY_SECRET, owner));
    assert.equal(parsed.parts.windowStartEpochMs, WINDOW_START);
  }
  assert.equal(key.includes(owner.principalId), false);
  assert.equal(key.includes(owner.scope), false);
  assert.equal(key.includes(KEY_SECRET.toString('utf8')), false);

  // A second check reuses the cached SHA (no further script load).
  const second = await store.check({ routeClass: 'issue', subject: owner });
  assert.equal(second.kind, 'allowed');
  assert.equal(fake.calls.filter((call) => call.kind === 'script_load').length, 1);
});

test('a denied reply becomes a denied DECISION (quota fact), never a failure class', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [0, RATE_MAX, 0, 30, WINDOW_START];
  const store = makeStore(fake, {}, { now: () => NOW_MS });
  const outcome = await store.check({ routeClass: 'issue', subject: subject('denied') });
  assert.equal(outcome.kind, 'denied');
  if (outcome.kind !== 'denied') return;
  assert.equal(outcome.decision.allowed, false);
  assert.equal(outcome.decision.remaining, 0);
  assert.equal(outcome.decision.retryAfterSeconds, 30);
});

test('different principals hash to different keys; the raw identity never reaches the command', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, {}, { now: () => NOW_MS });
  const alice = subject('alice');
  const bob = subject('bob');
  await store.check({ routeClass: 'issue', subject: alice });
  await store.check({ routeClass: 'issue', subject: bob });
  const keys = fake.calls.filter((call) => call.kind === 'evalsha').map((call) => call.args[2] as string);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1], 'the subject HMAC isolates principals');
  for (const key of keys) {
    assert.equal(key.includes('alice'), false);
    assert.equal(key.includes('bob'), false);
  }
});

// ---------------------------------------------------------------------------
// Error paths: stable classification
// ---------------------------------------------------------------------------

test('a malformed script reply is classified malformed and opens the circuit fast-fail', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [1, 5];
  const store = makeStore(fake, {}, { now: () => NOW_MS, failureThreshold: 1 });
  const first = await store.check({ routeClass: 'issue', subject: subject('malformed') });
  assertFailure(first, 'malformed', 'rate_limit_malformed_reply');

  // The breaker opened after the single failure: the next check fails fast
  // with unavailable and never issues another Redis command.
  const second = await store.check({ routeClass: 'issue', subject: subject('malformed') });
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
    return [1, 1, RATE_MAX - 1, 60, WINDOW_START];
  };
  const store = makeStore(fake, {}, { now: () => NOW_MS });

  const outcome = await store.check({ routeClass: 'issue', subject: subject('noscript') });
  assert.equal(outcome.kind, 'allowed', 'the NOSCRIPT recovery retries and succeeds');
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ['script_load', 'evalsha', 'script_load', 'evalsha'],
    'reload happens exactly once between the two evalsha attempts',
  );

  // A second check is now served from the cached SHA (no reload needed).
  const second = await store.check({ routeClass: 'issue', subject: subject('noscript') });
  assert.equal(second.kind, 'allowed');
  assert.equal(fake.calls.filter((call) => call.kind === 'script_load').length, 2);

  // A NOSCRIPT that repeats after the reload is a stable internal failure.
  const stuck = new FakeRateLimitClient();
  stuck.evalshaImpl = async () => { throw replyError('NOSCRIPT No matching script. Please use EVAL.'); };
  const stuckStore = makeStore(stuck, {}, { now: () => NOW_MS });
  const stuckOutcome = await stuckStore.check({ routeClass: 'issue', subject: subject('noscript2') });
  assertFailure(stuckOutcome, 'internal', 'rate_limit_noscript');
  assert.equal(stuck.calls.filter((call) => call.kind === 'script_load').length, 2, 'initial load + one reload');
});

test('a hung command fails with the timeout class within the bounded command timeout', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => new Promise<never>(() => { /* never settles: server fully stopped, no RST */ });
  const store = makeStore(fake, { commandTimeoutMs: 60 }, { now: () => NOW_MS });
  const started = performance.now();
  const outcome = await store.check({ routeClass: 'issue', subject: subject('hung') });
  const elapsed = performance.now() - started;
  assertFailure(outcome, 'timeout', 'rate_limit_command_timeout');
  assert.ok(elapsed < 2_000, `the timeout race bounds the command (${elapsed.toFixed(0)}ms)`);
});

test('an immediate disconnect fails fast with unavailable; a closed socket never becomes a denied decision', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => { throw new Error('Connection is closed.'); };
  const store = makeStore(fake, {}, { now: () => NOW_MS });
  const started = performance.now();
  const outcome = await store.check({ routeClass: 'issue', subject: subject('disconnect') });
  const elapsed = performance.now() - started;
  assertFailure(outcome, 'unavailable', 'rate_limit_unavailable');
  assert.ok(elapsed < 1_000, `an immediate disconnect fails fast (${elapsed.toFixed(0)}ms)`);
  assert.notEqual(outcome.kind, 'denied', 'an outage is never fabricated as quota exhaustion (plan §4.1.10)');
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
    const store = makeStore(fake, {}, { now: () => NOW_MS });
    const outcome = await store.check({ routeClass: 'issue', subject: subject('classify') });
    assertFailure(outcome, failureClass, code);
  }
});

// ---------------------------------------------------------------------------
// Lifecycle: closed store, idempotent close, readiness
// ---------------------------------------------------------------------------

test('a closed store fails fast and close is idempotent', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, {}, { now: () => NOW_MS });
  await store.close();
  await store.close();
  const outcome = await store.check({ routeClass: 'issue', subject: subject('closed') });
  assertFailure(outcome, 'unavailable', 'rate_limit_store_closed');
  assert.equal(fake.calls.filter((call) => call.kind === 'evalsha').length, 0, 'no command after close');
});

test('invalid subject input is an internal failure and never issues a Redis command', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, {}, { now: () => NOW_MS });
  const emptyPrincipal = await store.check({ routeClass: 'issue', subject: { principalId: '', scope: 'collection-x' } });
  assertFailure(emptyPrincipal, 'internal', 'rate_limit_invalid_input');
  const controlCharacters = await store.check({ routeClass: 'issue', subject: { principalId: 'a\u0000b', scope: 'collection-x' } });
  assertFailure(controlCharacters, 'internal', 'rate_limit_invalid_input');
  const unknownRoute = await store.check({ routeClass: 'admin' as never, subject: subject('route') });
  assertFailure(unknownRoute, 'internal', 'rate_limit_invalid_input');
  assert.equal(fake.calls.length, 0, 'invalid input never reaches the client');
});

test('readiness reflects circuit failures, disconnects and the closed state', async () => {
  const fake = new FakeRateLimitClient();
  const store = makeStore(fake, {}, { now: () => NOW_MS, failureThreshold: 1 });
  await store.check({ routeClass: 'issue', subject: subject('ready') });
  assert.deepEqual(
    { status: store.readiness().status, reason: store.readiness().reason },
    { status: 'healthy', reason: 'none' },
  );

  fake.evalshaImpl = async () => { throw new Error('Connection is closed.'); };
  await store.check({ routeClass: 'issue', subject: subject('ready') });
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(store.readiness().reason, 'last_command_failed', 'the open circuit marks the readiness degraded');

  await store.close();
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(store.readiness().reason, 'closed');
  assert.ok(Number.isSafeInteger(store.readiness().lastCheckedAtEpochMs));
});

test('the factory fails closed on off mode, empty key secrets and empty environment tokens', () => {
  const off = makeConfig({ mode: 'off', required: false, redisUrl: null, keySecretRef: null });
  assert.throws(
    () => createRedisRateLimitStore({ config: off, environment: ENVIRONMENT, keySecret: KEY_SECRET }),
    /off/,
  );
  assert.throws(
    () => createRedisRateLimitStore({ config: makeConfig(), environment: ENVIRONMENT, keySecret: Buffer.alloc(0) }),
    /key secret/i,
  );
  assert.throws(
    () => createRedisRateLimitStore({ config: makeConfig(), environment: '', keySecret: KEY_SECRET }),
    /environment/,
  );
});

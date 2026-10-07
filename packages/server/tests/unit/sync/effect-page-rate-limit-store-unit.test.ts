import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RATE_LIMIT_LUA_SCRIPT,
  buildEffectPageRateLimitKey,
  createRedisEffectPageRateLimitStore,
  effectPageRateLimitEffectFacts,
  effectPageRateLimitSubjectFacts,
  effectPageRateLimitSubjectHmac,
  parseEffectPageRateLimitKey,
  type EffectPageRateLimitOutcome,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
} from '../../../src/infrastructure/rate-limit/index.js';

const NOW_MS = 1_750_000_000_000;
const WINDOW_MS = 60_000;
const WINDOW_START = Math.floor(NOW_MS / WINDOW_MS) * WINDOW_MS;
const KEY_SECRET = Buffer.from('effect-page-unit-secret', 'utf8');
const subject = {
  clientIp: '203.0.113.40',
  sessionId: 'session-effect-page',
  replicaId: 'replica-effect-page',
  effectId: 'effect-page-id',
};

interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  evalshaImpl: (args: readonly (string | number)[]) => Promise<unknown> =
    async (args) => [1, 1, Number(args[1]) - 1, 60, WINDOW_START];

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  quit(): Promise<'OK'> { return Promise.resolve('OK'); }
  removeAllListeners(): this { return this; }
  on(): this { return this; }
  script(subcommand: 'LOAD', script: string): Promise<string> {
    this.calls.push({ kind: 'script_load', args: [subcommand, script] });
    return Promise.resolve('a'.repeat(40));
  }
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.calls.push({ kind: 'evalsha', args: [sha, numkeys, ...args] });
    return this.evalshaImpl(args);
  }
}

function createStore(fake: FakeRateLimitClient) {
  return createRedisEffectPageRateLimitStore({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: 'test',
    keySecret: KEY_SECRET,
    keyPrefix: 'effect-page-test',
    subjectMaxRequests: 5,
    effectMaxRequests: 2,
    windowMs: WINDOW_MS,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1_000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _options: RateLimitRedisClientOptions) => fake,
    now: () => NOW_MS,
  });
}

function assertFailure(outcome: EffectPageRateLimitOutcome, failureClass: string): void {
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind === 'failed') assert.equal(outcome.failure.class, failureClass);
}

test('codec binds subject/effect facts to separate canonical HMAC keys without exposing raw facts', () => {
  const subjectFacts = effectPageRateLimitSubjectFacts(subject);
  const effectFacts = effectPageRateLimitEffectFacts(subject);
  assert.equal(subjectFacts, '203.0.113.40|session-effect-page|replica-effect-page');
  assert.equal(effectFacts, `${subjectFacts}|effect-page-id`);

  const subjectKey = buildEffectPageRateLimitKey({
    keyPrefix: 'effect-page-test', environment: 'test', keySecret: KEY_SECRET,
    family: 'subject', facts: subjectFacts, windowStartEpochMs: WINDOW_START,
  });
  const effectKey = buildEffectPageRateLimitKey({
    keyPrefix: 'effect-page-test', environment: 'test', keySecret: KEY_SECRET,
    family: 'effect', facts: effectFacts, windowStartEpochMs: WINDOW_START,
  });
  const parsed = parseEffectPageRateLimitKey(subjectKey);

  assert.equal(parsed.kind, 'ok');
  if (parsed.kind === 'ok') {
    assert.deepEqual(parsed.parts, {
      keyPrefix: 'effect-page-test', environment: 'test', schemaVersion: 1,
      subjectHmac: effectPageRateLimitSubjectHmac(KEY_SECRET, subjectFacts),
      family: 'subject', windowStartEpochMs: WINDOW_START,
    });
  }
  assert.notEqual(subjectKey, effectKey);
  for (const key of [subjectKey, effectKey]) {
    assert.equal(key.includes(subject.clientIp), false);
    assert.equal(key.includes(subject.sessionId), false);
    assert.equal(key.includes(subject.replicaId), false);
    assert.equal(key.includes(subject.effectId), false);
  }
});

test('codec rejects malformed facts, envelopes, prefixes, environments, families, and windows', () => {
  for (const facts of ['', 'line\nbreak', 'x'.repeat(513)]) {
    assert.throws(() => effectPageRateLimitSubjectHmac(KEY_SECRET, facts), /effect-page rate-limit facts/u);
  }
  for (const key of ['', 'not-a-key',
    `effect-page-test:test:ratelimit:v1:{epg:${'a'.repeat(32)}}:subject:01`,
    `effect-page-test:test:ratelimit:v1:{epg:${'a'.repeat(32)}}:subject:9999999999999999`]) {
    assert.equal(parseEffectPageRateLimitKey(key).kind, 'rejected');
  }
  const base = { environment: 'test', keySecret: KEY_SECRET, family: 'subject' as const,
    facts: 'facts', windowStartEpochMs: WINDOW_START };
  assert.throws(() => buildEffectPageRateLimitKey({ ...base, keyPrefix: '-invalid' }), /prefix/u);
  assert.throws(() => buildEffectPageRateLimitKey({ ...base, environment: 'bad/env' }), /environment/u);
  assert.throws(() => buildEffectPageRateLimitKey({ ...base, family: 'page' as 'subject' }), /unknown/u);
  assert.throws(() => buildEffectPageRateLimitKey({ ...base, windowStartEpochMs: -1 }), /window/u);
});

test('store consumes the subject budget before the per-effect budget with isolated keys', async () => {
  const fake = new FakeRateLimitClient();
  const store = createStore(fake);

  assert.deepEqual(await store.consume(subject), {
    kind: 'allowed', decision: { allowed: true, retryAfterSeconds: 0, family: 'subject' },
  });
  const evals = fake.calls.filter((call) => call.kind === 'evalsha');
  assert.deepEqual(fake.calls.map((call) => call.kind), ['script_load', 'evalsha', 'evalsha']);
  assert.equal(fake.calls[0]?.args[1], RATE_LIMIT_LUA_SCRIPT);
  assert.equal(evals[0]?.args[3], 5);
  assert.equal(evals[1]?.args[3], 2);
  assert.equal(parseEffectPageRateLimitKey(String(evals[0]?.args[2])).kind, 'ok');
  assert.equal(parseEffectPageRateLimitKey(String(evals[1]?.args[2])).kind, 'ok');
  assert.notEqual(evals[0]?.args[2], evals[1]?.args[2]);
  assert.equal(store.readiness().status, 'healthy');
  assert.equal(store.readiness().reason, 'none');
  await store.close();
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(store.readiness().reason, 'closed');
});

test('subject denial short-circuits effect admission and preserves the subject family', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [0, 5, 0, 30, WINDOW_START];
  const store = createStore(fake);

  assert.deepEqual(await store.consume(subject), {
    kind: 'denied', decision: { allowed: false, retryAfterSeconds: 30, family: 'subject' },
  });
  assert.equal(fake.calls.filter((call) => call.kind === 'evalsha').length, 1);
  await store.close();
});

test('effect denial and malformed effect replies remain distinct from subject quota', async () => {
  const deniedFake = new FakeRateLimitClient();
  let call = 0;
  deniedFake.evalshaImpl = async () => (++call === 1
    ? [1, 1, 4, 60, WINDOW_START]
    : [0, 2, 0, 45, WINDOW_START]);
  const deniedStore = createStore(deniedFake);
  assert.deepEqual(await deniedStore.consume(subject), {
    kind: 'denied', decision: { allowed: false, retryAfterSeconds: 45, family: 'effect' },
  });
  await deniedStore.close();

  const malformedFake = new FakeRateLimitClient();
  call = 0;
  malformedFake.evalshaImpl = async () => (++call === 1
    ? [1, 1, 4, 60, WINDOW_START]
    : [1]);
  const malformedStore = createStore(malformedFake);
  assertFailure(await malformedStore.consume(subject), 'malformed');
  await malformedStore.close();
});

test('store validates all deployment inputs before constructing a Redis runtime', () => {
  const fake = new FakeRateLimitClient();
  const base = {
    redisUrl: 'redis://127.0.0.1:6379', environment: 'test', keySecret: KEY_SECRET,
    subjectMaxRequests: 5, effectMaxRequests: 2, windowMs: WINDOW_MS,
    commandTimeoutMs: 75, connectTimeoutMs: 1_000, maxRetriesPerRequest: 1,
    createClient: () => fake,
  };
  assert.throws(() => createRedisEffectPageRateLimitStore({ ...base, redisUrl: '' }), /Redis URL/u);
  assert.throws(() => createRedisEffectPageRateLimitStore({ ...base, keySecret: Buffer.alloc(0) }), /HMAC/u);
  assert.throws(() => createRedisEffectPageRateLimitStore({ ...base, environment: '' }), /environment/u);
  for (const field of ['subjectMaxRequests', 'effectMaxRequests', 'windowMs',
    'commandTimeoutMs', 'connectTimeoutMs'] as const) {
    assert.throws(() => createRedisEffectPageRateLimitStore({ ...base, [field]: 0 }), /positive/u);
  }
  assert.throws(() => createRedisEffectPageRateLimitStore({ ...base, maxRetriesPerRequest: -1 }), /non-negative/u);
});

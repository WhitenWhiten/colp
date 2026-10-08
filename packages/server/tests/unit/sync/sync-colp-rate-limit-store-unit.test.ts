/**
 * P-09 Sync COLP rate-limit Redis store: two instances share one INCR map;
 * push/pull families are independent; raw IP never reaches EVALSHA keys.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RATE_LIMIT_LUA_SCRIPT,
  SYNC_COLP_RATE_LIMIT_ROUTE_FAMILIES,
  buildSyncColpRateLimitKey,
  createRedisSyncColpRateLimitStore,
  parseSyncColpRateLimitKey,
  syncColpRateLimitSubjectHmac,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
  type SyncColpRateLimitOutcome,
  type SyncColpRateLimiter,
} from '../../../src/infrastructure/rate-limit/index.js';

const ENVIRONMENT = 'test';
const KEY_PREFIX = 'known-sync';
const KEY_SECRET = Buffer.from('sync-colp-unit-hmac-secret', 'utf8');
const PUSH_MAX = 2;
const PULL_MAX = 5;
const PUSH_WINDOW_MS = 60_000;
const PULL_WINDOW_MS = 30_000;
const NOW_MS = 1_750_000_000_000;
const CLIENT_IP = '203.0.113.10';

interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

function replyError(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

class FakeRateLimitClient implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> =
    async () => [1, 1, PUSH_MAX - 1, 60, Math.floor(NOW_MS / PUSH_WINDOW_MS) * PUSH_WINDOW_MS];

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
  overrides: { readonly now?: () => number; readonly failureThreshold?: number } = {},
): SyncColpRateLimiter {
  return createRedisSyncColpRateLimitStore({
    redisUrl: 'redis://127.0.0.1:6379',
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    keyPrefix: KEY_PREFIX,
    pushMaxRequests: PUSH_MAX,
    pushWindowMs: PUSH_WINDOW_MS,
    pullMaxRequests: PULL_MAX,
    pullWindowMs: PULL_WINDOW_MS,
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _options: RateLimitRedisClientOptions) => fake,
    now: overrides.now ?? (() => NOW_MS),
    ...(overrides.failureThreshold === undefined ? {} : { failureThreshold: overrides.failureThreshold }),
  });
}

function assertFailure(outcome: SyncColpRateLimitOutcome, failureClass: string, code: string): void {
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind !== 'failed') return;
  assert.equal(outcome.failure.class, failureClass);
  assert.equal(outcome.failure.code, code);
}

test('two store instances share push counters; pull family stays independent; raw IP never in EVALSHA key', async () => {
  const counters = new Map<string, number>();
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async (_sha, args) => {
    const key = String(args[0]);
    const rateMax = Number(args[1]);
    const windowMs = Number(args[2]);
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    const remaining = Math.max(0, rateMax - next);
    const allowed = next <= rateMax ? 1 : 0;
    const retryAfter = Math.max(1, Math.ceil(windowMs / 1000));
    const windowStart = Math.floor(NOW_MS / windowMs) * windowMs;
    return [allowed, next, remaining, retryAfter, windowStart];
  };
  const left = makeStore(fake);
  const right = makeStore(fake);

  assert.equal((await left.consume({ family: 'push', clientIp: CLIENT_IP })).kind, 'allowed');
  assert.equal((await right.consume({ family: 'push', clientIp: CLIENT_IP })).kind, 'allowed');
  const denied = await left.consume({ family: 'push', clientIp: CLIENT_IP });
  assert.equal(denied.kind, 'denied');
  if (denied.kind !== 'denied') return;
  assert.equal(denied.decision.allowed, false);

  const pull = await right.consume({ family: 'pull', clientIp: CLIENT_IP });
  assert.equal(pull.kind, 'allowed', 'pull must not share the push counter');
  for (let index = 1; index < PULL_MAX; index += 1) {
    assert.equal((await left.consume({ family: 'pull', clientIp: CLIENT_IP })).kind, 'allowed');
  }
  const pullDenied = await right.consume({ family: 'pull', clientIp: CLIENT_IP });
  assert.equal(pullDenied.kind, 'denied');

  const evalshaKeys = fake.calls.filter((call) => call.kind === 'evalsha').map((call) => call.args[2] as string);
  assert.ok(evalshaKeys.length >= 3);
  const uniqueKeys = new Set(evalshaKeys);
  assert.equal(uniqueKeys.size, 2, 'push and pull must hash to different keys');
  for (const key of uniqueKeys) {
    assert.equal(key.includes(CLIENT_IP), false);
    assert.equal(key.includes(KEY_SECRET.toString('utf8')), false);
    const parsed = parseSyncColpRateLimitKey(key);
    assert.equal(parsed.kind, 'ok');
    if (parsed.kind === 'ok') {
      assert.equal(parsed.parts.keyPrefix, KEY_PREFIX);
      assert.equal(parsed.parts.subjectHmac, syncColpRateLimitSubjectHmac(KEY_SECRET, CLIENT_IP));
      assert.ok(parsed.parts.family === 'push' || parsed.parts.family === 'pull');
    }
  }
  const pushKey = buildSyncColpRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    family: 'push',
    subject: CLIENT_IP,
    windowStartEpochMs: Math.floor(NOW_MS / PUSH_WINDOW_MS) * PUSH_WINDOW_MS,
  });
  const pullKey = buildSyncColpRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    family: 'pull',
    subject: CLIENT_IP,
    windowStartEpochMs: Math.floor(NOW_MS / PULL_WINDOW_MS) * PULL_WINDOW_MS,
  });
  assert.ok(evalshaKeys.includes(pushKey));
  assert.ok(evalshaKeys.includes(pullKey));
  assert.notEqual(pushKey, pullKey);
  assert.equal(fake.calls[0]?.kind, 'script_load');
  assert.equal(fake.calls[0]?.args[1], RATE_LIMIT_LUA_SCRIPT);
  assert.deepEqual([...SYNC_COLP_RATE_LIMIT_ROUTE_FAMILIES], ['push', 'pull']);
});

test('NOSCRIPT reloads once then succeeds; a stuck NOSCRIPT fails closed (not denied)', async () => {
  const fake = new FakeRateLimitClient();
  let noscriptRemaining = 1;
  fake.evalshaImpl = async () => {
    if (noscriptRemaining > 0) {
      noscriptRemaining -= 1;
      throw replyError('NOSCRIPT No matching script. Please use EVAL.');
    }
    return [1, 1, PUSH_MAX - 1, 60, Math.floor(NOW_MS / PUSH_WINDOW_MS) * PUSH_WINDOW_MS];
  };
  const store = makeStore(fake);
  const recovered = await store.consume({ family: 'push', clientIp: CLIENT_IP });
  assert.equal(recovered.kind, 'allowed');
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ['script_load', 'evalsha', 'script_load', 'evalsha'],
  );

  const stuck = new FakeRateLimitClient();
  stuck.evalshaImpl = async () => { throw replyError('NOSCRIPT No matching script. Please use EVAL.'); };
  const stuckStore = makeStore(stuck);
  const failed = await stuckStore.consume({ family: 'pull', clientIp: CLIENT_IP });
  assertFailure(failed, 'internal', 'rate_limit_noscript');
  assert.notEqual(failed.kind, 'denied');
});

test('codec rejects search/auth hash tags and raw-IP subject segments', () => {
  const key = buildSyncColpRateLimitKey({
    keyPrefix: KEY_PREFIX,
    environment: ENVIRONMENT,
    keySecret: KEY_SECRET,
    family: 'push',
    subject: CLIENT_IP,
    windowStartEpochMs: Math.floor(NOW_MS / PUSH_WINDOW_MS) * PUSH_WINDOW_MS,
  });
  assert.equal(parseSyncColpRateLimitKey(key).kind, 'ok');
  assert.equal(parseSyncColpRateLimitKey(key.replace('{sync:', '{search:')).kind, 'rejected');
  assert.equal(parseSyncColpRateLimitKey(key.replace('{sync:', '{auth:')).kind, 'rejected');
  assert.equal(parseSyncColpRateLimitKey(
    `${KEY_PREFIX}:${ENVIRONMENT}:ratelimit:v1:{sync:${CLIENT_IP}}:push:1`,
  ).kind, 'rejected');
});

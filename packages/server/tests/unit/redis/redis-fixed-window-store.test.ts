/**
 * Shared Redis fixed-window store factory: denied quota stays distinct from
 * store failure, and NOSCRIPT reloads the frozen script exactly once.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test, vi } from 'vitest';
import {
  RATE_LIMIT_LUA_SCRIPT,
  RATE_LIMIT_REDIS_CLIENT_RECREATE_DELAY_MS,
  RATE_LIMIT_REDIS_MAX_RECONNECT_ATTEMPTS,
  RATE_LIMIT_REDIS_POLICY_RECHECK_MS,
  createRedisFixedWindowStore,
  type RateLimitRedisClientLike,
  type RateLimitRedisClientOptions,
  type RedisFixedWindowResult,
} from '../../../src/infrastructure/rate-limit/index.js';

const RATE_MAX = 2;
const WINDOW_MS = 60_000;
const NOW_MS = 1_750_000_000_000;
const WINDOW_START = 1_749_999_960_000;
const KEY = 'known:test:ratelimit:v1:{fw:unit}:factory:1750000000000';

interface FakeCall {
  readonly kind: 'script_load' | 'evalsha';
  readonly args: readonly unknown[];
}

function replyError(message: string): Error {
  const error = new Error(message);
  error.name = 'ReplyError';
  return error;
}

class FakeRateLimitClient extends EventEmitter implements RateLimitRedisClientLike {
  status = 'ready';
  readonly calls: FakeCall[] = [];
  scriptLoadImpl: (script: string) => Promise<string> = async () => 'a'.repeat(40);
  evalshaImpl: (sha: string, args: readonly (string | number)[]) => Promise<unknown> =
    async () => [1, 1, RATE_MAX - 1, 60, WINDOW_START];

  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  quit(): Promise<'OK'> { return Promise.resolve('OK'); }
  script(subcommand: 'LOAD', script: string): Promise<string> {
    this.calls.push({ kind: 'script_load', args: [subcommand, script] });
    return this.scriptLoadImpl(script);
  }
  evalsha(sha: string, numkeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.calls.push({ kind: 'evalsha', args: [sha, numkeys, ...args] });
    return this.evalshaImpl(sha, args);
  }
}

class PolicyAwareRateLimitClient extends FakeRateLimitClient {
  infoCalls = 0;
  infoImpl: () => Promise<string> = async () => '# Memory\r\nmaxmemory_policy:noeviction\r\n';

  info(section: 'memory'): Promise<string> {
    assert.equal(section, 'memory');
    this.infoCalls += 1;
    return this.infoImpl();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function makeStore(
  fake: FakeRateLimitClient,
  overrides: { readonly failureThreshold?: number } = {},
) {
  return createRedisFixedWindowStore<string>({
    redisUrl: 'redis://127.0.0.1:6379',
    commandTimeoutMs: 75,
    connectTimeoutMs: 1000,
    maxRetriesPerRequest: 1,
    createClient: (_url: string, _options: RateLimitRedisClientOptions) => fake,
    now: () => NOW_MS,
    ...(overrides.failureThreshold === undefined ? {} : { failureThreshold: overrides.failureThreshold }),
    resolveAdmission: (subject) => ({
      key: subject,
      rateMax: RATE_MAX,
      windowMs: WINDOW_MS,
    }),
  });
}

function assertFailure(result: RedisFixedWindowResult, failureClass: string, code: string): void {
  assert.equal(result.kind, 'failed');
  if (result.kind !== 'failed') return;
  assert.equal(result.failure.class, failureClass);
  assert.equal(result.failure.code, code);
}

test('a valid reply is allowed; quota exhaustion is denied, never failed', async () => {
  const fake = new FakeRateLimitClient();
  let hits = 0;
  fake.evalshaImpl = async () => {
    hits += 1;
    const allowed = hits <= RATE_MAX ? 1 : 0;
    return [allowed, hits, Math.max(0, RATE_MAX - hits), 60, WINDOW_START];
  };
  const store = makeStore(fake);
  assert.equal((await store.consume(KEY)).kind, 'allowed');
  assert.equal((await store.consume(KEY)).kind, 'allowed');
  const denied = await store.consume(KEY);
  assert.equal(denied.kind, 'denied');
  if (denied.kind !== 'denied') return;
  assert.equal(denied.decision.allowed, false);
  assert.equal(denied.decision.retryAfterSeconds, 60);
  assert.notEqual(denied.kind, 'failed');
  assert.equal(fake.calls[0]?.kind, 'script_load');
  assert.equal(fake.calls[0]?.args[1], RATE_LIMIT_LUA_SCRIPT);
});

test('a malformed reply is failed, not denied; the circuit then fails closed', async () => {
  const fake = new FakeRateLimitClient();
  fake.evalshaImpl = async () => [1, 5];
  const store = makeStore(fake, { failureThreshold: 1 });
  const first = await store.consume(KEY);
  assertFailure(first, 'malformed', 'rate_limit_malformed_reply');
  assert.notEqual(first.kind, 'denied');
  const second = await store.consume(KEY);
  assertFailure(second, 'unavailable', 'rate_limit_circuit_open');
  assert.equal(fake.calls.filter((call) => call.kind === 'evalsha').length, 1);
});

test('NOSCRIPT reloads once and retries; a repeated NOSCRIPT stays failed', async () => {
  const fake = new FakeRateLimitClient();
  let noscriptRemaining = 1;
  fake.evalshaImpl = async () => {
    if (noscriptRemaining > 0) {
      noscriptRemaining -= 1;
      throw replyError('NOSCRIPT No matching script. Please use EVAL.');
    }
    return [1, 1, RATE_MAX - 1, 60, WINDOW_START];
  };
  const store = makeStore(fake);
  const recovered = await store.consume(KEY);
  assert.equal(recovered.kind, 'allowed');
  assert.deepEqual(
    fake.calls.map((call) => call.kind),
    ['script_load', 'evalsha', 'script_load', 'evalsha'],
  );

  const stuck = new FakeRateLimitClient();
  stuck.evalshaImpl = async () => {
    throw replyError('NOSCRIPT No matching script. Please use EVAL.');
  };
  const stuckStore = makeStore(stuck);
  const stuckOutcome = await stuckStore.consume(KEY);
  assertFailure(stuckOutcome, 'internal', 'rate_limit_noscript');
  assert.notEqual(stuckOutcome.kind, 'denied');
  assert.equal(stuck.calls.filter((call) => call.kind === 'script_load').length, 2);
});

test('recreates a terminal rate-limit client after the complete reconnect budget', async () => {
  vi.useFakeTimers();
  const clients: FakeRateLimitClient[] = [];
  let clientOptions: RateLimitRedisClientOptions | undefined;
  const store = createRedisFixedWindowStore<string>({
    redisUrl: 'redis://127.0.0.1:6379',
    commandTimeoutMs: 75,
    connectTimeoutMs: 1_000,
    maxRetriesPerRequest: 1,
    createClient: (_url, options) => {
      clientOptions = options;
      const client = new FakeRateLimitClient();
      clients.push(client);
      return client;
    },
    now: () => NOW_MS,
    resolveAdmission: (subject) => ({ key: subject, rateMax: RATE_MAX, windowMs: WINDOW_MS }),
  });
  await vi.advanceTimersByTimeAsync(0);

  assert.ok(clientOptions);
  const retryBudgetMs = Array.from(
    { length: RATE_LIMIT_REDIS_MAX_RECONNECT_ATTEMPTS },
    (_unused, index) => clientOptions!.retryStrategy(index + 1) ?? 0,
  ).reduce((total, delayMs) => total + delayMs, 0);
  assert.ok(retryBudgetMs > 13_000, 'the simulated outage must exceed the old ~13s budget');
  assert.equal(clientOptions.retryStrategy(RATE_LIMIT_REDIS_MAX_RECONNECT_ATTEMPTS + 1), null);

  clients[0]!.status = 'end';
  clients[0]!.emit('end');
  assert.equal(store.readiness().status, 'degraded');
  await vi.advanceTimersByTimeAsync(RATE_LIMIT_REDIS_CLIENT_RECREATE_DELAY_MS);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(clients.length, 2, 'terminal ioredis instance must be replaced');
  assert.equal(store.readiness().status, 'healthy');
  assert.equal((await store.consume(KEY)).kind, 'allowed');
  assert.equal(clients[0]!.calls.length, 0);
  assert.deepEqual(clients[1]!.calls.map((call) => call.kind), ['script_load', 'evalsha']);
  await store.close();
  assert.equal(vi.getTimerCount(), 0);
});

test('unsafe Redis eviction policy fails closed and recovers only after noeviction is verified', async () => {
  vi.useFakeTimers();
  const client = new PolicyAwareRateLimitClient();
  client.infoImpl = async () => '# Memory\r\nmaxmemory_policy:allkeys-lru\r\n';
  const store = makeStore(client);
  await vi.advanceTimersByTimeAsync(0);
  await Promise.resolve();

  assert.equal(client.infoCalls, 1);
  assert.equal(store.readiness().status, 'degraded');
  const rejected = await store.consume(KEY);
  assertFailure(rejected, 'internal', 'rate_limit_unsafe_eviction_policy');
  assert.equal(client.calls.length, 0, 'unsafe policy must not load or execute quota scripts');

  client.infoImpl = async () => '# Memory\r\nmaxmemory_policy:noeviction\r\n';
  await vi.advanceTimersByTimeAsync(RATE_LIMIT_REDIS_POLICY_RECHECK_MS);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(client.infoCalls, 2);
  assert.equal(store.readiness().status, 'healthy');
  assert.equal((await store.consume(KEY)).kind, 'allowed');
  assert.deepEqual(client.calls.map((call) => call.kind), ['script_load', 'evalsha']);
  await store.close();
  assert.equal(vi.getTimerCount(), 0);
});

test('a disconnected client reports unavailable while its eviction policy is unverified', async () => {
  const client = new PolicyAwareRateLimitClient();
  const store = makeStore(client);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(store.readiness().status, 'healthy');
  assert.equal((await store.consume(KEY)).kind, 'allowed');
  const callsBeforeOutage = client.calls.length;

  client.status = 'reconnecting';
  client.emit('close');

  const rejected = await store.consume(KEY);
  assertFailure(rejected, 'unavailable', 'rate_limit_unavailable');
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(
    client.calls.length,
    callsBeforeOutage,
    'an unready client must fail closed before attempting a quota command',
  );
  await store.close();
});

test('missing maxmemory_policy field is unverified and never admits quota traffic', async () => {
  const client = new PolicyAwareRateLimitClient();
  client.infoImpl = async () => '# Memory\r\nused_memory:1024\r\n';
  const store = makeStore(client);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  const rejected = await store.consume(KEY);
  assertFailure(rejected, 'internal', 'rate_limit_eviction_policy_unverified');
  assert.equal(store.readiness().status, 'degraded');
  assert.equal(client.calls.length, 0);
  await store.close();
});

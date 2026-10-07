/**
 * T05 unit tests (plan §6.4 T05 / §7.2): failure policy — circuit breaker,
 * half-open probing, Redis bypass while open, bounded fallback bulkhead,
 * readiness state and leak-free log serialization.
 *
 * Every test constructs its own breaker, clock and store (no shared state, so
 * one test's failure streak can never pollute another). Interleavings are
 * fixed with event gates, never with bare sleeps; the clock is a plain injected
 * `() => number` so breaker cooldowns are advanced deterministically.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  CacheAbortError,
  CacheBulkhead,
  CacheBulkheadError,
  CacheCircuitBreaker,
  CacheSingleflight,
  CacheStoreError,
  computeCacheReadiness,
  encodeCacheEnvelope,
  readThroughWithFailurePolicy,
  serializeCacheLogEntry,
  redactCacheLogText,
  cacheOutcomeMetricName,
  type CacheBypassResult,
  type CacheFailurePolicyOptions,
  type CacheMetricsResult,
  type CachePolicyReadResult,
  type CacheReadDependencies,
  type CacheReadPolicy,
  type CacheStore,
} from '../../../src/infrastructure/cache/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const DOMAIN = 'publication-metadata';
const KEY = 'known:cache:v1:{pub:collection-1}:metadata:0:abc';
const LOCK_KEY = `${KEY}:lock`;
const SECRET_FRAGMENT = 'super-secret-redis-token-9f8e7d6c5b4a'; // secret-scan: allow 'super-secret-redis-token-9f8e7d6c5b4a' (intentional test fragment used to assert log redaction)

const POLICY: CacheReadPolicy = {
  domain: DOMAIN,
  softTtlMs: 10_000,
  hardTtlMs: 30_000,
  jitterMs: 0,
  serveStale: false,
  maxEntryBytes: 512 * 1024,
  lockTtlMs: 1_500,
  lockWaitCount: 3,
  lockWaitTimeoutMs: 10_000,
};

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Scripted CacheStore: every method records its arguments (the "Redis command
 * count"), `failGet` simulates a Redis outage by throwing an UNAVAILABLE
 * CacheStoreError, and `onGet` is an event hook used to pin a half-open probe
 * inside its Redis read while a concurrent caller must bypass.
 */
class FakeCacheStore implements CacheStore {
  readonly data = new Map<string, string>();
  readonly calls: RecordedCall[] = [];
  failGet = false;
  failSet = false;
  onGet?: (key: string) => Promise<void> | void;

  async get(key: string, _signal: AbortSignal): Promise<string | null> {
    this.record('get', [key]);
    if (this.failGet) throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, `redis down (get ${key}:${SECRET_FRAGMENT})`);
    if (this.onGet) await this.onGet(key);
    return this.data.get(key) ?? null;
  }

  async set(key: string, encodedValue: string, hardTtlMs: number, _signal: AbortSignal): Promise<void> {
    this.record('set', [key, encodedValue, hardTtlMs]);
    if (this.failSet) throw new CacheStoreError(CACHE_ERROR_CATEGORY.UNAVAILABLE, 'redis down (set)');
    this.data.set(key, encodedValue);
  }

  async setIfAbsent(key: string, token: string, lockTtlMs: number, _signal: AbortSignal): Promise<boolean> {
    this.record('setIfAbsent', [key, token, lockTtlMs]);
    if (!this.locks.has(key) || this.locks.get(key)!.token === token) {
      this.locks.set(key, { token, expiresAtMs: Infinity });
      return true;
    }
    return false;
  }

  async releaseIfOwner(key: string, token: string, _signal: AbortSignal): Promise<boolean> {
    this.record('releaseIfOwner', [key, token]);
    if (this.locks.get(key)?.token === token) {
      this.locks.delete(key);
      return true;
    }
    return false;
  }

  async rotateEpoch(_key: string, _epochTtlMs: number, _signal: AbortSignal): Promise<number> {
    this.record('rotateEpoch', [_key]);
    return 1;
  }

  async health(): Promise<'healthy' | 'degraded'> {
    return 'healthy';
  }

  async close(): Promise<void> {}

  private readonly locks = new Map<string, { readonly token: string; readonly expiresAtMs: number }>();

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  get totalCalls(): number {
    return this.calls.length;
  }

  private record(method: string, args: readonly unknown[]): void {
    this.calls.push({ method, args });
  }
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function makeDeps(overrides: Partial<CacheReadDependencies> & { readonly store?: FakeCacheStore } = {}): CacheReadDependencies {
  const store = overrides.store ?? new FakeCacheStore();
  return {
    store,
    loader: overrides.loader ?? (async () => ({ id: 'origin' })),
    clock: overrides.clock ?? (() => Date.now()),
    random: overrides.random ?? (() => 0),
    tokenFactory: overrides.tokenFactory ?? (() => 'token-1'),
    singleflight: overrides.singleflight ?? new CacheSingleflight(),
    bulkhead: overrides.bulkhead ?? new CacheBulkhead(4),
  };
}

function makeFailure(
  now: { value: number },
  overrides: Partial<CacheFailurePolicyOptions> = {},
): CacheFailurePolicyOptions & { readonly breaker: CacheCircuitBreaker; readonly bulkhead: CacheBulkhead } {
  const breaker = overrides.breaker ?? new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, clock: () => now.value });
  const bulkhead = overrides.bulkhead ?? new CacheBulkhead(4);
  return { breaker, bulkhead, clock: () => now.value, ...overrides };
}

function freshEnvelope(clockMs: number): string {
  const encoded = encodeCacheEnvelope(
    { id: 'origin' },
    { writtenAtMs: clockMs, softExpiresAtMs: clockMs + 10_000, hardExpiresAtMs: clockMs + 30_000 },
    { maxEntryBytes: POLICY.maxEntryBytes },
  );
  assert.equal(encoded.kind, 'ok');
  return encoded.encoded;
}

function bypassResult(result: CachePolicyReadResult<unknown>): CacheBypassResult<unknown> {
  assert.equal(result.kind, 'bypass');
  return result.result as CacheBypassResult<unknown>;
}

function readThroughResult(result: CachePolicyReadResult<unknown>): CacheMetricsResult<unknown> {
  assert.equal(result.kind, 'read_through');
  return result.result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CacheCircuitBreaker', () => {
  test('consecutive Redis failures open the breaker; cooldown admits exactly one half-open probe; success closes; probe failure reopens', () => {
    const now = { value: 0 };
    const breaker = new CacheCircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, clock: () => now.value });

    assert.equal(breaker.currentState, 'closed');
    assert.equal(breaker.allowRequest(), true, 'closed breaker always admits Redis commands');

    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.currentState, 'closed', 'below the threshold stays closed');
    assert.equal(breaker.allowRequest(), true);

    breaker.recordFailure();
    assert.equal(breaker.currentState, 'open');
    assert.equal(breaker.allowRequest(), false, 'no commands while open before cooldown');

    now.value += 999;
    assert.equal(breaker.allowRequest(), false, 'still open before the cooldown elapses');

    now.value += 1;
    assert.equal(breaker.allowRequest(), true, 'first call after cooldown is the single probe');
    assert.equal(breaker.currentState, 'half_open');
    assert.equal(breaker.allowRequest(), false, 'only one half-open probe is admitted');

    breaker.recordSuccess();
    assert.equal(breaker.currentState, 'closed', 'a successful probe closes the breaker');
    assert.equal(breaker.allowRequest(), true);

    // A failed probe re-opens the breaker immediately.
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.currentState, 'open');
    now.value += 1_000;
    assert.equal(breaker.allowRequest(), true);
    assert.equal(breaker.currentState, 'half_open');
    breaker.recordFailure();
    assert.equal(breaker.currentState, 'open', 'a failed probe reopens without waiting for the threshold again');
    assert.equal(breaker.allowRequest(), false);
  });

  test('isolation: a fresh breaker instance never inherits another test failure streak', () => {
    const now = { value: 0 };
    const breaker = new CacheCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, clock: () => now.value });
    breaker.recordFailure();
    assert.equal(breaker.currentState, 'closed');
    assert.equal(breaker.consecutiveFailureCount, 1);
    const fresh = new CacheCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, clock: () => now.value });
    assert.equal(fresh.currentState, 'closed');
    assert.equal(fresh.consecutiveFailureCount, 0);
  });
});

describe('readThroughWithFailurePolicy', () => {
  test('a Redis write-back failure opens the breaker and records a Redis error', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    store.failSet = true;
    const metrics = new InMemoryMetrics();
    const breaker = new CacheCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now.value });
    const failure = makeFailure(now, { breaker, metrics });
    const deps = makeDeps({ store, bulkhead: failure.bulkhead });

    const first = await readThroughWithFailurePolicy(KEY, POLICY, deps, signal(), failure);
    assert.equal(first.kind, 'read_through');
    assert.ok(first.kind === 'read_through' && first.result.kind === 'origin');
    if (first.kind === 'read_through' && first.result.kind === 'origin') {
      assert.equal(first.result.cached, false);
      assert.equal(first.result.redisFailure, 'write_unavailable');
    }
    assert.equal(breaker.currentState, 'open');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 1);
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'miss')), 1);

    const commandsBefore = store.totalCalls;
    const second = await readThroughWithFailurePolicy(KEY, POLICY, deps, signal(), failure);
    assert.equal(second.kind, 'bypass');
    assert.equal(store.totalCalls, commandsBefore, 'open breaker must not retry Redis after a write failure');
  });

  test('breaker open: no Redis command is ever issued and the origin loader is used once', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    let loaderCalls = 0;
    const metrics = new InMemoryMetrics();
    const failure = makeFailure(now, {
      breaker: new CacheCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now.value }),
      metrics,
    });
    failure.breaker.recordFailure();

    const result = await readThroughWithFailurePolicy(
      KEY,
      POLICY,
      makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'origin' }; } }),
      signal(),
      failure,
    );

    assert.equal(result.kind, 'bypass');
    const bypass = bypassResult(result);
    assert.equal(bypass.kind, 'origin');
    assert.equal((bypass as { value: { id: string } }).value.id, 'origin');
    assert.equal(result.policy.touchedRedis, false);
    assert.equal(result.policy.circuitState, 'open');
    assert.equal(loaderCalls, 1);
    assert.equal(store.totalCalls, 0, 'no get/set/setIfAbsent/releaseIfOwner while the breaker is open');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0, 'a bypass is not a redis error');
  });

  test('consecutive unavailable reads trip the breaker through the wrapper and later requests bypass Redis', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    store.failGet = true;
    const metrics = new InMemoryMetrics();
    const failure = makeFailure(now, {
      breaker: new CacheCircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, clock: () => now.value }),
      metrics,
    });

    const first = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    assert.equal(first.kind, 'read_through');
    assert.equal((first.result as { kind: 'origin'; path: string }).path, 'cache_unavailable');
    assert.equal(failure.breaker.currentState, 'closed');

    const second = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    assert.equal(second.kind, 'read_through');
    assert.equal(failure.breaker.currentState, 'open', 'second consecutive Redis failure opens the breaker');
    assert.equal(store.callsOf('get').length, 2);
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 2);
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 2);

    // After cooldown the first caller is the single probe; the concurrent second
    // caller must bypass without sending a single Redis command.
    now.value += 1_000;
    const firstProbe = readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    const secondBypass = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    assert.equal((await firstProbe).kind, 'read_through');
    assert.equal(secondBypass.kind, 'bypass');
    assert.equal(store.callsOf('get').length, 3, 'only the single probe touched Redis');
  });

  test('half-open admits exactly one probe; the concurrent caller bypasses and the probe success closes the breaker', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    store.data.set(KEY, freshEnvelope(0));
    const metrics = new InMemoryMetrics();
    const failure = makeFailure(now, {
      breaker: new CacheCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now.value }),
      metrics,
    });
    failure.breaker.recordFailure();
    now.value += 1_000;

    let markEnteredGet!: () => void;
    let releaseGet!: () => void;
    const enteredGet = new Promise<void>((resolve) => { markEnteredGet = resolve; });
    const gate = new Promise<void>((resolve) => { releaseGet = resolve; });
    store.onGet = async () => { markEnteredGet(); await gate; };

    const probe = readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store, clock: () => now.value }), signal(), failure);
    await enteredGet; // probe is now inside its single Redis read
    assert.equal(store.callsOf('get').length, 1);

    const concurrent = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store, clock: () => now.value }), signal(), failure);
    assert.equal(concurrent.kind, 'bypass', 'second caller while half-open must bypass');
    assert.equal(store.callsOf('get').length, 1, 'no extra Redis command for the bypassed caller');
    assert.equal(failure.breaker.currentState, 'half_open');

    releaseGet();
    const probeResult = await probe;
    assert.equal(probeResult.kind, 'read_through');
    assert.equal(readThroughResult(probeResult).kind, 'cache_hit');
    assert.equal(probeResult.policy.probe, true);
    assert.equal(failure.breaker.currentState, 'closed', 'successful probe closes the breaker');
    assert.equal(store.callsOf('get').length, 1);
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'hit')), 1);
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);
  });

  test('a cancelled loader in the closed state never trips the breaker and a later real outage still opens it', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    const metrics = new InMemoryMetrics();
    const failure = makeFailure(now, {
      breaker: new CacheCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now.value }),
      metrics,
    });

    await assert.rejects(
      readThroughWithFailurePolicy(
        KEY,
        POLICY,
        makeDeps({ store, loader: async () => { throw new CacheAbortError('origin cancelled'); } }),
        signal(),
        failure,
      ),
      CacheAbortError,
    );
    assert.equal(failure.breaker.currentState, 'closed', 'a client cancellation must never open the breaker');
    assert.equal(failure.breaker.consecutiveFailureCount, 0, 'a client cancellation must never count as a Redis failure');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0);

    // A real Redis outage afterwards still opens the breaker: the cancellation
    // must not have masked the fault.
    store.failGet = true;
    const real = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    assert.equal(real.kind, 'read_through');
    assert.equal((real.result as { kind: 'origin'; path: string }).path, 'cache_unavailable');
    assert.equal(failure.breaker.currentState, 'open', 'a real unavailable must still open the breaker');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 1);
  });

  test('aborting a singleflight waiter in the closed state counts nothing and the leader completes', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    const metrics = new InMemoryMetrics();
    const failure = makeFailure(now, {
      breaker: new CacheCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now.value }),
      metrics,
    });

    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve; });
    let loaderCalls = 0;
    const shared = makeDeps({
      store,
      loader: async () => {
        loaderCalls += 1;
        markEntered();
        await loaderGate;
        return { id: 'origin' };
      },
    });

    const leader = readThroughWithFailurePolicy(KEY, POLICY, shared, signal(), failure);
    await entered; // the leader is now the singleflight leader inside the loader
    const waiterController = new AbortController();
    const waiter = readThroughWithFailurePolicy(KEY, POLICY, shared, waiterController.signal, failure);
    await flush();
    waiterController.abort();
    await assert.rejects(waiter, CacheAbortError);

    assert.equal(failure.breaker.currentState, 'closed', 'a cancelled waiter must never trip the breaker');
    assert.equal(failure.breaker.consecutiveFailureCount, 0, 'a cancelled waiter must never count as a Redis failure');
    assert.equal(loaderCalls, 1, 'the cancelled waiter must not start its own origin load');

    releaseLoader();
    const leaderResult = await leader;
    assert.equal(leaderResult.kind, 'read_through');
    assert.equal(readThroughResult(leaderResult).kind, 'origin');
    assert.equal(failure.breaker.currentState, 'closed', 'a successful leader must keep the breaker closed');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0);
  });

  test('an aborted half-open probe is settled without a failure or success and the next caller re-probes', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    const metrics = new InMemoryMetrics();
    const breaker = new CacheCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now.value });
    const failure = makeFailure(now, { breaker, metrics });
    breaker.recordFailure();
    now.value += 1_000; // cooldown elapsed: the next caller is the single probe

    await assert.rejects(
      readThroughWithFailurePolicy(
        KEY,
        POLICY,
        makeDeps({ store, loader: async () => { throw new CacheAbortError('probe cancelled'); } }),
        signal(),
        failure,
      ),
      CacheAbortError,
    );
    assert.equal(failure.breaker.currentState, 'half_open', 'an aborted probe must never be recorded as success');
    assert.equal(failure.breaker.consecutiveFailureCount, 1, 'an aborted probe must never count as a Redis failure');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0);

    // The probe slot was released: the very next caller is admitted as a fresh
    // probe (no new cooldown) and its success closes the breaker.
    const recovery = await readThroughWithFailurePolicy(
      KEY,
      POLICY,
      makeDeps({ store, loader: async () => ({ id: 'origin' }) }),
      signal(),
      failure,
    );
    assert.equal(recovery.kind, 'read_through', 'the next caller must be admitted as the re-probe, not bypassed');
    assert.equal(recovery.policy.probe, true);
    assert.equal(recovery.policy.touchedRedis, true);
    assert.equal(failure.breaker.currentState, 'closed', 'the successful re-probe closes the breaker');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0);
    assert.equal(store.callsOf('get').length, 2, 'exactly one Redis read per admitted probe');
  });

  test('a half-open probe that hits a real Redis outage reopens the breaker and counts the failure', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    const metrics = new InMemoryMetrics();
    const breaker = new CacheCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, clock: () => now.value });
    const failure = makeFailure(now, { breaker, metrics });
    breaker.recordFailure();
    now.value += 1_000;

    store.failGet = true;
    const failedProbe = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    assert.equal(failedProbe.kind, 'read_through');
    assert.equal(failedProbe.policy.probe, true);
    assert.equal((failedProbe.result as { kind: 'origin'; path: string }).path, 'cache_unavailable');
    assert.equal(failure.breaker.currentState, 'open', 'a failed probe reopens the breaker immediately');
    assert.equal(failure.breaker.consecutiveFailureCount, 2);
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 1, 'a real outage counts as a Redis failure');

    // After another cooldown a fresh probe recovers once Redis is reachable.
    now.value += 1_000;
    store.failGet = false;
    const recovery = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    assert.equal(recovery.kind, 'read_through');
    assert.equal(recovery.policy.probe, true);
    assert.equal(failure.breaker.currentState, 'closed', 'the recovered probe closes the breaker');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 1, 'recovery adds no new Redis failure');
  });

  test('fallback bulkhead at capacity returns a controlled rejection instead of waiting forever', async () => {
    const now = { value: 0 };
    const bulkhead = new CacheBulkhead(1);
    const metrics = new InMemoryMetrics();
    const failure = makeFailure(now, { bulkhead, metrics });
    failure.breaker.recordFailure();
    failure.breaker.recordFailure();
    failure.breaker.recordFailure();

    let releaseSlot!: () => void;
    const slotGate = new Promise<void>((resolve) => { releaseSlot = resolve; });
    let loaderCalls = 0;
    const occupying = bulkhead.run(signal(), async () => { await slotGate; return 'busy'; });
    assert.equal(bulkhead.activeCount, 1, 'the single bulkhead slot is occupied');

    const result = await readThroughWithFailurePolicy(
      KEY,
      POLICY,
      makeDeps({ bulkhead, loader: async () => { loaderCalls += 1; return { id: 'origin' }; } }),
      signal(),
      failure,
    );

    assert.equal(result.kind, 'bypass');
    const bypass = bypassResult(result);
    assert.equal(bypass.kind, 'fallback_rejected');
    assert.equal((bypass as { reason: string }).reason, 'bulkhead_full');
    assert.equal(loaderCalls, 0, 'no origin load starts when the bulkhead is full');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);

    releaseSlot();
    assert.equal(await occupying, 'busy');
  });

  test('closed breaker path also reports a controlled bulkhead rejection from readThrough', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore(); // get -> miss
    const bulkhead = new CacheBulkhead(1);
    const metrics = new InMemoryMetrics();
    const failure = makeFailure(now, { bulkhead, metrics });

    let releaseSlot!: () => void;
    const slotGate = new Promise<void>((resolve) => { releaseSlot = resolve; });
    const occupying = bulkhead.run(signal(), async () => { await slotGate; return 'busy'; });

    const result = await readThroughWithFailurePolicy(
      KEY,
      POLICY,
      makeDeps({ store, bulkhead, loader: async () => ({ id: 'origin' }) }),
      signal(),
      failure,
    );

    assert.equal(result.kind, 'read_through');
    assert.equal(readThroughResult(result).kind, 'fallback_rejected');
    assert.equal(metrics.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);

    releaseSlot();
    await occupying;
  });
});

describe('readiness', () => {
  test('mode off is always disabled; serve reflects breaker and store health', () => {
    assert.equal(computeCacheReadiness({ mode: 'off', circuitState: 'closed', storeHealth: 'healthy' }), 'disabled');
    assert.equal(computeCacheReadiness({ mode: 'off', circuitState: 'open', storeHealth: 'degraded' }), 'disabled');
    assert.equal(computeCacheReadiness({ mode: 'serve', circuitState: 'closed', storeHealth: 'healthy' }), 'healthy');
    assert.equal(computeCacheReadiness({ mode: 'shadow', circuitState: 'closed', storeHealth: 'healthy' }), 'healthy');
    assert.equal(computeCacheReadiness({ mode: 'serve', circuitState: 'open', storeHealth: 'healthy' }), 'degraded');
    assert.equal(computeCacheReadiness({ mode: 'serve', circuitState: 'half_open', storeHealth: 'healthy' }), 'degraded');
    assert.equal(computeCacheReadiness({ mode: 'serve', circuitState: 'closed', storeHealth: 'degraded' }), 'degraded');
  });
});

describe('log serialization', () => {
  test('structured log entries carry only domain/outcome/duration/error classification and never raw keys or error text', () => {
    const error = new CacheStoreError(
      CACHE_ERROR_CATEGORY.UNAVAILABLE,
      `redis get failed for key ${KEY} with token ${SECRET_FRAGMENT}`,
    );
    const entry = serializeCacheLogEntry({ domain: DOMAIN, outcome: 'redis_error', durationMs: 42, error });
    const json = JSON.stringify(entry);
    assert.deepEqual(Object.keys(entry).sort(), ['domain', 'durationMs', 'errorCategory', 'event', 'outcome']);
    assert.equal(entry.errorCategory, 'cache_unavailable');
    assert.ok(!json.includes(SECRET_FRAGMENT), 'secret must never appear in the serialized log');
    assert.ok(!json.includes(KEY), 'raw cache key must never appear in the serialized log');
  });

  test('redactCacheLogText redacts sensitive fragments from free-form text before it reaches a sink', () => {
    const raw = `redis command failed for ${KEY} password=${SECRET_FRAGMENT} url=redis://user:${SECRET_FRAGMENT}@host:6379/0`;
    const redacted = redactCacheLogText(raw);
    assert.ok(!redacted.includes(SECRET_FRAGMENT), 'sensitive fragment must be redacted');
    assert.ok(redacted.includes('[REDACTED]'), 'redaction is visible');
  });

  test('the wrapper logs classified failures without leaking the error message', async () => {
    const now = { value: 0 };
    const store = new FakeCacheStore();
    store.failGet = true;
    const collected: string[] = [];
    const failure = makeFailure(now, {
      log: (entry) => collected.push(JSON.stringify(entry)),
    });

    const result = await readThroughWithFailurePolicy(KEY, POLICY, makeDeps({ store }), signal(), failure);
    assert.equal(result.kind, 'read_through');
    assert.equal(collected.length, 1);
    const entry = JSON.parse(collected[0]) as { errorCategory?: string; outcome: string; domain: string; durationMs: number };
    assert.equal(entry.domain, DOMAIN);
    assert.equal(entry.outcome, 'redis_error');
    assert.equal(entry.errorCategory, 'cache_unavailable');
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(!collected[0].includes(SECRET_FRAGMENT));
    assert.ok(!collected[0].includes(KEY));
    assert.ok(!collected[0].includes('redis down'));
  });
});

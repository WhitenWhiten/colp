/**
 * T04 unit tests (plan §6.4 T04 / §7.2 / §7.3): the domain-neutral readThrough
 * cache-aside policy against a scripted CacheStore.
 *
 * The fake CacheStore records every get/set/setIfAbsent/releaseIfOwner call and
 * its arguments, and simulates real Redis semantics for the lock (SET NX with
 * expiry and token-guarded release). Tests call the production readThrough and
 * CacheSingleflight/CacheBulkhead; barriers and gates fix every interleaving
 * (no bare Promise.all is used to infer a race). TTL tests inject a fake clock
 * and a deterministic random source; concurrent lock tests use fake timers.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import {
  CacheAbortError,
  CacheBulkhead,
  CacheBulkheadError,
  CacheReadPolicyError,
  CacheSingleflight,
  buildCacheLockKey,
  buildCacheSingleflightKey,
  cacheDefaultSleep,
  computeCacheLockPollIntervalMs,
  decodeCacheEnvelope,
  readThrough,
  type CacheReadPolicy,
} from '../../../src/infrastructure/cache/index.js';
import { FakeCacheStore } from '../../support/cache-test-fixtures.js';
import {
  KEY,
  LOCK_KEY,
  POLICY,
  encodeEnvelope,
  encodeHardExpired,
  encodeSoftExpired,
  flush,
  makeDeps,
  signal,
} from '../../support/read-through-cache-helpers.js';


describe('readThrough cache policy', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a fresh hit returns the cached value with exactly zero loader calls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    const store = new FakeCacheStore();
    store.data.set(KEY, encodeEnvelope({ id: 'c-1' }, 50_000, POLICY));
    const singleflight = new CacheSingleflight();
    let loaderCalls = 0;
    const deps = makeDeps({
      store,
      singleflight,
      loader: async () => { loaderCalls += 1; return { id: 'origin' }; },
    });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'cache_hit');
    if (result.kind === 'cache_hit') assert.deepEqual(result.value, { id: 'c-1' });
    assert.equal(loaderCalls, 0, 'a fresh hit must never touch the loader');
    assert.equal(singleflight.pendingCount, 0);
    assert.equal(store.callsOf('get').length, 1);
    assert.equal(store.callsOf('set').length, 0);
    assert.equal(store.callsOf('setIfAbsent').length, 0);
    assert.equal(store.callsOf('releaseIfOwner').length, 0);
  });

  test('concurrent misses merge into exactly one origin load and identical results', async () => {
    const store = new FakeCacheStore();
    const singleflight = new CacheSingleflight();
    let getCalls = 0;
    let releaseGets!: () => void;
    const getsGate = new Promise<void>((resolve) => { releaseGets = resolve; });
    store.onGet = async () => {
      getCalls += 1;
      if (getCalls === 2) releaseGets();
      await getsGate; // hold both reads so the barrier proves a real miss interleaving
    };
    let loaderCalls = 0;
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve; });

    const deps = makeDeps({
      store,
      singleflight,
      loader: async () => { loaderCalls += 1; await loaderGate; return { id: 'c-1' }; },
    });
    const first = readThrough(KEY, POLICY, deps, signal());
    await flush();
    const second = readThrough(KEY, POLICY, deps, signal());
    await flush();
    assert.equal(getCalls, 2, 'both reads must hit the barrier before either refreshes');

    releaseGets();
    await flush();
    assert.equal(loaderCalls, 1, 'singleflight must merge the two misses');

    releaseLoader();
    const [r1, r2] = await Promise.all([first, second]);
    assert.deepEqual(r1, r2, 'merged waiters must receive the identical result');
    assert.equal(r1.kind, 'origin');
    if (r1.kind === 'origin') {
      assert.equal(r1.value.id, 'c-1');
      assert.equal(r1.cached, true, 'a successful miss must be written back');
    }
    assert.equal(loaderCalls, 1);
    assert.equal(singleflight.pendingCount, 0);
    assert.equal(store.callsOf('set').length, 1);

    const setIfAbsent = store.callsOf('setIfAbsent');
    const release = store.callsOf('releaseIfOwner');
    assert.equal(setIfAbsent.length, 1);
    assert.equal(release.length, 1);
    assert.deepEqual(release[0].args, [setIfAbsent[0].args[0], setIfAbsent[0].args[1]],
      'release must use the exact lock key and token that were acquired');
  });

  test('concurrent misses for different keys load independently', async () => {
    const store = new FakeCacheStore();
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'x' }; } });
    const [a, b] = await Promise.all([
      readThrough('key-a', POLICY, deps, signal()),
      readThrough('key-b', POLICY, deps, signal()),
    ]);
    assert.equal(loaderCalls, 2);
    assert.equal(a.kind, 'origin');
    assert.equal(b.kind, 'origin');
  });

  test('readThrough scopes singleflight entries by domain and data key', async () => {
    const store = new FakeCacheStore();
    const real = new CacheSingleflight();
    const flightKeys: string[] = [];
    const spyRun = <T>(flightKey: string, sig: AbortSignal, fn: (s: AbortSignal) => Promise<T>): Promise<T> => {
      flightKeys.push(flightKey);
      return real.run(flightKey, sig, fn);
    };
    const deps = makeDeps({
      store,
      singleflight: { run: spyRun },
      loader: async () => ({ id: 'x' }),
    });
    await readThrough('data-key-a', { ...POLICY, domain: 'domain-a' }, deps, signal());
    await readThrough('data-key-b', { ...POLICY, domain: 'domain-b' }, deps, signal());
    assert.deepEqual(flightKeys, ['domain-a:data-key-a', 'domain-b:data-key-b']);
  });

  test('redis unavailable fails open to the origin without throwing to the reader', async () => {
    const store = new FakeCacheStore();
    store.failGet = true;
    store.failSet = true;
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'origin' }; } });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'origin');
    if (result.kind === 'origin') {
      assert.equal(result.path, 'cache_unavailable');
      assert.equal(result.cached, false);
    }
    assert.equal(loaderCalls, 1);
    assert.equal(store.callsOf('set').length, 1, 'a write-back attempt is observable');
    assert.equal(store.callsOf('setIfAbsent').length, 0);
    assert.equal(store.callsOf('releaseIfOwner').length, 0);
  });

  test('a lock command failure also fails open to the origin', async () => {
    const store = new FakeCacheStore();
    store.failSetIfAbsent = true;
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'origin' }; } });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'origin');
    if (result.kind === 'origin') assert.equal(result.path, 'lock_unavailable');
    assert.equal(loaderCalls, 1);
  });

  test('a corrupt cached value is treated as a miss, refreshed and overwritten', async () => {
    const store = new FakeCacheStore();
    store.data.set(KEY, '{not-json');
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'fresh' }; } });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'origin');
    if (result.kind === 'origin') assert.equal(result.path, 'decode_error');
    assert.equal(loaderCalls, 1);
    assert.equal(store.callsOf('set').length, 1, 'the corrupt value must be overwritten');
  });

  test('a hard-expired value is treated as a miss and reloaded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const store = new FakeCacheStore();
    store.data.set(KEY, encodeHardExpired({ id: 'old' }, 100_000, POLICY));
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'fresh' }; } });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'origin');
    assert.equal(loaderCalls, 1);
  });

  test('loader failure returns loader_error, writes nothing and releases the lock', async () => {
    const store = new FakeCacheStore();
    const deps = makeDeps({ store, loader: async () => { throw new Error('db down'); } });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'loader_error');
    if (result.kind === 'loader_error') assert.equal(result.path, 'miss');
    assert.equal(store.callsOf('set').length, 0, 'a failed loader must never write');
    assert.equal(store.callsOf('setIfAbsent').length, 1);
    assert.equal(store.callsOf('releaseIfOwner').length, 1, 'the acquired lock must be released in finally');
  });

  test('a loader returning null yields not_found and never writes', async () => {
    const store = new FakeCacheStore();
    const deps = makeDeps({ store, loader: async () => null });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'not_found');
    assert.equal(store.callsOf('set').length, 0);
    assert.equal(store.callsOf('releaseIfOwner').length, 1);
  });

  test('an oversized loader value is served from origin but never written', async () => {
    const store = new FakeCacheStore();
    const deps = makeDeps({ store, loader: async () => ({ data: 'x'.repeat(POLICY.maxEntryBytes) }) });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'origin');
    if (result.kind === 'origin') assert.equal(result.cached, false);
    assert.equal(store.callsOf('set').length, 0, 'oversized values must not be written');
  });

  test('write-back TTLs use the policy and jitter is downward-only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new FakeCacheStore();
    const deps = makeDeps({ store, random: () => 0.5, tokenFactory: () => 'tok' });
    const policy = { ...POLICY, jitterMs: 5_000 };
    const result = await readThrough(KEY, policy, deps, signal());
    assert.equal(result.kind, 'origin');
    const setCalls = store.callsOf('set');
    assert.equal(setCalls.length, 1);
    const [, encoded, ttlMs] = setCalls[0].args;
    const decoded = decodeCacheEnvelope(encoded as string, { maxEntryBytes: policy.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const { writtenAtMs, softExpiresAtMs, hardExpiresAtMs } = decoded.envelope;
      assert.equal(writtenAtMs, 1_000);
      assert.equal(softExpiresAtMs, 1_000 + policy.softTtlMs);
      assert.ok(hardExpiresAtMs <= 1_000 + policy.hardTtlMs, 'jitter must never exceed the hard TTL');
      assert.ok(hardExpiresAtMs < 1_000 + policy.hardTtlMs, 'jitter is applied downward');
      assert.ok(softExpiresAtMs < hardExpiresAtMs, 'soft must stay strictly below hard');
      assert.equal(ttlMs, hardExpiresAtMs - 1_000, 'the Redis TTL must equal the computed hard TTL');
    }

    // With no jitter the hard expiry is exactly now + hardTtlMs.
    const store2 = new FakeCacheStore();
    const deps2 = makeDeps({ store: store2 });
    await readThrough(KEY, POLICY, deps2, signal());
    const [, encoded2, ttlMs2] = store2.callsOf('set')[0].args;
    const decoded2 = decodeCacheEnvelope(encoded2 as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded2.kind, 'ok');
    if (decoded2.kind === 'ok') {
      assert.equal(decoded2.envelope.hardExpiresAtMs, 1_000 + POLICY.hardTtlMs);
      assert.equal(ttlMs2, POLICY.hardTtlMs);
    }
  });

  test('a maximum random sample still never exceeds the hard TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const store = new FakeCacheStore();
    const deps = makeDeps({ store, random: () => 0.999999, tokenFactory: () => 'tok' });
    await readThrough(KEY, { ...POLICY, jitterMs: 5_000 }, deps, signal());
    const [, encoded] = store.callsOf('set')[0].args;
    const decoded = decodeCacheEnvelope(encoded as string, { maxEntryBytes: POLICY.maxEntryBytes });
    assert.equal(decoded.kind, 'ok');
    if (decoded.kind === 'ok') {
      const { softExpiresAtMs, hardExpiresAtMs } = decoded.envelope;
      assert.ok(hardExpiresAtMs <= 2_000 + POLICY.hardTtlMs);
      assert.ok(softExpiresAtMs < hardExpiresAtMs);
    }
  });

  test('serveStale=false never returns a soft-expired value after a refresh failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const store = new FakeCacheStore();
    store.data.set(KEY, encodeSoftExpired({ id: 'stale' }, 100_000, POLICY));
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; throw new Error('origin boom'); } });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'loader_error', 'serveStale=false must never hand back the stale value');
    if (result.kind === 'loader_error') assert.equal(result.path, 'soft_expired');
    assert.equal(loaderCalls, 1);
    assert.equal(store.callsOf('set').length, 0);
  });

  test('serveStale=true serves the soft-expired value without refreshing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const store = new FakeCacheStore();
    store.data.set(KEY, encodeSoftExpired({ id: 'stale' }, 100_000, POLICY));
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'fresh' }; } });
    const result = await readThrough(KEY, { ...POLICY, serveStale: true }, deps, signal());
    assert.equal(result.kind, 'stale_hit');
    assert.equal(loaderCalls, 0);
    assert.equal(store.callsOf('setIfAbsent').length, 0);
  });

  test('a dead lock owner expires and a later request takes over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new FakeCacheStore();
    store.locks.set(LOCK_KEY, { token: 'dead-owner', expiresAtMs: POLICY.lockTtlMs });
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'c-1' }; } });
    const pending = readThrough(KEY, POLICY, deps, signal());
    await flush();
    await vi.advanceTimersByTimeAsync(POLICY.lockTtlMs); // lock expires while the owner is gone
    const result = await pending;
    assert.equal(result.kind, 'origin');
    assert.equal(loaderCalls, 1, 'the takeover must be the only loader call');
    const setIfAbsent = store.callsOf('setIfAbsent');
    const release = store.callsOf('releaseIfOwner');
    assert.equal(setIfAbsent.length, 5,
      'short polls keep trying until the lease expires; the first attempt after expiry takes over');
    assert.equal(release.length, 1);
    assert.deepEqual(release[0].args, [setIfAbsent[4].args[0], setIfAbsent[4].args[1]]);
  });

  test('a non-owner waits for the owner and serves the refreshed cache value', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new FakeCacheStore();
    store.locks.set(LOCK_KEY, { token: 'other-owner', expiresAtMs: POLICY.lockTtlMs });
    store.onSetIfAbsent = async (lockKey) => {
      if (lockKey === LOCK_KEY) {
        setTimeout(() => {
          store.data.set(KEY, encodeEnvelope({ id: 'owner-value' }, POLICY.lockTtlMs, POLICY));
        }, POLICY.lockTtlMs);
      }
    };
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'origin' }; } });
    const pending = readThrough(KEY, POLICY, deps, signal());
    await flush();
    await vi.advanceTimersByTimeAsync(POLICY.lockTtlMs); // owner writes the cache, lock wait resolves
    const result = await pending;
    assert.equal(result.kind, 'cache_hit', 'the waiter must observe the owner refresh');
    if (result.kind === 'cache_hit') assert.deepEqual(result.value, { id: 'owner-value' });
    assert.equal(loaderCalls, 0, 'the waiter must not load when the owner succeeded');
    assert.equal(store.callsOf('setIfAbsent').length, 4,
      'one rejected acquire per short poll until the owner write is observed');
    assert.equal(store.callsOf('releaseIfOwner').length, 0);
  });

  test('a waiter notices a completed owner refresh long before the lock TTL elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new FakeCacheStore();
    store.locks.set(LOCK_KEY, { token: 'fast-owner', expiresAtMs: POLICY.lockTtlMs });
    store.onSetIfAbsent = async (lockKey) => {
      if (lockKey === LOCK_KEY) {
        // The owner finishes in 100ms while its lease still runs for the full TTL.
        // The fixture encodes writtenAtMs = now - 1000, which must stay
        // non-negative; now=1100 keeps writtenAtMs == 100 (the owner's finish).
        setTimeout(() => {
          store.data.set(KEY, encodeEnvelope({ id: 'owner-value' }, 1_100, POLICY));
        }, 100);
      }
    };
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'origin' }; } });
    const pending = readThrough(KEY, POLICY, deps, signal());
    await flush();
    // 500ms is 1s before the 1500ms lease expires: the waiter must already be done.
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    const result = await pending;
    assert.equal(result.kind, 'cache_hit', 'the waiter must observe the owner refresh');
    if (result.kind === 'cache_hit') assert.deepEqual(result.value, { id: 'owner-value' });
    assert.equal(loaderCalls, 0, 'the waiter must never load when the owner succeeded');
    assert.equal(store.callsOf('setIfAbsent').length, 1,
      'a single rejected acquire suffices once the data turns fresh');
  });

  test('lock waiters poll at a short jittered interval instead of sleeping the full lease TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new FakeCacheStore();
    store.locks.set(LOCK_KEY, { token: 'jittery-owner', expiresAtMs: POLICY.lockTtlMs });
    store.onSetIfAbsent = async (lockKey) => {
      if (lockKey === LOCK_KEY) {
        setTimeout(() => {
          store.data.set(KEY, encodeEnvelope({ id: 'owner-value' }, 1_100, POLICY));
        }, 100);
      }
    };
    const sleeps: number[] = [];
    const deps = makeDeps({
      store,
      random: () => 0.5, // jittered poll: base interval + floor(0.5 * (base + 1))
      sleep: async (ms, sig) => { sleeps.push(ms); await cacheDefaultSleep(ms, sig); },
      loader: async () => ({ id: 'origin' }),
    });
    const pending = readThrough(KEY, POLICY, deps, signal());
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    const result = await pending;
    assert.equal(result.kind, 'cache_hit');
    if (result.kind === 'cache_hit') assert.deepEqual(result.value, { id: 'owner-value' });
    assert.equal(sleeps.length, 1, 'the fresh value must end the wait after a single poll');
    assert.ok(sleeps[0] < POLICY.lockTtlMs, 'a waiter must poll well before the lease TTL, not sleep through it');
    assert.ok(sleeps[0] > computeCacheLockPollIntervalMs(POLICY.lockTtlMs),
      'the poll sleep must carry jitter to desynchronize concurrent waiters');
  });

  test('lock-wait exhaustion falls back through the bulkhead without serving stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new FakeCacheStore();
    store.locks.set(LOCK_KEY, { token: 'sticky-owner', expiresAtMs: Number.POSITIVE_INFINITY });
    const policy = { ...POLICY, lockWaitCount: 10, lockWaitTimeoutMs: POLICY.lockTtlMs };
    let loaderCalls = 0;
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'fallback' }; } });
    const pending = readThrough(KEY, policy, deps, signal());
    await flush();
    await vi.advanceTimersByTimeAsync(POLICY.lockTtlMs); // lock wait budget elapses
    const result = await pending;
    assert.equal(result.kind, 'origin');
    if (result.kind === 'origin') assert.equal(result.path, 'lock_wait_exceeded');
    assert.equal(loaderCalls, 1);
  });

  test('releaseIfOwner is token-safe: an old token can never delete a new owner lock', async () => {
    const store = new FakeCacheStore();
    let acquiredToken: string | undefined;
    const baseSetIfAbsent = store.setIfAbsent.bind(store);
    store.setIfAbsent = async (key, token, lockTtlMs, sig) => {
      const ok = await baseSetIfAbsent(key, token, lockTtlMs, sig);
      if (ok) acquiredToken = token;
      return ok;
    };
    const deps = makeDeps({
      store,
      tokenFactory: () => 'my-token',
      loader: async () => {
        // Before this owner releases, a new process has already stolen the lock.
        store.locks.set(LOCK_KEY, { token: 'new-owner-token', expiresAtMs: Date.now() + 1_500 });
        throw new Error('origin boom');
      },
    });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'loader_error');
    assert.equal(acquiredToken, 'my-token');
    const release = store.callsOf('releaseIfOwner');
    assert.equal(release.length, 1);
    assert.deepEqual(release[0].args, [LOCK_KEY, 'my-token']);
    assert.equal(store.locks.get(LOCK_KEY)?.token, 'new-owner-token', 'the new owner lock must survive');
  });

  test('a full bulkhead returns the controlled bulkhead_full error without waiting', async () => {
    const store = new FakeCacheStore();
    const bulkhead = new CacheBulkhead(1);
    let releaseOccupant!: () => void;
    const occupantGate = new Promise<void>((resolve) => { releaseOccupant = resolve; });
    const occupant = bulkhead.run(signal(), async () => { await occupantGate; return 'occupant'; });
    await flush();
    const deps = makeDeps({ store, bulkhead, loader: async () => ({ id: 'origin' }) });
    const result = await readThrough(KEY, POLICY, deps, signal());
    assert.equal(result.kind, 'fallback_rejected');
    if (result.kind === 'fallback_rejected') assert.equal(result.reason, 'bulkhead_full');
    assert.equal(store.callsOf('releaseIfOwner').length, 1, 'the acquired lock is still released');
    releaseOccupant();
    await occupant;
  });

  test('CacheBulkhead rejects the next run when capacity is exhausted and frees it afterwards', async () => {
    const bulkhead = new CacheBulkhead(2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const a = bulkhead.run(signal(), async () => { await gate; return 'a'; });
    const b = bulkhead.run(signal(), async () => { await gate; return 'b'; });
    await flush();
    await assert.rejects(bulkhead.run(signal(), async () => 'c'), CacheBulkheadError);
    release();
    assert.equal(await a, 'a');
    assert.equal(await b, 'b');
    assert.equal(await bulkhead.run(signal(), async () => 'c'), 'c');
  });

  test('aborting while waiting for the lock rejects without a dangling flight or lock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new FakeCacheStore();
    store.locks.set(LOCK_KEY, { token: 'other-owner', expiresAtMs: POLICY.lockTtlMs });
    const singleflight = new CacheSingleflight();
    let loaderCalls = 0;
    const deps = makeDeps({ store, singleflight, loader: async () => { loaderCalls += 1; return { id: 'x' }; } });
    const controller = new AbortController();
    const pending = readThrough(KEY, POLICY, deps, controller.signal);
    await flush();
    controller.abort();
    await assert.rejects(pending, CacheAbortError);
    assert.equal(loaderCalls, 0);
    assert.equal(singleflight.pendingCount, 0);
    assert.equal(store.callsOf('releaseIfOwner').length, 0, 'a lock that was never acquired is not released');
    assert.equal(store.callsOf('setIfAbsent').length, 1);
  });

  test('a loader abort propagates CacheAbortError, releases the lock and writes nothing', async () => {
    const store = new FakeCacheStore();
    const deps = makeDeps({ store, loader: async () => { throw new CacheAbortError('origin cancelled'); } });
    await assert.rejects(readThrough(KEY, POLICY, deps, signal()), CacheAbortError);
    assert.equal(store.callsOf('set').length, 0, 'a cancelled loader must never write');
    assert.equal(store.callsOf('setIfAbsent').length, 1);
    assert.equal(store.callsOf('releaseIfOwner').length, 1, 'the acquired lock must be released even on abort');
  });

  test('a store abort (CacheAbortError from the Redis read) propagates instead of fail-opening to the origin', async () => {
    const store = new FakeCacheStore();
    const baseGet = store.get.bind(store);
    let markEnteredGet!: () => void;
    const enteredGet = new Promise<void>((resolve) => { markEnteredGet = resolve; });
    let releaseGet!: () => void;
    const getGate = new Promise<void>((resolve) => { releaseGet = resolve; });
    store.get = async (key, sig) => {
      store.calls.push({ method: 'get', args: [key] }); // the override bypasses the fake's own recording
      markEnteredGet();
      await getGate; // the test aborts while the store read is in flight
      if (sig.aborted) throw new CacheAbortError('cache get aborted');
      return baseGet(key, sig);
    };
    let loaderCalls = 0;
    const controller = new AbortController();
    const deps = makeDeps({ store, loader: async () => { loaderCalls += 1; return { id: 'origin' }; } });
    const pending = readThrough(KEY, POLICY, deps, controller.signal);
    await enteredGet;
    controller.abort();
    releaseGet();
    await assert.rejects(pending, CacheAbortError);
    assert.equal(loaderCalls, 0, 'a cancelled Redis read must never start an origin load');
    assert.equal(store.callsOf('get').length, 1, 'exactly one Redis read was attempted');
  });

  test('a leader abort never cancels the shared origin while a waiter still waits', async () => {
    const store = new FakeCacheStore();
    const singleflight = new CacheSingleflight();
    let flightSignal: AbortSignal | undefined;
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve; });
    let loaderCalls = 0;
    const deps = makeDeps({
      store,
      singleflight,
      loader: async (signal) => {
        loaderCalls += 1;
        flightSignal = signal;
        await loaderGate;
        return { id: 'origin-value' };
      },
    });
    const leaderController = new AbortController();
    const first = readThrough(KEY, POLICY, deps, leaderController.signal);
    await flush();
    const second = readThrough(KEY, POLICY, deps, signal());
    await flush();
    assert.equal(loaderCalls, 1, 'the two misses must merge into one shared origin load');

    leaderController.abort();
    await assert.rejects(first, CacheAbortError);
    assert.equal(flightSignal?.aborted, false,
      'a live waiter must keep the shared origin running after the leader aborts');

    releaseLoader();
    const result = await second;
    assert.equal(result.kind, 'origin');
    if (result.kind === 'origin') assert.deepEqual(result.value, { id: 'origin-value' });
    assert.equal(store.callsOf('set').length, 1, 'the shared origin result is still written back');
    assert.equal(singleflight.pendingCount, 0);
  });

  test('when every caller aborts, the in-flight origin is cancelled and nothing is written', async () => {
    const store = new FakeCacheStore();
    const singleflight = new CacheSingleflight();
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve; });
    let loaderCalls = 0;
    const deps = makeDeps({
      store,
      singleflight,
      loader: async (signal) => {
        loaderCalls += 1;
        await loaderGate;
        if (signal.aborted) throw new CacheAbortError('origin cancelled');
        return { id: 'never' };
      },
    });
    const leaderController = new AbortController();
    const first = readThrough(KEY, POLICY, deps, leaderController.signal);
    await flush();
    const waiterController = new AbortController();
    const second = readThrough(KEY, POLICY, deps, waiterController.signal);
    await flush();
    assert.equal(loaderCalls, 1, 'the two misses must merge into one shared origin load');

    leaderController.abort();
    waiterController.abort();
    releaseLoader();
    await assert.rejects(first, CacheAbortError);
    await assert.rejects(second, CacheAbortError);
    assert.equal(store.callsOf('set').length, 0, 'a cancelled origin must never write the cache');
    assert.equal(store.callsOf('setIfAbsent').length, 1);
    assert.equal(store.callsOf('releaseIfOwner').length, 1, 'the acquired lock must still be released');
    assert.equal(singleflight.pendingCount, 0);
  });

  test('invalid policies are rejected as programmer errors', async () => {
    const deps = makeDeps({});
    await assert.rejects(
      readThrough(KEY, { ...POLICY, softTtlMs: 30_000, hardTtlMs: 10_000 }, deps, signal()),
      CacheReadPolicyError,
    );
    await assert.rejects(readThrough(KEY, { ...POLICY, jitterMs: POLICY.hardTtlMs }, deps, signal()), CacheReadPolicyError);
    await assert.rejects(readThrough(KEY, { ...POLICY, jitterMs: -1 }, deps, signal()), CacheReadPolicyError);
    await assert.rejects(readThrough(KEY, { ...POLICY, lockTtlMs: 0 }, deps, signal()), CacheReadPolicyError);
    await assert.rejects(readThrough(KEY, { ...POLICY, domain: '' }, deps, signal()), CacheReadPolicyError);
    await assert.rejects(readThrough(KEY, { ...POLICY, maxEntryBytes: 0 }, deps, signal()), CacheReadPolicyError);
  });

  test('lock and singleflight keys are derived deterministically', () => {
    assert.equal(buildCacheLockKey(KEY), `${KEY}:lock`);
    assert.equal(buildCacheSingleflightKey('publication-metadata', KEY), `publication-metadata:${KEY}`);
  });
});


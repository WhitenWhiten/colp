/**
 * T12 real Redis adapter contract integration tests (plan 12-redis-hot-data-cache-plan.md
 * §6.4 T12, §7.1 adapter-contract layer, §7.2/§7.3 anti-false-positive/negative rules).
 *
 * What this suite proves that a Map/fake cannot (plan §7.2 rule 3): the real Redis
 * protocol behavior behind the T03 `CacheStore` adapter — SET NX PX single-owner
 * locks, token-guarded Lua unlock, atomic INCR+PEXPIRE epoch rotation, real PX TTLs,
 * bounded failure during a server outage with no offline queue, and recovery.
 *
 * Fixture / isolation design:
 * - One Testcontainers `GenericContainer` dedicated to this file (`redis:7-alpine`,
 *   override with KNOWN_REDIS_IMAGE). It is never shared with a developer's Redis and
 *   we never issue FLUSHALL/FLUSHDB against it (plan §7.1). The plan's fail-closed
 *   rule (§6.4 T12, §7.3.3) is honored: container start failure, missing Docker or a
 *   failed stop/restart throws and fails the suite — there is no silent skip.
 * - Every test builds its own key scope with a random `t12-<uuid>` prefix and real T02
 *   production key builders (`buildCacheEpochKey`/`buildCacheDataKey`/`buildCacheLockKey`,
 *   plan §7.2 rule 9: tests import the production codec, never copy the algorithm).
 *   The adapter intentionally does NOT apply `config.keyPrefix` (T03 design), so the
 *   random prefix in the key text is what isolates tests.
 * - Cleanup: each test records every key it touches; afterEach force-expires exactly
 *   those keys with a 1ms PX overwrite (the CacheStore has no DEL surface and the
 *   container is exclusive/short-lived). No FLUSHALL/FLUSHDB anywhere.
 *
 * Synchronization (no bare fixed sleeps as the only oracle, plan §7.3):
 * - Lock race: a two-party start gate (arrive+waitForGo) puts both SET NX PX attempts
 *   genuinely in flight before either resolves.
 * - TTL expiry / container readiness / disconnect detection / recovery: polling
 *   (`waitUntil`) against observable state (key presence, health(), command success).
 *
 * Server version is logged from `redis-cli INFO server` (best-effort evidence, plan §7.6).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'vitest';
import {
  GenericContainer,
  type ExecResult,
  type StartedTestContainer,
} from 'testcontainers';
import {
  buildCacheDataKey,
  buildCacheEpochKey,
  buildCacheLockKey,
  createRedisCacheStore,
  type CacheKeyDomain,
  type CacheStore,
  type RedisCacheConnectionConfig,
} from '../../../src/infrastructure/cache/index.js';
import {
  CONNECT_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  ENVIRONMENT,
  MAX_RETRIES_PER_REQUEST,
  NORMALIZED_QUERY,
  PROJECTION,
  REDIS_IMAGE,
  StartGate,
  clusterHashTag,
  crc16Ccitt,
  isCacheUnavailable,
  referenceClusterSlot,
  signal,
  waitUntil,
} from '../../support/redis-runtime-test-helpers.js';



let container: StartedTestContainer | undefined;
let redisUrlValue: string | undefined;
let store: CacheStore | undefined;
/** Keys the current test recorded; afterEach force-expires exactly these. */
let usedKeys: string[] = [];



function track(key: string): string {
  if (!usedKeys.includes(key)) usedKeys.push(key);
  return key;
}

interface TestScope {
  readonly prefix: string;
  readonly epochKey: string;
  dataKey(epoch: number): string;
  lockKey(epoch: number): string;
}

/** One random, isolated key scope per test (plan §7.3 rule 7). */
function newScope(): TestScope {
  const prefix = `t12-${randomUUID()}`;
  const collectionId = `c-${randomUUID()}`;
  const domain: CacheKeyDomain = { kind: 'publication', locator: 'pubid', collectionId };
  const dataKeyFor = (epoch: number) =>
    buildCacheDataKey({
      keyPrefix: prefix,
      environment: ENVIRONMENT,
      domain,
      projection: PROJECTION,
      epoch,
      query: NORMALIZED_QUERY,
    });
  return {
    prefix,
    epochKey: track(
      buildCacheEpochKey({ keyPrefix: prefix, environment: ENVIRONMENT, domain }),
    ),
    dataKey: (epoch) => track(dataKeyFor(epoch)),
    lockKey: (epoch) => track(buildCacheLockKey(dataKeyFor(epoch))),
  };
}

function makeStoreConfig(keyPrefix: string): RedisCacheConnectionConfig {
  assert.ok(redisUrlValue, 'redis container URL must be available before creating a store');
  return {
    url: redisUrlValue,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    keyPrefix,
  };
}

async function redisCli(args: string[]): Promise<ExecResult> {
  assert.ok(container, 'redis container must be running before redis-cli commands');
  const result = await container.exec(['redis-cli', ...args]);
  if (result.exitCode !== 0) {
    throw new Error(
      `redis-cli ${args.join(' ')} failed (exit ${result.exitCode}): ${result.output}`,
    );
  }
  return result;
}

/** Server-side PTTL in milliseconds (real Redis measurement, not a client estimate). */
async function pttlOf(key: string): Promise<number> {
  const result = await redisCli(['PTTL', key]);
  const ttl = Number.parseInt(result.output.trim(), 10);
  assert.ok(
    Number.isSafeInteger(ttl),
    `PTTL for ${key} was not an integer: ${JSON.stringify(result.output)}`,
  );
  return ttl;
}


describe('Redis runtime adapter contract against real Redis (T12)', () => {
  beforeAll(async () => {
    let started: StartedTestContainer;
    try {
      started = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        // redis runs daemonized under a keep-alive shell: the disconnect test stops
        // and restarts the redis-server *process* inside this container, which keeps
        // the published port mapping intact on every Docker runtime. Restarting the
        // whole container would drop the host port binding on Docker Desktop and
        // make the recovery assertion fail spuriously.
        .withCommand(['sh', '-c', 'redis-server --daemonize yes; while true; do sleep 3600; done'])
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `T12 fail-closed: could not start a dedicated Redis container (image ${REDIS_IMAGE}). ` +
          `The real-Redis adapter contract suite requires Docker/Testcontainers and never reuses ` +
          `a developer's REDIS_URL: ${detail}`,
      );
    }
    container = started;
    const port = started.getMappedPort(6379);
    redisUrlValue = `redis://127.0.0.1:${port}`;

    // Best-effort server version evidence (plan §7.6); never an assertion.
    try {
      const info = await started.exec(['redis-cli', 'INFO', 'server']);
      const versionLine = info.output
        .split(/\r?\n/)
        .find((line) => line.startsWith('redis_version:'));
      console.log(
        `[t12] redis container ${REDIS_IMAGE} (mapped port ${port}); server: ${versionLine ?? 'unknown'}`,
      );
    } catch {
      // Container start already proved Redis is reachable; version logging is optional.
    }

    store = createRedisCacheStore(makeStoreConfig('t12'));
    // Wait for the adapter's ready race to complete; then one real command probe.
    await waitUntil(
      async () => (await store?.health()) === 'healthy',
      15_000,
      'store health healthy after connect',
      50,
    );
    const probe = `t12-${randomUUID()}:probe`;
    assert.equal(await store.get(probe, signal()), null, 'probe get resolves a miss');
  }, 180_000);

  beforeEach(() => {
    usedKeys = [];
  });

  afterEach(async () => {
    // Best-effort per-test cleanup: force-expire only the keys this test recorded via
    // a 1ms PX overwrite (the CacheStore has no DEL surface). The container is
    // exclusive and short-lived, so this cannot affect other suites; FLUSHALL/FLUSHDB
    // is never used (plan §7.1).
    if (!store) return;
    for (const key of usedKeys) {
      try {
        await store.set(key, '', 1, signal());
      } catch (error) {
        console.warn(`[t12] best-effort cleanup force-expire failed for ${key}: ${String(error)}`);
      }
    }
  }, 30_000);

  afterAll(async () => {
    // Both close and container stop are attempted; any failure fails the suite
    // explicitly (Windows/Docker cleanup failures must never be silently swallowed,
    // plan §6.4 T12 / §7.3.3).
    const errors: unknown[] = [];
    if (store) {
      try {
        await store.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (container) {
      try {
        await container.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `T12 cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`,
      );
    }
  }, 60_000);

  test('SET NX PX lock allows exactly one owner under real concurrency (barrier)', async () => {
    const scope = newScope();
    // Two independent clients (two connections) contend for one key, mirroring two API
    // replicas. A start gate puts both SET NX PX attempts in flight before either
    // resolves, so the winner is decided by Redis's NX atomicity.
    const contenders = [
      createRedisCacheStore(makeStoreConfig(scope.prefix)),
      createRedisCacheStore(makeStoreConfig(scope.prefix)),
    ];
    try {
      for (const contender of contenders) {
        await waitUntil(
          async () => (await contender.health()) === 'healthy',
          10_000,
          'contender store healthy',
          50,
        );
      }
      const lockTtlMs = 5_000;
      for (let round = 0; round < 4; round += 1) {
        const key = scope.lockKey(round + 1);
        const gate = new StartGate(2);
        const attempts = await Promise.all(
          contenders.map(async (contender, index) => {
            const token = `token-${index}-${randomUUID()}`;
            gate.arrive();
            await gate.waitForGo();
            const acquired = await contender.setIfAbsent(key, token, lockTtlMs, signal());
            return { index, token, acquired };
          }),
        );
        const winners = attempts.filter((attempt) => attempt.acquired);
        assert.equal(winners.length, 1, `round ${round}: exactly one lock owner`);
        assert.equal(
          attempts.filter((attempt) => !attempt.acquired).length,
          1,
          `round ${round}: exactly one non-acquirer`,
        );
        const winner = winners[0];
        assert.ok(winner, `round ${round}: a winner must exist`);
        // The stored value is the winner's token (SET NX PX really stored it).
        assert.equal(
          await store!.get(key, signal()),
          winner.token,
          `round ${round}: stored owner token matches the winner`,
        );
      }
    } finally {
      await Promise.all(contenders.map((contender) => contender.close()));
    }
  }, 60_000);

  test('expired lock can be taken over; the old owner cannot release the new owner lock', async () => {
    const scope = newScope();
    const lockKey = scope.lockKey(1);
    const shortTtlMs = 120;
    const tokenA = `token-A-${randomUUID()}`;
    const tokenB = `token-B-${randomUUID()}`;

    assert.equal(
      await store!.setIfAbsent(lockKey, tokenA, shortTtlMs, signal()),
      true,
      'A acquires the lock',
    );
    assert.equal(await store!.get(lockKey, signal()), tokenA, 'A owns the lock');

    // Wait for the real PX TTL to expire by polling the key away (no fixed sleep).
    await waitUntil(
      async () => (await store!.get(lockKey, signal())) === null,
      3_000,
      'lock to expire after its short TTL',
    );

    assert.equal(
      await store!.setIfAbsent(lockKey, tokenB, 5_000, signal()),
      true,
      'B takes over after expiry',
    );
    assert.equal(await store!.get(lockKey, signal()), tokenB, 'B now owns the lock');

    // Old owner cannot delete the new lock: token-guarded Lua release must return false
    // and leave B's lock untouched (negative control: plain DEL would delete it).
    assert.equal(
      await store!.releaseIfOwner(lockKey, tokenA, signal()),
      false,
      'A cannot release B lock',
    );
    assert.equal(
      await store!.get(lockKey, signal()),
      tokenB,
      "B's lock survives A's stale release attempt",
    );
    assert.equal(
      await store!.releaseIfOwner(lockKey, tokenB, signal()),
      true,
      'B releases its own lock',
    );
    assert.equal(await store!.get(lockKey, signal()), null, 'lock is gone after B releases');
  }, 30_000);

  test('after epoch rotation the old data key is no longer read; the new epoch requires a fresh write', async () => {
    const scope = newScope();
    const epochTtlMs = 5_000;

    const epoch1 = await store!.rotateEpoch(scope.epochKey, epochTtlMs, signal());
    assert.equal(epoch1, 1, 'first rotation produces epoch 1');
    await store!.set(scope.dataKey(epoch1), 'v1', 150, signal());
    assert.equal(
      await store!.get(scope.dataKey(epoch1), signal()),
      'v1',
      'epoch-1 data key is readable while epoch 1 is current',
    );

    const epoch2 = await store!.rotateEpoch(scope.epochKey, epochTtlMs, signal());
    assert.ok(epoch2 > epoch1, 'rotation is monotonic');

    // A read-through derives the data key from the current epoch (plan §4.1), so after
    // rotation it looks up dataKey(epoch2): it must miss and reload from origin. The
    // stale epoch-1 value must never be served through the new epoch.
    assert.equal(
      await store!.get(scope.dataKey(epoch2), signal()),
      null,
      'current-epoch read-through misses (stale value not readable)',
    );
    await store!.set(scope.dataKey(epoch2), 'v2', 5_000, signal());
    assert.equal(
      await store!.get(scope.dataKey(epoch2), signal()),
      'v2',
      'new-epoch data key becomes readable after a fresh write',
    );

    // The old-epoch data key is orphaned: with its short TTL it self-expires and
    // rotation never resurrects it (polling, not a fixed sleep).
    await waitUntil(
      async () => (await store!.get(scope.dataKey(epoch1), signal())) === null,
      3_000,
      'old-epoch data key to expire',
    );
    assert.equal(
      await store!.get(scope.dataKey(epoch2), signal()),
      'v2',
      'new-epoch data key is unaffected',
    );
  }, 30_000);

  test('epoch rotation is a real atomic INCR+PEXPIRE: strictly monotonic with a live, refreshed TTL', async () => {
    const scope = newScope();
    const epochTtlMs = 5_000;

    let previous = 0;
    for (let rotation = 1; rotation <= 5; rotation += 1) {
      const epoch = await store!.rotateEpoch(scope.epochKey, epochTtlMs, signal());
      assert.ok(
        Number.isSafeInteger(epoch) && epoch >= 1,
        `epoch ${epoch} is a positive integer`,
      );
      assert.ok(
        epoch > previous,
        `rotation ${rotation} is strictly monotonic (${epoch} > ${previous})`,
      );
      previous = epoch;

      // Loose TTL bounds only (plan §7.3 rule 1): the key must exist and stay within a
      // generous window around epochTtlMs — never an exact millisecond assertion.
      const ttl = await pttlOf(scope.epochKey);
      assert.ok(ttl > 0, `epoch key TTL exists after rotation ${rotation}`);
      assert.ok(
        ttl <= epochTtlMs + 200,
        `rotation ${rotation} TTL ${ttl}ms must not exceed ${epochTtlMs + 200}ms`,
      );
      assert.ok(
        ttl >= epochTtlMs - 1_000,
        `rotation ${rotation} TTL ${ttl}ms must be near ${epochTtlMs}ms (loose lower bound)`,
      );
    }

    // TTL refresh proof: let some TTL elapse, rotate again, and the PEXPIRE inside the
    // same atomic script must push the TTL back up (INCR alone would leave it counting down).
    await waitUntil(
      async () => (await pttlOf(scope.epochKey)) <= epochTtlMs - 500,
      3_000,
      'epoch TTL to elapse below epochTtlMs - 500',
    );
    const beforeRefresh = await pttlOf(scope.epochKey);
    await store!.rotateEpoch(scope.epochKey, epochTtlMs, signal());
    const afterRefresh = await pttlOf(scope.epochKey);
    assert.ok(
      afterRefresh > beforeRefresh + 100,
      `rotation refreshed the TTL (before=${beforeRefresh}ms, after=${afterRefresh}ms)`,
    );
    assert.ok(
      afterRefresh <= epochTtlMs + 200,
      `refreshed TTL ${afterRefresh}ms stays within the upper bound`,
    );
  }, 60_000);

  test('set applies a real PX TTL that exists, is bounded by hardTtlMs, and expires the value', async () => {
    const scope = newScope();
    const dataKey = scope.dataKey(1);
    const hardTtlMs = 2_000;

    await store!.set(dataKey, 'envelope', hardTtlMs, signal());
    assert.equal(await store!.get(dataKey, signal()), 'envelope', 'value is readable');

    const ttl = await pttlOf(dataKey);
    assert.ok(ttl > 0, 'TTL exists on the written key');
    assert.ok(
      ttl <= hardTtlMs + 200,
      `TTL ${ttl}ms must not exceed hard TTL ${hardTtlMs + 200}ms`,
    );
    assert.ok(
      ttl >= hardTtlMs - 1_000,
      `TTL ${ttl}ms must be near hard TTL ${hardTtlMs}ms (loose lower bound)`,
    );

    // A short-TTL value really expires end to end (poll until the key is gone).
    const shortKey = scope.dataKey(2);
    await store!.set(shortKey, 'short', 120, signal());
    assert.equal(await store!.get(shortKey, signal()), 'short');
    await waitUntil(
      async () => (await store!.get(shortKey, signal())) === null,
      3_000,
      'short-TTL value to expire',
    );
  }, 30_000);

  test('server stop/restart: commands fail fast with bounded cache_unavailable and recover afterwards', async () => {
    assert.ok(container, 'container fixture must be running');
    assert.ok(store, 'store fixture must be created');
    const s = store!;

    // Baseline: healthy store with a real write.
    assert.equal(await s.health(), 'healthy', 'store healthy before the outage');
    const scope = newScope();
    const key = scope.dataKey(1);
    await s.set(key, 'before', 60_000, signal());
    assert.equal(await s.get(key, signal()), 'before');

    // Simulate a real "Redis process completely stopped" outage on the dedicated
    // container only (never a shared/dev Redis, plan §7.3.8): shutdown the redis-server
    // process inside the container. The keep-alive shell keeps the container and its
    // published port mapping alive, so restoring the process is enough to recover.
    const shutdown = await container.exec(['redis-cli', 'shutdown', 'nosave']);
    if (shutdown.exitCode !== 0) {
      throw new Error(`redis-cli shutdown failed (exit ${shutdown.exitCode}): ${shutdown.output}`);
    }
    try {
      // Synchronize on the real disconnect: poll until a command starts rejecting.
      await waitUntil(
        async () => {
          try {
            await s.get(scope.dataKey(99), signal());
            return false;
          } catch {
            return true;
          }
        },
        10_000,
        'commands to fail after the redis shutdown',
        50,
      );
      assert.equal(await s.health(), 'degraded', 'health degrades during the outage');

      // Bounded failure: every command rejects fast (enableOfflineQueue=false and a
      // bounded command timeout mean no offline queue and no unbounded backlog).
      const totalStart = performance.now();
      const failingCommands: Array<[string, () => Promise<unknown>]> = [
        ['get', () => s.get(key, signal())],
        ['setIfAbsent', () => s.setIfAbsent(scope.lockKey(1), 'token', 1_000, signal())],
        ['get', () => s.get(scope.dataKey(100), signal())],
        ['set', () => s.set(scope.dataKey(101), 'x', 1_000, signal())],
      ];
      for (const [name, command] of failingCommands) {
        const started = performance.now();
        await assert.rejects(
          command(),
          isCacheUnavailable,
          `${name} must reject with cache_unavailable during the outage`,
        );
        const elapsed = performance.now() - started;
        assert.ok(
          elapsed < 3_000,
          `${name} failed in ${elapsed.toFixed(0)}ms (bounded, expected < 3000ms)`,
        );
      }
      const totalElapsed = performance.now() - totalStart;
      assert.ok(
        totalElapsed < 10_000,
        `4 failing commands completed in ${totalElapsed.toFixed(0)}ms (no unbounded backlog)`,
      );
    } finally {
      // Restore the redis-server process inside the same container.
      const restore = await container.exec(['redis-server', '--daemonize', 'yes']);
      if (restore.exitCode !== 0) {
        throw new Error(`redis-server restart failed (exit ${restore.exitCode}): ${restore.output}`);
      }
    }

    // Recovery: the health probe becomes healthy again and new commands work.
    await waitUntil(
      async () => (await s.health()) === 'healthy',
      30_000,
      'store healthy after the redis restart',
      100,
    );
    const recoveryKey = scope.dataKey(2);
    await s.set(recoveryKey, 'after', 2_000, signal());
    assert.equal(await s.get(recoveryKey, signal()), 'after', 'recovered store writes');
    const recoveredTtl = await pttlOf(recoveryKey);
    assert.ok(recoveredTtl > 0, 'recovered store writes with a real TTL');
  }, 90_000);

  test('{pub:<collectionId>} hash tag keeps epoch/data/lock keys in one cluster slot (reference CRC16)', async () => {
    // Standalone Redis rejects CLUSTER KEYSLOT ("cluster support disabled" on
    // 6.2/7.0/7.4), so the same-slot design is proven with a reference CRC16 over
    // each key's hash tag — the exact anchor Redis hashes. Core lock/epoch tests
    // always run regardless of cluster support (plan §6.4 T12).
    const scope = newScope();
    const data = scope.dataKey(7);
    const lock = scope.lockKey(7);
    const keys = [scope.epochKey, data, lock];
    const tags = keys.map((redisKey) => clusterHashTag(redisKey));
    assert.ok(
      tags.every((tag) => tag.startsWith('pub:') && tag.length > 4),
      `keys carry a non-empty {pub:...} hash tag: ${JSON.stringify(tags)}`,
    );
    assert.equal(tags[0], tags[1], 'epoch and data key share the same hash tag');
    assert.equal(tags[1], tags[2], 'data and lock key share the same hash tag');
    const slots = keys.map((redisKey) => referenceClusterSlot(redisKey));
    assert.equal(slots[0], slots[1], `epoch and data key share slot ${slots[0]}`);
    assert.equal(slots[1], slots[2], `data and lock key share slot ${slots[1]}`);
    assert.equal(
      referenceClusterSlot(scope.epochKey),
      slots[0],
      'the same key deterministically maps to the same slot',
    );
  }, 15_000);
});


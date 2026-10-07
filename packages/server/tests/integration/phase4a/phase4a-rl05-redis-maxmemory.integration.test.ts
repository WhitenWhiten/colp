/**
 * P4A-RL05 real-Redis adapter contract — maxmemory / noeviction diagnostics
 * (plan §8 RL05, runbook `redis-hot-data-cache-operations.md` §5 capacity).
 *
 * The dedicated container runs `--maxmemory 16mb --maxmemory-policy
 * noeviction`. The contract under real memory pressure:
 *
 *  - the memory wall is REAL: plain writes whose in-flight cost (client input
 *    buffer + parsed argv) would exceed maxmemory are refused with OOM while
 *    `evicted_keys` stays 0 — noeviction never silently destroys counters
 *    (a policy that evicted counters would break every quota; the diagnostic
 *    records it);
 *  - the wall is CROSSED with a Lua generator script (writes inside a script
 *    are not maxmemory-gated), making `used_memory > maxmemory` observable
 *    as an environment diagnostic;
 *  - at the wall, every rate-limit check surfaces as an infrastructure
 *    FAILURE (`internal` / `rate_limit_redis_error`), NEVER as a denied 429
 *    decision and never as an allowed admission (plan §4.1.10: an
 *    exhausted-memory Redis must not masquerade as quota exhaustion);
 *  - the existing counter key keeps its value AND its TTL (never evicted,
 *    never corrupted by a failed INCR), and freeing the fill keys (DEL works
 *    over the wall) restores admission — the failure was the memory wall,
 *    not a stuck state.
 *
 * Fixture (plan §4.2.6): one dedicated Testcontainers container
 * (`redis:7-alpine`, override KNOW_REDIS_IMAGE); a failed start throws an
 * environment failure — never a skip. Cleanup force-expires exactly this
 * run's known keys (no FLUSHALL/FLUSHDB). No PostgreSQL dependency.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createRedisRateLimitStore } from '../../../src/infrastructure/rate-limit/index.js';
import {
  buildAttachmentRateLimitKey,
  type AttachmentRateLimitConfig,
  type AttachmentRateLimitRouteClass,
  type RateLimitStore,
  type RateLimitStoreOutcome,
  type RateLimitSubject,
} from '../../../src/modules/attachments/index.js';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';

const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';
const ENVIRONMENT = 'test';
const MAXMEMORY_BYTES = 16 * 1024 * 1024;

let container: StartedTestContainer | undefined;
let redisUrl: string | undefined;
let raw: Redis | undefined;
let runPrefix: string;
let keySecret: Buffer;
const stores: RateLimitStore[] = [];
const trackedKeys = new Set<string>();

function makeConfig(overrides: Partial<AttachmentRateLimitConfig> = {}): AttachmentRateLimitConfig {
  assert.ok(redisUrl, 'the redis URL must be known before creating a store');
  const base: AttachmentRateLimitConfig = {
    mode: 'enforce',
    required: true,
    redisUrl,
    keySecretRef: 'known/rl05/maxmemory/hmac',
    keyPrefix: runPrefix,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3_000,
    maxRetriesPerRequest: 1,
    routes: Object.freeze({
      issue: Object.freeze({ rateMax: 100, rateWindowMs: 60000 }),
      complete: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
      download: Object.freeze({ rateMax: 30, rateWindowMs: 60000 }),
      status: Object.freeze({ rateMax: 60, rateWindowMs: 60000 }),
    }),
    completeEmergency: Object.freeze({ rateMax: 15, rateWindowMs: 60000 }),
  };
  return Object.freeze({ ...base, ...overrides }) as AttachmentRateLimitConfig;
}

async function makeHealthyStore(): Promise<RateLimitStore> {
  const store = createRedisRateLimitStore({
    config: makeConfig(),
    environment: ENVIRONMENT,
    keySecret,
  });
  stores.push(store);
  await waitUntil(() => store.readiness().status === 'healthy', 15_000, 'store connection ready', 25);
  return store;
}

function subject(seed: string = randomUUID()): RateLimitSubject {
  return { principalId: `principal-${seed}`, scope: `collection-${seed}` };
}

function counterKey(
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
  windowStartEpochMs: number,
): string {
  return buildAttachmentRateLimitKey({
    keyPrefix: runPrefix,
    environment: ENVIRONMENT,
    keySecret,
    routeClass,
    subject: subjectValue,
    windowStartEpochMs,
  });
}

function track(
  outcome: RateLimitStoreOutcome,
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
): RateLimitStoreOutcome {
  if (outcome.kind === 'allowed' || outcome.kind === 'denied') {
    trackedKeys.add(counterKey(routeClass, subjectValue, outcome.decision.windowStartEpochMs));
  }
  return outcome;
}

async function check(
  store: RateLimitStore,
  routeClass: AttachmentRateLimitRouteClass,
  subjectValue: RateLimitSubject,
): Promise<RateLimitStoreOutcome> {
  return track(await store.check({ routeClass, subject: subjectValue }), routeClass, subjectValue);
}

function infoNumber(section: string, field: string): number {
  const match = new RegExp(`^${field}:(\\d+)$`, 'mu').exec(section);
  assert.ok(match, `INFO must report ${field}`);
  return Number(match[1]!);
}

describe('P4A-RL05 real Redis: maxmemory/noeviction diagnostics', () => {
  beforeAll(async () => {
    let started: StartedTestContainer;
    try {
      started = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        // Tiny maxmemory + noeviction: the dedicated container lives at the
        // memory wall so eviction behavior is observable, never guessed.
        .withCommand(['sh', '-c', 'redis-server --port 6379 --maxmemory 16mb --maxmemory-policy noeviction --daemonize yes; while true; do sleep 3600; done'])
        .withStartupTimeout(120_000)
        .start();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `P4A-RL05 fail-closed: could not start a dedicated Redis container (image ${REDIS_IMAGE}). ` +
          `The real-Redis rate-limit contract suite requires Docker/Testcontainers and never reuses ` +
          `a developer's Redis: ${detail}`,
      );
    }
    container = started;
    redisUrl = `redis://127.0.0.1:${started.getMappedPort(6379)}`;
    runPrefix = `rl05-${randomUUID()}`;
    keySecret = Buffer.from(`rl05-run-secret-${randomUUID()}`, 'utf8');
    raw = new Redis(redisUrl);
    await waitUntil(async () => {
      try { await raw?.ping(); return true; } catch { return false; }
    }, 15_000, 'raw redis ping', 50);
  }, 180_000);

  afterEach(async () => {
    if (raw) {
      for (const key of trackedKeys) {
        try { await raw.del(key); } catch (error) {
          console.warn(`[rl05-maxmemory] best-effort exact-key cleanup failed for ${key}: ${String(error)}`);
        }
      }
    }
    trackedKeys.clear();
    const open = stores.splice(0, stores.length);
    await Promise.all(open.map((store) => store.close().catch(() => undefined)));
  }, 30_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    if (raw) { try { await raw.quit(); } catch (error) { errors.push(error); } }
    if (container) { try { await container.stop(); } catch (error) { errors.push(error); } }
    if (errors.length > 0) {
      throw new Error(`P4A-RL05 maxmemory cleanup failed: ${errors.map((error) => String(error)).join(' | ')}`);
    }
  }, 60_000);

  test('noeviction never silently destroys counters; OOM at the memory wall fails as internal, never as quota denials', async () => {
    const store = await makeHealthyStore();
    const owner = subject('mem');
    const first = await check(store, 'issue', owner);
    assert.equal(first.kind, 'allowed');
    if (first.kind !== 'allowed') return;
    const key = counterKey('issue', owner, first.decision.windowStartEpochMs);
    assert.equal(await raw!.get(key), '1', 'the counter key holds the first hit');
    assert.ok((await raw!.pttl(key)) > 0, 'the counter carries its TTL');

    // 1. Push the server to the memory wall with plain writes: Redis counts
    //    the in-flight input buffer + parsed argv against maxmemory, so a
    //    6MB value succeeds while used_memory is ~1MB, and the next one is
    //    refused with OOM (the wall is real and reachable).
    const big = randomBytes(4_500_000).toString('base64'); // ~6MB value
    let bigWrites = 0;
    let hitOom = false;
    for (let i = 0; i < 6; i += 1) {
      const bigKey = `rl05-big-${i}`;
      trackedKeys.add(bigKey); // exact-key cleanup for this run's big values too
      try {
        await raw!.set(bigKey, big);
        bigWrites += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(message.includes('OOM'), `the memory wall must be Redis OOM, got: ${message}`);
        hitOom = true;
        break;
      }
    }
    assert.equal(hitOom, true, 'plain writes hit the OOM wall (environment diagnostic)');
    assert.ok(bigWrites >= 1, `at least one big write landed (${bigWrites})`);

    // 2. Cross the wall with a Lua generator script: writes INSIDE a script
    //    are not maxmemory-gated (verified against redis:7-alpine), so
    //    used_memory can finally exceed maxmemory and stay observable.
    const FILL_KEYS = 120;
    for (let i = 0; i < FILL_KEYS; i += 1) trackedKeys.add(`rl05-fill-${i}`);
    const generated = await raw!.eval(
      'local v = string.rep("x", 100000); for i = 1, 120 do redis.call("set", "rl05-fill-" .. i, v) end; return 1',
      0,
    );
    assert.equal(generated, 1, 'the generator script ran and crossed the wall');

    // Environment diagnostic: the server sits above maxmemory; noeviction
    // evicted NOTHING — counters cannot be silently destroyed.
    const memoryInfo = await raw!.info('memory');
    const maxmemory = infoNumber(memoryInfo, 'maxmemory');
    const usedMemory = infoNumber(memoryInfo, 'used_memory');
    assert.equal(maxmemory, MAXMEMORY_BYTES, 'the container runs with the expected maxmemory');
    assert.ok(usedMemory > maxmemory, `used_memory (${usedMemory}) exceeds maxmemory (${maxmemory})`);
    const statsInfo = await raw!.info('stats');
    const evictedKeys = infoNumber(statsInfo, 'evicted_keys');
    assert.equal(evictedKeys, 0, 'noeviction evicted no keys — counters are never silently evicted');

    // The existing counter survived memory pressure with its value and TTL.
    assert.equal(await raw!.get(key), '1', 'the existing counter survives memory pressure');
    assert.ok((await raw!.pttl(key)) > 0, 'the counter TTL survives memory pressure');

    // 3. At the wall, every rate-limit check is an infrastructure FAILURE
    //    (internal / rate_limit_redis_error), NEVER denied (429) and never
    //    allowed (plan §4.1.10 — memory exhaustion must not masquerade as
    //    quota exhaustion). The failed INCR never corrupted the counter.
    const fresh = await check(store, 'issue', subject('mem-fresh'));
    assert.equal(fresh.kind, 'failed', 'an OOM-gated check is an infrastructure failure, never a decision');
    if (fresh.kind === 'failed') {
      assert.equal(fresh.failure.class, 'internal', `OOM reply classifies internal, got ${fresh.failure.class}`);
      assert.equal(fresh.failure.code, 'rate_limit_redis_error');
    }
    const existing = await check(store, 'issue', owner);
    assert.equal(existing.kind, 'failed', 'the existing counter check is also OOM-gated');
    assert.equal(await raw!.get(key), '1', 'the failed INCR never corrupted the counter');

    // 4. DEL works over the wall (it frees memory): freeing the fill keys
    //    brings the server back under maxmemory and admission recovers —
    //    the failure was the memory wall, not a stuck circuit or client.
    const fillKeys = Array.from({ length: FILL_KEYS }, (_v, i) => `rl05-fill-${i}`);
    await raw!.del(...fillKeys, ...Array.from({ length: bigWrites }, (_v, i) => `rl05-big-${i}`));
    await waitUntil(async () => (await check(store, 'issue', owner)).kind === 'allowed', 10_000,
      'admission recovers after the fill keys are freed', 50);
  }, 60_000);
});

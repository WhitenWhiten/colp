/**
 * SYNC-Q-016: two Redis instances, two eviction policies, two failure domains.
 * Filling cache must not drop limiter counters; filling limiter must fail closed
 * without breaking cache writes.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { waitUntil } from '../../support/redis-runtime-test-helpers.js';

const REDIS_IMAGE = process.env.KNOWN_REDIS_IMAGE?.trim() || 'redis:7-alpine';

let cacheContainer: StartedTestContainer | undefined;
let limiterContainer: StartedTestContainer | undefined;
let cache: Redis | undefined;
let limiter: Redis | undefined;

async function startRedis(policy: string, extra: string): Promise<{
  container: StartedTestContainer;
  client: Redis;
}> {
  let started: StartedTestContainer;
  try {
    started = await new GenericContainer(REDIS_IMAGE)
      .withExposedPorts(6379)
      .withCommand([
        'sh',
        '-c',
        `redis-server --port 6379 --maxmemory 2mb --maxmemory-policy ${policy} ${extra} --daemonize yes; while true; do sleep 3600; done`,
      ])
      .withStartupTimeout(120_000)
      .start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `SYNC-Q-016 fail-closed: could not start Redis (${policy}, image ${REDIS_IMAGE}): ${detail}`,
    );
  }
  const url = `redis://127.0.0.1:${started.getMappedPort(6379)}`;
  const client = new Redis(url);
  await waitUntil(async () => (await client.ping()) === 'PONG', 15_000, `${policy} ping`, 50);
  return { container: started, client };
}

function infoNumber(section: string, field: string): number {
  const match = new RegExp(`^${field}:(\\d+)$`, 'mu').exec(section);
  assert.ok(match, `INFO must report ${field}`);
  return Number(match[1]);
}

describe('SYNC-Q-016 cache and limiter Redis isolation', () => {
  beforeAll(async () => {
    const cacheStarted = await startRedis('allkeys-lru', '--appendonly no --save ""');
    cacheContainer = cacheStarted.container;
    cache = cacheStarted.client;
    const limiterStarted = await startRedis('noeviction', '--appendonly yes');
    limiterContainer = limiterStarted.container;
    limiter = limiterStarted.client;
  });

  afterAll(async () => {
    await cache?.quit();
    await limiter?.quit();
    await cacheContainer?.stop();
    await limiterContainer?.stop();
  });

  test('filling the cache evicts cache keys and leaves limiter quota intact', async () => {
    assert.ok(cache);
    assert.ok(limiter);
    const limiterKey = `q016-limiter-${randomUUID()}`;
    assert.equal(await limiter.set(limiterKey, '7'), 'OK');
    const payload = randomBytes(24_000).toString('base64');
    for (let i = 0; i < 200; i += 1) {
      await cache.set(`q016-cache-${i}`, payload);
    }
    const cacheInfo = await cache.info('stats');
    const limiterInfo = await limiter.info('stats');
    assert.ok(infoNumber(cacheInfo, 'evicted_keys') > 0, 'cache must evict under LRU');
    assert.equal(infoNumber(limiterInfo, 'evicted_keys'), 0);
    assert.equal(await limiter.get(limiterKey), '7');
  });

  test('filling the limiter fails closed while cache still serves writes', async () => {
    assert.ok(cache);
    assert.ok(limiter);
    const payload = randomBytes(24_000).toString('base64');
    let limiterRejected = false;
    for (let i = 0; i < 200; i += 1) {
      try {
        await limiter.set(`q016-fill-${i}`, payload);
      } catch {
        limiterRejected = true;
        break;
      }
    }
    assert.equal(limiterRejected, true, 'noeviction limiter must refuse writes at maxmemory');
    const limiterInfo = await limiter.info('stats');
    assert.equal(infoNumber(limiterInfo, 'evicted_keys'), 0);
    const cacheKey = `q016-still-${randomUUID()}`;
    assert.equal(await cache.set(cacheKey, 'ok'), 'OK');
    assert.equal(await cache.get(cacheKey), 'ok');
  });
});

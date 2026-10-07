/**
 * SYNC-Q-014: two SyncAdmissionPolicy instances share one Redis quota;
 * restart joins the same counter; outage fails closed; keys hide raw identity.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import {
  createRedisSyncAdmissionPolicy,
  type SyncAdmissionPolicy,
} from '../../../src/infrastructure/rate-limit/index.js';
import { REDIS_IMAGE, waitUntil } from '../../support/redis-runtime-test-helpers.js';
import { Redis } from 'ioredis';

const KEY_SECRET = Buffer.from('sync-admission-isolation-hmac-014', 'utf8');
const BUDGETS = Object.freeze({
  conflict: Object.freeze({ maxRequests: 2, windowMs: 60_000 }),
});

let sharedContainer: StartedTestContainer | undefined;
let outageContainer: StartedTestContainer | undefined;
let inspect: Redis | undefined;

function redisUrl(started: StartedTestContainer): string {
  return `redis://127.0.0.1:${started.getMappedPort(6379)}`;
}

function policy(url: string): SyncAdmissionPolicy {
  return createRedisSyncAdmissionPolicy({
    redisUrl: url,
    environment: 'test',
    keySecret: KEY_SECRET,
    keyPrefix: 'known-sync',
    budgets: BUDGETS,
    commandTimeoutMs: 750,
    connectTimeoutMs: 3_000,
    maxRetriesPerRequest: 1,
  });
}

async function waitReady(target: SyncAdmissionPolicy, label: string): Promise<void> {
  await waitUntil(async () => {
    const outcome = await target.admitPreAuth({ purpose: 'conflict', clientKey: `warmup-${label}` });
    return outcome.kind !== 'failed';
  }, 15_000, `${label} admission ready`, 50);
}

describe('SYNC-Q-014 SyncAdmissionPolicy Redis isolation', () => {
  beforeAll(async () => {
    const start = async (label: string): Promise<StartedTestContainer> => {
      try {
        return await new GenericContainer(REDIS_IMAGE)
          .withExposedPorts(6379)
          .withCommand([
            'sh', '-c',
            'redis-server --port 6379 --maxmemory-policy noeviction --appendonly yes --daemonize yes; while true; do sleep 3600; done',
          ])
          .withStartupTimeout(120_000)
          .start();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`SYNC-Q-014 fail-closed: could not start Redis (${label}, ${REDIS_IMAGE}): ${detail}`);
      }
    };
    sharedContainer = await start('shared');
    outageContainer = await start('outage');
    inspect = new Redis(redisUrl(sharedContainer));
    await waitUntil(async () => (await inspect!.ping()) === 'PONG', 15_000, 'q014 ping', 50);
  });

  afterAll(async () => {
    await inspect?.quit();
    await sharedContainer?.stop();
    await outageContainer?.stop();
  });

  test('two API policies share one quota; restart continues; raw IP never lands in Redis', async () => {
    assert.ok(sharedContainer);
    const url = redisUrl(sharedContainer);
    const a = policy(url);
    const b = policy(url);
    await waitReady(a, 'a');
    await waitReady(b, 'b');
    const rawIp = '2001:db8:14::10';
    assert.equal((await a.admitPreAuth({ purpose: 'conflict', clientKey: rawIp })).kind, 'allowed');
    assert.equal((await b.admitPreAuth({ purpose: 'conflict', clientKey: rawIp })).kind, 'allowed');
    assert.equal((await a.admitPreAuth({ purpose: 'conflict', clientKey: rawIp })).kind, 'denied');
    await a.close();
    const restarted = policy(url);
    await waitReady(restarted, 'restart');
    assert.equal((await restarted.admitPreAuth({ purpose: 'conflict', clientKey: rawIp })).kind, 'denied');
    const keys = await inspect!.keys('*');
    assert.ok(keys.length > 0, 'quota key must persist');
    assert.equal(keys.some((key) => key.includes(rawIp) || key.includes('2001:db8')), false);
    await b.close();
    await restarted.close();
  });

  test('Redis outage fails closed', async () => {
    assert.ok(outageContainer);
    const isolated = policy(redisUrl(outageContainer));
    await outageContainer.stop();
    outageContainer = undefined;
    const outcome = await isolated.admitPreAuth({ purpose: 'conflict', clientKey: 'outage-client' });
    assert.equal(outcome.kind, 'failed');
    await isolated.close();
  });
});

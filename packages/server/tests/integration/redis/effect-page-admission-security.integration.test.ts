import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, test } from 'vitest';
import { createRedisEffectPageRateLimitStore, type EffectPageRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { registerSyncEffectPageRoutes, type SyncEffectPageRouteDependencies } from '../../../src/transport/colp-sync/sync-effect-page-routes.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { REDIS_IMAGE, waitUntil } from '../../support/redis-runtime-test-helpers.js';

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let container: StartedTestContainer;
const apps: FastifyInstance[] = [];
const limiters: EffectPageRateLimiter[] = [];
let reads = 0;

beforeAll(async () => {
  container = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
}, 120_000);
afterAll(async () => {
  try { await Promise.all(apps.map(app => app.close())); }
  finally {
    try { await Promise.all(limiters.map(limiter => limiter.close())); }
    finally { await container?.stop(); }
  }
});

async function instance() {
  const limiter = createRedisEffectPageRateLimitStore({
    redisUrl: `redis://127.0.0.1:${container.getMappedPort(6379)}`,
    environment: 'test', keySecret: Buffer.from('effect-page-security-integration-secret'),
    subjectMaxRequests: 3, effectMaxRequests: 1, windowMs: 60_000,
    commandTimeoutMs: 500, connectTimeoutMs: 2_000, maxRetriesPerRequest: 1,
  });
  limiters.push(limiter);
  await waitUntil(async () => (await limiter.consume({ clientIp: 'warmup', sessionId: 'warmup',
    replicaId: 'warmup', effectId: 'warmup' })).kind !== 'failed', 10_000, 'effect limiter connected');
  const credential = await mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.test',
    audience: 'known-api', clientId: 'known-extension', subject: 'effect-subject', credentialId: 'effect-credential' });
  const app = Fastify();
  apps.push(app);
  registerSyncEffectPageRoutes(app, {
    pathTemplate: '/effects/{effectId}/{pageNumber}', credentialVerifier: { verify: async () => credential },
    allowedOrigins: [origin], allowInsecureLoopback: true, responseBudgetBytes: 1024,
    rateLimit: { subjectMaxRequests: 3, effectMaxRequests: 1, ipMaxRequests: 100, windowMs: 60_000 },
    rateLimiter: limiter,
    reader: { read: async () => { reads += 1;
      return { members: [] } as Awaited<ReturnType<SyncEffectPageRouteDependencies['reader']['read']>>; } },
  });
  await app.ready();
  return app;
}

function get(app: FastifyInstance, effect: string, page = 1) {
  return app.inject({ method: 'GET', url: `/effects/${effect}/${page}`, headers: {
    authorization: 'Bearer effect-token', origin, 'known-sync-session': 'session-security',
  } });
}

test('two Fastify instances and a restart consume shared subject/effect quotas before reads', async () => {
  const first = await instance(), second = await instance();
  assert.equal((await get(first, 'effect-a')).statusCode, 200);
  const perEffect = await get(second, 'effect-a', 2);
  assert.equal(perEffect.statusCode, 429);
  assert.ok(Number(perEffect.headers['retry-after']) > 0);
  assert.equal(reads, 1);
  assert.equal((await get(second, 'effect-b')).statusCode, 200);
  await first.close();
  await limiters[0]!.close();
  const restarted = await instance();
  assert.equal((await get(restarted, 'effect-c')).statusCode, 429);
  assert.equal(reads, 2);

  await container.stop();
  const unavailable = await get(second, 'effect-d');
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.headers['ratelimit-policy'], undefined);
  assert.equal(reads, 2);
});

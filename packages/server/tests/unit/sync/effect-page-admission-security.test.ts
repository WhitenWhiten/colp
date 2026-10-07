import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, test } from 'vitest';
import { registerSyncEffectPageRoutes, type SyncEffectPageRouteDependencies } from '../../../src/transport/colp-sync/sync-effect-page-routes.js';
import type { EffectPageRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';

const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup(subjectMaxRequests = 2, effectMaxRequests = 1, rateLimiter?: EffectPageRateLimiter) {
  const app = Fastify({ logger: false });
  apps.push(app);
  let reads = 0;
  const credential = await mintVerifiedExtensionCredentialFixture({ issuer: 'https://issuer.example',
    audience: 'known-api', clientId: 'known-extension', subject: 'page-subject', credentialId: 'page-credential' });
  registerSyncEffectPageRoutes(app, {
    pathTemplate: '/private/effects/{effectId}/{pageNumber}',
    credentialVerifier: { verify: async () => credential },
    allowedOrigins: [origin], allowInsecureLoopback: true, responseBudgetBytes: 16384,
    rateLimit: { subjectMaxRequests, effectMaxRequests, ipMaxRequests: 100, windowMs: 60000 },
    ...(rateLimiter === undefined ? {} : { rateLimiter }),
    reader: { read: async () => {
      reads += 1;
      return { members: [] } as Awaited<ReturnType<SyncEffectPageRouteDependencies['reader']['read']>>;
    } },
  });
  await app.ready();
  return {
    app, reads: () => reads,
    get: (effect: string, page = 1, query = '') => app.inject({ method: 'GET',
      url: `/private/effects/${effect}/${page}${query}`,
      headers: { authorization: 'Bearer page-token', origin, 'known-sync-session': 'session-1' } }),
  };
}

test('rotating page index cannot replenish a per-effect quota', async () => {
  const fixture = await setup(10, 1);
  assert.equal((await fixture.get('effect-1', 1)).statusCode, 200);
  const denied = await fixture.get('effect-1', 2);
  assert.equal(denied.statusCode, 429);
  assert.ok(Number(denied.headers['retry-after']) >= 1);
  assert.equal(fixture.reads(), 1);
  assert.equal((await fixture.get('effect-2')).statusCode, 200);
});

test('rotating effect identity cannot replenish the subject total', async () => {
  const fixture = await setup(2, 2);
  assert.equal((await fixture.get('effect-1')).statusCode, 200);
  assert.equal((await fixture.get('effect-2')).statusCode, 200);
  assert.equal((await fixture.get('effect-3')).statusCode, 429);
  assert.equal(fixture.reads(), 2);
});

test('legacy replica query variations cannot mint another quota', async () => {
  const fixture = await setup(10, 1);
  assert.equal((await fixture.get('effect-1', 1,
    '?sessionId=session-1&replicaId=replica-a&collectionId=collection-a')).statusCode, 200);
  assert.equal((await fixture.get('effect-1', 2,
    '?sessionId=session-1&replicaId=replica-b&collectionId=collection-b')).statusCode, 429);
  assert.equal(fixture.reads(), 1);
});

for (const throws of [false, true]) {
  test(`dedicated limiter ${throws ? 'throw' : 'failure'} is a 503 without quota claims`, async () => {
    let closed = false;
    const limiter: EffectPageRateLimiter = {
      consume: async () => {
        if (throws) throw new Error('store offline');
        return { kind: 'failed', failure: { class: 'unavailable', code: 'test' } };
      },
      readiness: () => ({ status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: 0 }),
      close: async () => { closed = true; },
    };
    const fixture = await setup(2, 1, limiter);
    const response = await fixture.get('effect-1');
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['ratelimit-policy'], undefined);
    assert.equal(response.headers['retry-after'], undefined);
    assert.equal(fixture.reads(), 0);
    await fixture.app.close();
    assert.equal(closed, false, 'a route must not close a borrowed limiter');
  });
}

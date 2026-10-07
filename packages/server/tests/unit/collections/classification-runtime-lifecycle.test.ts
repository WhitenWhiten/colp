import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { AppDependencies } from '../../../src/transport/app-dependencies.js';
import { registerClassificationProductSurfaces } from '../../../src/transport/register-classification-surfaces.js';
import { CLASSIFICATION_SETTINGS_V2_MEDIA } from '../../../src/modules/collections/index.js';
import { sendProductError, ProductHttpError } from '../../../src/transport/product-error.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';

test('classification runtime stops while its database is still available when byok is enabled', async () => {
  const app = Fastify();
  const order: string[] = [];
  let databaseOpen = true;
  const runtime = (name: string) => ({
    start() { order.push(`start:${name}`); },
    async stop() {
      await Promise.resolve();
      assert.equal(databaseOpen, true, `${name} must release leases before database teardown`);
      order.push(`stop:${name}`);
    },
  });
  const deps = {
    config: {
      allowedOrigins: [],
      betterAuth: { enabled: false, trustedOrigins: [] },
      classification: { enabled: true, byokEnabled: true, batchEnabled: true },
    },
    identityUnitOfWork: {},
    classificationPreview: runtime('preview'),
    classificationProfiles: runtime('profiles'),
    classificationRuns: runtime('runs'),
  } as unknown as AppDependencies;
  registerClassificationProductSurfaces(app, deps, () => ({
    consume: async () => ({ kind: 'allowed' as const }),
  }));
  app.addHook('onClose', async () => { databaseOpen = false; order.push('database-close'); });
  await app.ready();
  await app.close();
  assert.equal(order.at(-1), 'database-close');
  for (const name of ['preview', 'profiles', 'runs']) {
    assert.equal(order.filter(value => value === `start:${name}`).length, 1);
    assert.equal(order.filter(value => value === `stop:${name}`).length, 1);
  }
});

test('when byok is off, profile routes and runtime hooks are not registered', async () => {
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => sendProductError(request, reply, error instanceof ProductHttpError ? error : new ProductHttpError({ statusCode: 500, code: 'internal_error', message: 'test failure' })));
  const order: string[] = [];
  const runtime = (name: string) => ({
    start() { order.push(`start:${name}`); },
    async stop() { order.push(`stop:${name}`); },
    list: async () => ({ profiles: [], etag: 'w' }),
  });
  const deps = {
    config: {
      allowedOrigins: [],
      betterAuth: { enabled: false, trustedOrigins: [] },
      classification: { enabled: true, byokEnabled: false },
    },
    identityUnitOfWork: {
      // Only a session/account/clock triple is reached here; the dependency object
      // as a whole is narrowed to AppDependencies once, below.
      execute: (fn: (ports: unknown) => unknown) => fn({
        sessions: { findByTokenHash: async () => ({ accountId: 'a', subjectId: 's', securityEpoch: 1n, idleExpiresAt: new Date(Date.now() + 60000), absoluteExpiresAt: new Date(Date.now() + 60000), revokedAt: null }), touch: async () => true },
        accounts: { findById: async () => ({ id: 'a', subjectId: 's', status: 'active', securityEpoch: 1n, deletedAt: null }) },
        clock: { now: async () => new Date() },
      }),
    },
    classificationPreview: runtime('preview'),
    classificationProfiles: runtime('profiles'),
    classificationSettings: {
      reads: { loadOwned: async () => ({ contractVersion: '1.0.0', collectionId: 'col', revision: '1', autoTagMode: 'off', maxAutoTags: 5, executionMode: 'server_managed', providerProfileId: null, updatedAt: new Date().toISOString() }) },
      commands: { execute: async () => ({ kind: 'succeeded' }) },
    },
  } as unknown as AppDependencies;
  registerClassificationProductSurfaces(app, deps, () => createFixedWindowRateLimiter({ maxRequests: 100, windowMs: 60000 }));
  await app.ready();

  // Profile runtime hooks must not be registered
  expect(order).toEqual(['start:preview']);
  expect(order).not.toContain('start:profiles');

  // Profile routes must NOT be in route table
  const routes = app.printRoutes();
  expect(routes).not.toContain('classification-provider-profiles');

  // All 5 profile routes return 404
  const auth = { cookie: '__Host-known_session=test' };
  const base = '/api/v1/me/classification-provider-profiles';
  expect((await app.inject({ method: 'GET', url: base, headers: auth })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: base, headers: auth, payload: {} })).statusCode).toBe(404);
  expect((await app.inject({ method: 'PATCH', url: `${base}/p1`, headers: auth, payload: {} })).statusCode).toBe(404);
  expect((await app.inject({ method: 'DELETE', url: `${base}/p1`, headers: auth })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: `${base}/p1/test`, headers: auth })).statusCode).toBe(404);

  // Settings v2 is 404 when byokEnabled is false
  const settingsUrl = '/api/v1/collections/col/classification-settings';
  expect((await app.inject({ method: 'GET', url: settingsUrl, headers: { ...auth, accept: CLASSIFICATION_SETTINGS_V2_MEDIA } })).statusCode).toBe(404);
  // Settings v1 is 200
  expect((await app.inject({ method: 'GET', url: settingsUrl, headers: auth })).statusCode).toBe(200);

  await app.close();
  expect(order).not.toContain('stop:profiles');
});

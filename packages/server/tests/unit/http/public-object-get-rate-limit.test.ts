/**
 * SEC-T-09 / T-C4: public avatar and bookmark-favicon GET share a cheap
 * `public-object` IP limiter. They must not use the auth `me` family (POST
 * /api/v1/me/avatar). Single-replica/test uses memory; production replicas
 * inject one purpose-isolated Redis adapter shared by both GET surfaces.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'vitest';
import Fastify from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import type { AvatarObjectStore } from '../../../src/modules/identity/index.js';
import type { BookmarkFaviconObjectStore } from '../../../src/modules/collections/index.js';
import { registerBrowserAuthRoutes } from '../../../src/transport/auth/browser-auth-routes.js';
import { registerAvatarRoutes } from '../../../src/transport/auth/browser-auth-handlers.js';
import { registerBookmarkFaviconRoutes } from '../../../src/transport/product/bookmark-favicon-routes.js';
import { ProductHttpError, sendProductError } from '../../../src/transport/product-error.js';
import {
  PUBLIC_OBJECT_RATE_LIMIT_FAMILY,
  admitPublicObjectGet,
  createPublicObjectRateLimiter,
  type PublicObjectRateLimiter,
} from '../../../src/transport/product/public-object-rate-limit.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';
import {
  productRouteRateLimitSharedEnv,
  testEnv,
} from '../../support/http-security-config-env.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);
const OBJECT_ID = '123e4567-e89b-42d3-a456-426614174000';

const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/public_object_rate_limit_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ISSUER: 'https://issuer.example/realms/known',
  OIDC_CLIENT_ID: 'known-web',
  OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
  OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function memoryAvatarStore(): AvatarObjectStore {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  objects.set(OBJECT_ID, { contentType: 'image/png', body: PNG });
  return {
    async put(avatarId, body, contentType) {
      objects.set(avatarId, { contentType, body: Buffer.from(body) });
    },
    async get(avatarId) {
      return objects.get(avatarId) ?? null;
    },
    async delete(avatarId) {
      objects.delete(avatarId);
    },
  };
}

function memoryFaviconStore(): BookmarkFaviconObjectStore {
  const objects = new Map<string, { contentType: string; body: Buffer }>();
  objects.set(OBJECT_ID, { contentType: 'image/png', body: PNG });
  return {
    async put(objectId, body, contentType) {
      objects.set(objectId, { contentType, body: Buffer.from(body) });
    },
    async get(objectId) {
      return objects.get(objectId) ?? null;
    },
    async delete(objectId) {
      objects.delete(objectId);
    },
  };
}

async function buildApp(options: {
  readonly publicObjectRateLimiter?: PublicObjectRateLimiter;
  readonly includeAvatar?: boolean;
  readonly includeFavicon?: boolean;
}) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProductHttpError) {
      return sendProductError(request, reply, error);
    }
    throw error;
  });
  registerBrowserAuthRoutes(app, {
    config,
    identityUnitOfWork: createIdentityMemoryUnitOfWork(
      createIdentityMemoryState(new Date('2026-08-23T00:00:00.000Z')),
    ),
    ...(options.includeAvatar === false ? {} : { avatarStore: memoryAvatarStore() }),
    ...(options.publicObjectRateLimiter
      ? { publicObjectRateLimiter: options.publicObjectRateLimiter }
      : {}),
  });
  registerBookmarkFaviconRoutes(app, {
    config,
    ...(options.includeFavicon === false ? {} : { faviconStore: memoryFaviconStore() }),
    ...(options.publicObjectRateLimiter
      ? { publicObjectRateLimiter: options.publicObjectRateLimiter }
      : {}),
  });
  await app.ready();
  apps.push(app);
  return app;
}

describe('public-object GET limiter', () => {
  test('family is public-object, not the auth me upload family', () => {
    assert.equal(PUBLIC_OBJECT_RATE_LIMIT_FAMILY, 'public-object');
    assert.notEqual(PUBLIC_OBJECT_RATE_LIMIT_FAMILY, 'me');
  });

  test('explicit memory fallback remains process-local for single-replica/test composition', () => {
    const replicaA = createPublicObjectRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
    const replicaB = createPublicObjectRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
    const key = `${PUBLIC_OBJECT_RATE_LIMIT_FAMILY}|203.0.113.10`;
    assert.equal(replicaA.consume(key).allowed, true);
    assert.equal(replicaA.consume(key).allowed, false, 'single-process limiter still enforces the quota');
    assert.equal(
      replicaB.consume(key).allowed,
      true,
      'a second replica has its own in-memory counter; origin does not guarantee cross-replica quotas',
    );
  });

  test('transport helper stays adapter-agnostic and both GET handlers await it', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../src/transport');
    for (const file of [
      'product/public-object-rate-limit.ts',
      'auth/browser-auth-handlers.ts',
      'product/bookmark-favicon-routes.ts',
    ]) {
      const source = readFileSync(join(root, file), 'utf8');
      if (file === 'product/public-object-rate-limit.ts') {
        assert.match(source, /public-object/);
        assert.doesNotMatch(source, /from ['"].*redis/i);
        assert.doesNotMatch(source, /from ['"].*bootstrap\/config/);
        assert.doesNotMatch(source, /process\.env/);
      }
    }
    const avatar = readFileSync(join(root, 'auth/browser-auth-handlers.ts'), 'utf8');
    const favicon = readFileSync(join(root, 'product/bookmark-favicon-routes.ts'), 'utf8');
    assert.match(avatar, /admitPublicObjectGet/);
    assert.match(favicon, /admitPublicObjectGet/);
    assert.match(avatar, /await admitPublicObjectGet/);
    assert.match(favicon, /await admitPublicObjectGet/);
    const avatarGet = avatar.slice(avatar.indexOf("app.get('/api/v1/avatar/:avatarId'"));
    const avatarGetHandler = avatarGet.slice(0, avatarGet.indexOf('\n}\n\nfunction'));
    assert.doesNotMatch(avatarGetHandler, /rateLimitFamily:\s*'me'/);
  });

  test('direct route registration cannot silently replace a configured shared adapter', () => {
    const sharedConfig = loadConfig(testEnv(productRouteRateLimitSharedEnv()));
    const identityUnitOfWork = createIdentityMemoryUnitOfWork(
      createIdentityMemoryState(new Date('2026-08-23T00:00:00.000Z')),
    );
    const avatarApp = Fastify({ logger: false });
    apps.push(avatarApp);
    assert.throws(
      () => registerAvatarRoutes(avatarApp, { config: sharedConfig, identityUnitOfWork }),
      /injected public-object limiter.*PRODUCT_ROUTE_RATE_LIMIT_SHARED=true/s,
    );
    const faviconApp = Fastify({ logger: false });
    apps.push(faviconApp);
    assert.throws(
      () => registerBookmarkFaviconRoutes(faviconApp, { config: sharedConfig }),
      /injected public-object limiter.*PRODUCT_ROUTE_RATE_LIMIT_SHARED=true/s,
    );
  });

  test('legitimate avatar GET is 200 with nosniff; over quota is 429', async () => {
    const limiter = createPublicObjectRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
    const app = await buildApp({ publicObjectRateLimiter: limiter, includeFavicon: false });
    const ok = await app.inject({ method: 'GET', url: `/api/v1/avatar/${OBJECT_ID}` });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal(ok.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.deepEqual(ok.rawPayload, PNG);
    const denied = await app.inject({ method: 'GET', url: `/api/v1/avatar/${OBJECT_ID}` });
    assert.equal(denied.statusCode, 429, denied.body);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'rate_limited');
    assert.ok(denied.headers['retry-after']);
  });

  test('legitimate favicon GET is 200 with nosniff; over quota is 429', async () => {
    const limiter = createPublicObjectRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
    const app = await buildApp({ publicObjectRateLimiter: limiter, includeAvatar: false });
    const ok = await app.inject({ method: 'GET', url: `/api/v1/favicon/${OBJECT_ID}` });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(ok.rawPayload, PNG);
    const denied = await app.inject({ method: 'GET', url: `/api/v1/favicon/${OBJECT_ID}` });
    assert.equal(denied.statusCode, 429, denied.body);
    assert.equal((denied.json() as { error: { code: string } }).error.code, 'rate_limited');
  });

  test('avatar and favicon GET share the public-object family when given the same limiter', async () => {
    const limiter = createPublicObjectRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
    const app = await buildApp({ publicObjectRateLimiter: limiter });
    const avatar = await app.inject({ method: 'GET', url: `/api/v1/avatar/${OBJECT_ID}` });
    assert.equal(avatar.statusCode, 200, avatar.body);
    const favicon = await app.inject({ method: 'GET', url: `/api/v1/favicon/${OBJECT_ID}` });
    assert.equal(favicon.statusCode, 429, favicon.body);
  });

  test('admitPublicObjectGet rejects with ProductHttpError 429 after the window is spent', async () => {
    const limiter = createPublicObjectRateLimiter({ maxRequests: 1, windowMs: 60_000, now: () => 0 });
    const request = { ip: '198.51.100.20' } as Parameters<typeof admitPublicObjectGet>[1];
    await admitPublicObjectGet(limiter, request);
    await assert.rejects(
      admitPublicObjectGet(limiter, request),
      (error: unknown) => {
        assert.ok(error instanceof ProductHttpError);
        assert.equal(error.statusCode, 429);
        assert.equal(error.productCode, 'rate_limited');
        return true;
      },
    );
  });

  test('shared adapter failure fails closed with 503 on public-object GET', async () => {
    const unavailable: PublicObjectRateLimiter = {
      purpose: 'public-object',
      async consume() {
        return { kind: 'failed', failure: { class: 'unavailable', code: 'redis_unavailable' } };
      },
      readiness() {
        return { status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: 0 };
      },
      async close() {},
    };
    const app = await buildApp({ publicObjectRateLimiter: unavailable, includeFavicon: false });
    const response = await app.inject({ method: 'GET', url: `/api/v1/avatar/${OBJECT_ID}` });
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(
      (response.json() as { error: { code: string } }).error.code,
      'feature_temporarily_unavailable',
    );
  });
});

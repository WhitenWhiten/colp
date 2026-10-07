import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { type ExplorePageReadPort } from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import { admitPublicActivityRateLimit } from '../../../src/transport/product/public-activity-rate-limit.js';
import type { ProductPublicActivityQuery } from '../../../src/transport/product/product-public-activity-routes.js';

const apps: Array<ReturnType<typeof buildApiApp>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

const PAGE = Object.freeze({
  items: Object.freeze([Object.freeze({
    activityId: 'activity-1',
    kind: 'collection_change' as const,
    collectionId: 'IiIiIiIiIiIiIiIiIiIiIg',
    collectionTitle: 'Public title',
    publicationSlug: 'public-one',
    publishedAt: '2026-08-22T04:00:00.000Z',
    summary: 'public_collection_updated',
  })]),
  nextCursor: null,
});

function activityQuery(): ProductPublicActivityQuery {
  return Object.freeze({
    async get() { return PAGE; },
  });
}

function generousLimiter(): ReturnType<typeof createMemorySearchRateLimiter> {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000,
    accountMaxRequests: 10_000,
    windowMs: 60_000,
  });
}

function explorePageQuery(): ExplorePageReadPort {
  return {
    async loadPage() {
      return Object.freeze([{
        id: 'public-one',
        ownerSubjectId: 'owner',
        title: 'Explore stays independent',
        summary: null,
        kind: 'bookmarks' as const,
        visibility: 'public' as const,
        publicationSlug: 'public-one',
        tags: Object.freeze(['tag']),
        nodeCount: 1,
        viewCount: 0,
        updatedAt: '2026-07-24T00:00:00.000Z',
        orderingUpdatedAtMicros: '1784851200000000',
      }]);
    },
  };
}

test('anonymous public Activity GET is 200 with a public short cache', async () => {
  const app = buildApiApp({
    config,
    publicActivityQuery: activityQuery(),
    publicActivityRateLimiter: generousLimiter(),
  });
  apps.push(app);
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/profiles/pa01-owner/activity',
    headers: { accept: 'text/plain' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'public, max-age=60');
  assert.equal(response.json().error, undefined);
  assert.deepEqual(response.json(), PAGE);
  const head = await app.inject({ method: 'HEAD', url: '/api/v1/profiles/pa01-owner/activity' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['cache-control'], 'public, max-age=60');
});

test('a handle containing percent is resource_not_found like public Profile', async () => {
  const app = buildApiApp({
    config,
    publicActivityQuery: activityQuery(),
    publicActivityRateLimiter: generousLimiter(),
  });
  apps.push(app);
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/profiles/pa01%25owner/activity',
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.equal(response.json().error.message, 'The requested Profile was not found.');
});

test('unknown handle is resource_not_found without Profile Accept negotiation', async () => {
  const app = buildApiApp({
    config,
    publicActivityQuery: {
      async get() {
        const error = new Error('Public Profile was not found.');
        (error as Error & { code: string }).code = 'resource_not_found';
        throw error;
      },
    },
    publicActivityRateLimiter: generousLimiter(),
  });
  apps.push(app);
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/profiles/missing-owner/activity',
    headers: { accept: 'application/xml' },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, 'resource_not_found');
  assert.notEqual(response.json().error.code, 'not_acceptable');
});

test('exhausting the Activity limiter leaves Explore on an independent budget', async () => {
  const activityLimiter = createMemorySearchRateLimiter({
    anonymousMaxRequests: 1,
    accountMaxRequests: 1,
    windowMs: 60_000,
  });
  const exploreLimiter = createMemorySearchRateLimiter({
    anonymousMaxRequests: 30,
    accountMaxRequests: 120,
    windowMs: 60_000,
  });
  const app = buildApiApp({
    config,
    publicActivityQuery: activityQuery(),
    publicActivityRateLimiter: activityLimiter,
    explorePageQuery: explorePageQuery(),
    exploreDirectoryRateLimiter: exploreLimiter,
  });
  apps.push(app);
  assert.equal((await app.inject({
    method: 'GET', url: '/api/v1/profiles/pa01-owner/activity',
  })).statusCode, 200);
  const denied = await app.inject({ method: 'GET', url: '/api/v1/profiles/pa01-owner/activity' });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, 'rate_limited');
  const explore = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
  assert.equal(explore.statusCode, 200);
  assert.equal(explore.headers['cache-control'], 'public, max-age=60');
});

test('omitted Activity limiter fails closed at composition when shared is off', () => {
  assert.throws(
    () => buildApiApp({ config, publicActivityQuery: activityQuery() }),
    /injected publicActivityRateLimiter whenever public Activity routes are registered/,
  );
});

test('admitPublicActivityRateLimit fails closed when the limiter is missing', async () => {
  await assert.rejects(
    () => admitPublicActivityRateLimit(
      undefined,
      { family: 'anonymous', subject: '203.0.113.10' },
      'Too many public Activity requests. Please try again later.',
    ),
    /public Activity rate limiter is required/,
  );
});

test('shared public Activity adapter without an injected limiter fails closed at composition', () => {
  const shared = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PUBLIC_ACTIVITY_RATE_LIMIT_SHARED: 'true',
    PUBLIC_ACTIVITY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    PUBLIC_ACTIVITY_RATE_LIMIT_KEY_SECRET: 'public-activity-rate-limit-hmac-secret',
  });
  assert.throws(
    () => buildApiApp({ config: shared, publicActivityQuery: activityQuery() }),
    /injected publicActivityRateLimiter.*PUBLIC_ACTIVITY_RATE_LIMIT_SHARED=true/s,
  );
});

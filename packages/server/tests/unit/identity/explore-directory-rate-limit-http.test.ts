/**
 * P-04 Explore / COLP Directory admission: search-level IP budget, independent
 * limiter instance from Search. Missing limiter fails closed at buildApiApp.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  createPublicationCursorKeyring,
  type ExplorePageReadPort,
  type PublicationDirectoryQueryPorts,
  type PublicationDirectoryRecord,
} from '../../../src/modules/publication/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { admitExploreDirectoryRateLimit } from '../../../src/transport/product/explore-directory-rate-limit.js';
import { createMemorySearchRateLimiter } from '../../../src/transport/http-security.js';
import type { SearchRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';

const apps: Array<ReturnType<typeof buildApiApp>> = [];
const cursorsToDestroy: Array<{ destroy(): void }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  while (cursorsToDestroy.length > 0) cursorsToDestroy.pop()?.destroy();
});

const config = loadConfig({
  DATABASE_URL: 'postgres://unused/known',
  PRODUCT_ORIGIN: 'https://known.example',
  PUBLICATION_ORIGIN: 'https://known.example',
  LOG_LEVEL: 'silent',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
});

function directoryRow(id = 'public-one'): PublicationDirectoryRecord {
  return Object.freeze({
    id,
    ownerSubjectId: 'owner',
    title: id,
    summary: null,
    kind: 'bookmarks',
    visibility: 'public',
    publicationSlug: id,
    tags: Object.freeze(['tag']),
    language: null,
    nodeCount: 1,
    updatedAt: '2026-07-24T00:00:00.000Z',
    protectedAuthorized: false,
    orderingUpdatedAtMicros: '1784851200000000',
  });
}

function directoryQuery(): PublicationDirectoryQueryPorts {
  const cursors = createPublicationCursorKeyring({
    active: { id: 'explore-rl-v1', secret: Buffer.alloc(32, 31).toString('base64') },
    retained: [],
  });
  cursorsToDestroy.push(cursors);
  return {
    cursors,
    origin: 'https://known.example',
    maxPageSize: 500,
    reads: {
      async loadPage(request) {
        return Object.freeze([directoryRow()].slice(0, request.limit));
      },
    },
  };
}

function explorePageQuery(): ExplorePageReadPort {
  return {
    async loadPage() {
      return Object.freeze([{
        id: 'public-one',
        ownerSubjectId: 'owner',
        title: 'public-one',
        summary: null,
        kind: 'bookmarks' as const,
        visibility: 'public' as const,
        publicationSlug: 'public-one',
        tags: Object.freeze(['tag']),
        nodeCount: 1,
        orderingNodeCount: 1,
        language: null,
        hiddenPublic: false,
        viewCount: 0,
        updatedAt: '2026-07-24T00:00:00.000Z',
        orderingUpdatedAtMicros: '1784851200000000',
      }]);
    },
  };
}

function directoryHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.collection-protocol.catalog+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
}

function tightLimiter(): ReturnType<typeof createMemorySearchRateLimiter> {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 1,
    accountMaxRequests: 1,
    windowMs: 60_000,
  });
}

function generousLimiter(): ReturnType<typeof createMemorySearchRateLimiter> {
  return createMemorySearchRateLimiter({
    anonymousMaxRequests: 10_000,
    accountMaxRequests: 10_000,
    windowMs: 60_000,
  });
}

test('anonymous Explore over budget is 429 rate_limited with Retry-After', async () => {
  const app = buildApiApp({
    config,
    publicationDirectoryQuery: directoryQuery(),
    explorePageQuery: explorePageQuery(),
    exploreDirectoryRateLimiter: tightLimiter(),
  });
  apps.push(app);
  const allowed = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?sort=popular' });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['cache-control'], 'public, max-age=60');
  const denied = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?sort=popular' });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, 'rate_limited');
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal(denied.headers['ratelimit-policy'], 'search:anonymous:1:60000');
  assert.equal((await app.inject({ method: 'HEAD', url: '/api/v1/explore/collections' })).statusCode, 429);
});

test('anonymous COLP directory over budget is 429 rate_limited', async () => {
  const limiter = tightLimiter();
  const app = buildApiApp({
    config,
    publicationDirectoryQuery: directoryQuery(),
    exploreDirectoryRateLimiter: limiter,
  });
  apps.push(app);
  const first = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory', headers: directoryHeaders(),
  });
  assert.equal(first.statusCode, 200);
  const denied = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory', headers: directoryHeaders(),
  });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().code, 'rate_limited');
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal(denied.headers['ratelimit-policy'], 'search:anonymous:1:60000');
});

test('Explore and COLP directory may share one limiter instance without sharing Search', async () => {
  const exploreLimiter = tightLimiter();
  const searchLimiter = createMemorySearchRateLimiter({
    anonymousMaxRequests: 30,
    accountMaxRequests: 120,
    windowMs: 60_000,
  });
  const app = buildApiApp({
    config,
    publicationDirectoryQuery: directoryQuery(),
    explorePageQuery: explorePageQuery(),
    exploreDirectoryRateLimiter: exploreLimiter,
    searchQuery: {
      execute: async () => ({
        normalizedQuery: 'probe',
        types: ['collection', 'node', 'profile', 'annotation'],
        items: [],
        page: { returnedCount: 0, hasMore: false, nextCursor: null },
        cache: { class: 'shared-public', partition: 'anonymous-representation-partition' },
        consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
      }),
    },
    searchRateLimiter: searchLimiter,
  });
  apps.push(app);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/explore/collections' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/explore/collections' })).statusCode, 429);
  const search = await app.inject({ method: 'GET', url: '/api/v1/search?q=probe' });
  assert.equal(search.statusCode, 200);
});

test('COLP directory account family does not share the anonymous IP bucket', async () => {
  const limiter = createMemorySearchRateLimiter({
    anonymousMaxRequests: 1,
    accountMaxRequests: 2,
    windowMs: 60_000,
  });
  const identityUnitOfWork = createIdentityMemoryUnitOfWork(
    createIdentityMemoryState('2026-07-24T00:00:00.000Z'),
  );
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork });
  const app = buildApiApp({
    config,
    identityUnitOfWork,
    browserSessionAuthority: factory.authority,
    publicationDirectoryQuery: directoryQuery(),
    exploreDirectoryRateLimiter: limiter,
  });
  apps.push(app);
  assert.equal((await app.inject({
    method: 'GET', url: '/colp/v0.1/directory', headers: directoryHeaders(),
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'GET', url: '/colp/v0.1/directory', headers: directoryHeaders(),
  })).statusCode, 429);
  const session = await issueTestSession({
    factory, subject: 'directory-member-1', handle: 'directory-member-1',
  });
  const member = await app.inject({
    method: 'GET',
    url: '/colp/v0.1/directory',
    headers: { ...directoryHeaders(), cookie: session.cookie },
  });
  assert.equal(member.statusCode, 200);
});

test('Explore Redis outage is 503 feature_temporarily_unavailable without quota facts', async () => {
  const failing: SearchRateLimiter = {
    consume: async () => ({
      kind: 'failed',
      failure: { class: 'unavailable', code: 'rate_limit_unavailable' },
    }),
    readiness: () => ({ status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: 0 }),
    policy: { anonymous: 'search:anonymous:30:60000', account: 'search:account:120:60000' },
    close: async () => undefined,
  };
  const app = buildApiApp({
    config,
    publicationDirectoryQuery: directoryQuery(),
    explorePageQuery: explorePageQuery(),
    exploreDirectoryRateLimiter: failing,
  });
  apps.push(app);
  const response = await app.inject({ method: 'GET', url: '/api/v1/explore/collections' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'feature_temporarily_unavailable');
  assert.equal(response.headers['retry-after'], undefined);
  assert.equal(response.headers['ratelimit-policy'], undefined);
});

test('Explore rejects limit greater than 100; COLP directory allows 500', async () => {
  const app = buildApiApp({
    config,
    publicationDirectoryQuery: directoryQuery(),
    explorePageQuery: explorePageQuery(),
    exploreDirectoryRateLimiter: generousLimiter(),
  });
  apps.push(app);
  const overflow = await app.inject({ method: 'GET', url: '/api/v1/explore/collections?limit=101' });
  assert.equal(overflow.statusCode, 400);
  assert.equal(overflow.json().error.code, 'invalid_query');
  const colp = await app.inject({
    method: 'GET', url: '/colp/v0.1/directory?limit=500', headers: directoryHeaders(),
  });
  assert.equal(colp.statusCode, 200);
});

test('omitted Explore limiter fails closed at composition when shared is off', () => {
  const unused = {} as never;
  assert.throws(
    () => buildApiApp({ config, publicationDirectoryQuery: directoryQuery() }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
  assert.throws(
    () => buildApiApp({ config, explorePageQuery: explorePageQuery() }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
  assert.throws(
    () => buildApiApp({ config, productPublicCollectionQuery: unused }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
  assert.throws(
    () => buildApiApp({ config, publicProfileQuery: unused }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
  assert.throws(
    () => buildApiApp({ config, publicationSnapshotQuery: unused }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
  assert.throws(
    () => buildApiApp({ config, publicationMetadataQuery: unused }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
});

test('admitExploreDirectoryRateLimit fails closed when the limiter is missing', async () => {
  await assert.rejects(
    () => admitExploreDirectoryRateLimit(
      undefined,
      { family: 'anonymous', subject: '203.0.113.10' },
      'Too many Explore requests. Please try again later.',
    ),
    /Explore\/Directory rate limiter is required/,
  );
});

test('shared explore-directory adapter without an injected limiter fails closed at composition', () => {
  const shared = loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    EXPLORE_DIRECTORY_RATE_LIMIT_SHARED: 'true',
    EXPLORE_DIRECTORY_RATE_LIMIT_REDIS_URL: 'redis://127.0.0.1:6379',
    EXPLORE_DIRECTORY_RATE_LIMIT_KEY_SECRET: 'explore-directory-rate-limit-hmac-secret',
  });
  const unused = {} as never;
  assert.throws(
    () => buildApiApp({ config: shared, publicationDirectoryQuery: directoryQuery() }),
    /injected exploreDirectoryRateLimiter.*EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true/s,
  );
  assert.throws(
    () => buildApiApp({ config: shared, explorePageQuery: explorePageQuery() }),
    /injected exploreDirectoryRateLimiter.*EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true/s,
  );
  assert.throws(
    () => buildApiApp({ config: shared, productPublicCollectionQuery: unused }),
    /injected exploreDirectoryRateLimiter.*EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true/s,
  );
  assert.throws(
    () => buildApiApp({ config: shared, publicProfileQuery: unused }),
    /injected exploreDirectoryRateLimiter.*EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true/s,
  );
  assert.throws(
    () => buildApiApp({ config: shared, publicationSnapshotQuery: unused }),
    /injected exploreDirectoryRateLimiter.*EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true/s,
  );
  assert.throws(
    () => buildApiApp({ config: shared, publicationMetadataQuery: unused }),
    /injected exploreDirectoryRateLimiter.*EXPLORE_DIRECTORY_RATE_LIMIT_SHARED=true/s,
  );
});

function deniedLimiter(): SearchRateLimiter {
  return {
    consume: async () => ({
      kind: 'denied',
      decision: { allowed: false, retryAfterSeconds: 60 },
    }),
    readiness: () => ({ status: 'healthy', reason: 'none', lastCheckedAtEpochMs: 0 }),
    policy: { anonymous: 'search:anonymous:1:60000', account: 'search:account:1:60000' },
    close: async () => undefined,
  };
}

function snapshotHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.collection-protocol.snapshot+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
}

function metadataHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.collection-protocol.collection+json;version=0.1',
    'collection-protocol-version': '0.1',
  };
}

test('denied Explore limiter is 429 on public Collection GET and HEAD', async () => {
  const app = buildApiApp({
    config,
    productPublicCollectionQuery: {} as never,
    exploreDirectoryRateLimiter: deniedLimiter(),
  });
  apps.push(app);
  const denied = await app.inject({ method: 'GET', url: '/api/v1/collections/published' });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, 'rate_limited');
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal((await app.inject({ method: 'HEAD', url: '/api/v1/collections/published' })).statusCode, 429);
});

test('omitted Explore limiter fails closed for public Collection paging validation', () => {
  assert.throws(
    () => buildApiApp({
      config,
      productPublicCollectionQuery: {} as never,
    }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
});

test('denied Explore limiter is 429 on public Profile GET and HEAD', async () => {
  const app = buildApiApp({
    config,
    publicProfileQuery: {
      async get() { throw new Error('profile query must not run after deny'); },
    },
    exploreDirectoryRateLimiter: deniedLimiter(),
  });
  apps.push(app);
  const denied = await app.inject({
    method: 'GET', url: '/api/v1/profiles/alice', headers: { accept: 'application/json' },
  });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, 'rate_limited');
  assert.equal((await app.inject({
    method: 'HEAD', url: '/api/v1/profiles/alice', headers: { accept: 'application/json' },
  })).statusCode, 429);
});

test('omitted Explore limiter fails closed for public Profile', () => {
  assert.throws(
    () => buildApiApp({
      config,
      publicProfileQuery: {
        async get() { return { profile: { handle: 'alice' }, collections: [], page: { cursor: null, hasMore: false } }; },
      },
    }),
    /injected exploreDirectoryRateLimiter whenever Explore\/Directory routes are registered/,
  );
});

test('denied Explore limiter is 429 on COLP snapshot GET and HEAD', async () => {
  const app = buildApiApp({
    config,
    publicationSnapshotQuery: {} as never,
    exploreDirectoryRateLimiter: deniedLimiter(),
  });
  apps.push(app);
  const denied = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1/snapshot', headers: snapshotHeaders(),
  });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().code, 'rate_limited');
  assert.equal(denied.headers['retry-after'], '60');
  assert.equal((await app.inject({
    method: 'HEAD', url: '/colp/v0.1/collections/collection-1/snapshot', headers: snapshotHeaders(),
  })).statusCode, 429);
});

test('denied Explore limiter is 429 on COLP metadata GET and HEAD', async () => {
  const app = buildApiApp({
    config,
    publicationMetadataQuery: {} as never,
    exploreDirectoryRateLimiter: deniedLimiter(),
  });
  apps.push(app);
  const denied = await app.inject({
    method: 'GET', url: '/colp/v0.1/collections/collection-1', headers: metadataHeaders(),
  });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().code, 'rate_limited');
  assert.equal((await app.inject({
    method: 'HEAD', url: '/colp/v0.1/collections/collection-1', headers: metadataHeaders(),
  })).statusCode, 429);
});

test('public Collection shares the Explore limiter instance', async () => {
  const app = buildApiApp({
    config,
    explorePageQuery: explorePageQuery(),
    productPublicCollectionQuery: {} as never,
    exploreDirectoryRateLimiter: tightLimiter(),
  });
  apps.push(app);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/explore/collections' })).statusCode, 200);
  const denied = await app.inject({ method: 'GET', url: '/api/v1/collections/published' });
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, 'rate_limited');
});

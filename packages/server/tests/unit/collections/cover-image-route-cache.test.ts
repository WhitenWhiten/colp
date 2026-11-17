/**
 * A4-1: uploaded covers are reauthorized on every read, so no response may be
 * immutable. A public cover is shared-cacheable for at most five minutes plus
 * revalidation — a revoked or unpublished cover stops being usable from a CDN
 * within that window instead of a year. A non-public cover keeps `private` and
 * stays in that reader's browser cache, revalidating when stale.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import type { NodeCoverCommandUnitOfWork } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import type { LinkPreviewPublicAccess } from '../../../src/transport/product/link-preview-routes.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { createMemoryObjectStore, makePng, type MemoryObjectStore } from '../../support/link-preview-fixtures.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
  issueTestSession,
} from '../../support/product-http-harness.js';
import { loadConfig } from '../../support/test-config.js';

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = new Date('2026-09-26T08:00:00.000Z');
const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/cover_image_route_cache_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  KNOWN_FEATURE_LINK_PREVIEW: 'false',
});
const noCommands: NodeCoverCommandUnitOfWork = {
  execute: async () => { throw new Error('not used'); },
};

function access(input: { servable: boolean; readers?: readonly string[] }): LinkPreviewPublicAccess {
  return {
    isServable: async () => input.servable,
    isReadableBySubject: async (_objectId, subjectId) => input.readers?.includes(subjectId) === true,
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

function app(store: MemoryObjectStore, publicAccess: LinkPreviewPublicAccess, extra = {}) {
  const built = buildApiApp({ config, coverImages: { store, publicAccess, commands: noCommands }, ...extra });
  apps.push(built);
  return built;
}

describe('GET /api/v1/images/:imageId cache policy', () => {
  test('a public uploaded cover is never immutable and shared-caches for at most five minutes', async () => {
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    await store.put(ID, png, 'image/png');
    const server = app(store, access({ servable: true }));
    const url = `/api/v1/images/${ID}`;
    const response = await server.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'public, max-age=300, must-revalidate');
    assert.equal(response.headers['cache-control']?.includes('immutable'), false);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers.vary, 'Cookie');
    assert.deepEqual(response.rawPayload, png);

    const revalidated = await server.inject({
      method: 'GET', url, headers: { 'if-none-match': String(response.headers.etag) },
    });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.headers['cache-control'], response.headers['cache-control']);
  });

  test('a non-public uploaded cover stays private to its reader and revalidates', async () => {
    const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
    const owner = await issueTestSession({ factory, subject: 'cover-owner', displayName: 'Owner', handle: 'coverowner' });
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    await store.put(ID, png, 'image/png');
    const server = app(store, access({ servable: false, readers: [owner.subjectId] }), {
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
    });
    const url = `/api/v1/images/${ID}`;

    const read = await server.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.headers['cache-control'], 'private, max-age=604800, must-revalidate');
    assert.equal(read.headers['cache-control']?.includes('immutable'), false);
    assert.equal(read.headers.vary, 'Cookie');
    assert.deepEqual(read.rawPayload, png);

    const revalidated = await server.inject({
      method: 'GET', url, headers: { cookie: owner.cookie, 'if-none-match': String(read.headers.etag) },
    });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.headers['cache-control'], read.headers['cache-control']);
  });
});

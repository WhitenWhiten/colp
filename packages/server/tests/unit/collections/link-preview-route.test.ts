/**
 * LP-04: GET /api/v1/link-preview/:previewId. Registered only while the
 * feature is on. Anonymous readers get bytes only while a public or unlisted
 * bookmark still exposes the object, with a short revalidated cache. A
 * signed-in owner or member also gets their private collection's objects,
 * never cached. Illegal ids, hidden objects, missing objects and non-images
 * share one 404.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import type { LinkPreviewCommandUnitOfWork } from '../../../src/modules/collections/index.js';
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
  DATABASE_URL: 'postgres://localhost/link_preview_route_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  KNOWN_FEATURE_LINK_PREVIEW: 'true',
});
const noCommands: LinkPreviewCommandUnitOfWork = {
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
  const built = buildApiApp({ config, linkPreview: { store, publicAccess, commands: noCommands }, ...extra });
  apps.push(built);
  return built;
}

describe('GET /api/v1/link-preview/:previewId', () => {
  test('serves stored image bytes with a short revalidated cache and nosniff', async () => {
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    await store.put(ID, png, 'text/html'); // declared type is ignored
    const response = await app(store, access({ servable: true })).inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.equal(response.headers['cache-control'], 'public, max-age=60, must-revalidate');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(response.rawPayload, png);
  });

  test('illegal ids, missing objects and non-servable bytes share one short-cached 404', async () => {
    const store = createMemoryObjectStore();
    const ico = Buffer.from('00000100010010100000010020006804000016000000', 'hex');
    await store.put('1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', Buffer.from('<html>hi</html>'), 'image/png');
    await store.put('2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', ico, 'image/x-icon');
    const server = app(store, access({ servable: true }));
    for (const id of [
      'not-a-uuid',
      '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D',
      ID,
      '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    ]) {
      const response = await server.inject({ method: 'GET', url: `/api/v1/link-preview/${id}` });
      assert.equal(response.statusCode, 404, id);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
      assert.equal(response.headers['cache-control'], 'public, max-age=60', id);
    }
  });

  test('a stored image is 404 when no public bookmark still exposes it', async () => {
    const store = createMemoryObjectStore();
    await store.put(ID, makePng(400, 210), 'image/png');
    const response = await app(store, access({ servable: false })).inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
    assert.equal(response.statusCode, 404);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
    assert.equal(response.headers['cache-control'], 'public, max-age=60');
    assert.equal(response.headers['content-type']?.includes('image/'), false);
  });

  test('a private collection\'s image reaches its signed-in reader only, never cached', async () => {
    const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(NOW));
    const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
    const owner = await issueTestSession({ factory, subject: 'lp-owner', displayName: 'Owner', handle: 'lpowner' });
    const outsider = await issueTestSession({ factory, subject: 'lp-outsider', displayName: 'Outsider', handle: 'lpoutside' });
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    await store.put(ID, png, 'image/png');
    const server = app(store, access({ servable: false, readers: [owner.subjectId] }), {
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
    });
    const url = `/api/v1/link-preview/${ID}`;

    const read = await server.inject({ method: 'GET', url, headers: { cookie: owner.cookie } });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.headers['cache-control'], 'private, no-store');
    assert.equal(read.headers.vary, 'Cookie');
    assert.deepEqual(read.rawPayload, png);

    for (const headers of [{ cookie: outsider.cookie }, { cookie: 'better-auth.session_token=forged' }]) {
      const denied = await server.inject({ method: 'GET', url, headers });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(denied.headers['cache-control'], 'private, no-store');
    }
    const anonymous = await server.inject({ method: 'GET', url });
    assert.equal(anonymous.statusCode, 404);
    assert.equal(anonymous.headers['cache-control'], 'public, max-age=60');
  });

  test('while the feature is off the route is not registered', async () => {
    const built = buildApiApp({ config });
    apps.push(built);
    const response = await built.inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
    assert.equal(response.statusCode, 404);
  });
});

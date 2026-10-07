/**
 * LP-04: anonymous GET /api/v1/link-preview/:previewId. Registered only with
 * a composed store. Bytes are returned only when the public-access check says
 * the object is still exposed, with a short revalidated cache. Illegal ids,
 * hidden objects, missing objects and non-images share one 404.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemoryObjectStore, makePng } from '../../support/link-preview-fixtures.js';
import { loadConfig } from '../../support/test-config.js';

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const servable = { isServable: async () => true };
const hidden = { isServable: async () => false };
const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/link_preview_route_test',
  PRODUCT_ORIGIN: 'https://app.example.test',
  ALLOWED_ORIGINS: 'https://app.example.test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
});

describe('GET /api/v1/link-preview/:previewId', () => {
  test('serves stored image bytes with a short revalidated cache and nosniff', async () => {
    const store = createMemoryObjectStore();
    const png = makePng(400, 210);
    await store.put(ID, png, 'text/html'); // declared type is ignored
    const app = buildApiApp({ config, linkPreviewStore: store, linkPreviewPublicAccess: servable });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['content-type'], 'image/png');
      assert.equal(response.headers['cache-control'], 'public, max-age=60, must-revalidate');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.deepEqual(response.rawPayload, png);
    } finally {
      await app.close();
    }
  });

  test('illegal ids, missing objects and non-servable bytes share one short-cached 404', async () => {
    const store = createMemoryObjectStore();
    const ico = Buffer.from('00000100010010100000010020006804000016000000', 'hex');
    await store.put('1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', Buffer.from('<html>hi</html>'), 'image/png');
    await store.put('2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', ico, 'image/x-icon');
    const app = buildApiApp({ config, linkPreviewStore: store, linkPreviewPublicAccess: servable });
    try {
      for (const id of [
        'not-a-uuid',
        '0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D',
        ID,
        '1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        '2a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      ]) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/link-preview/${id}` });
        assert.equal(response.statusCode, 404, id);
        assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
        assert.equal(response.headers['cache-control'], 'public, max-age=60', id);
      }
    } finally {
      await app.close();
    }
  });

  test('a stored image is 404 when no public bookmark still exposes it', async () => {
    const store = createMemoryObjectStore();
    await store.put(ID, makePng(400, 210), 'image/png');
    const app = buildApiApp({ config, linkPreviewStore: store, linkPreviewPublicAccess: hidden });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
      assert.equal(response.statusCode, 404);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
      assert.equal(response.headers['cache-control'], 'public, max-age=60');
      assert.equal(response.headers['content-type']?.includes('image/'), false);
    } finally {
      await app.close();
    }
  });

  test('without a public-access check the route fails closed', async () => {
    const store = createMemoryObjectStore();
    await store.put(ID, makePng(400, 210), 'image/png');
    const app = buildApiApp({ config, linkPreviewStore: store });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test('without a store (feature off) the route is not registered', async () => {
    const app = buildApiApp({ config });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/link-preview/${ID}` });
      assert.equal(response.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

/**
 * BF-02: public Fastify GET /api/v1/favicon/:id through the production R2 adapter.
 *
 * Mirrors tests/unit/identity/public-avatar-get-r2.test.ts: a fault HTTP server plus
 * buildApiApp + inject, so an oversized R2 object becomes HTTP 404
 * resource_not_found without draining a hold-open body. Favicon GET is
 * registered from bookmark-favicon-routes when faviconStore is provided and
 * must not depend on identityUnitOfWork.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createR2FaviconStore } from '../../../src/infrastructure/collections/index.js';
import { BOOKMARK_FAVICON_MAX_BYTES } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  startFaultServer,
  s3ErrorBody,
} from '../../support/phase4a-i06-fault-server.js';

const BUCKET = 'known-favicons-production';
const PREFIX = 'favicon/';
const FAVICON_ID = '123e4567-e89b-42d3-a456-426614174000';
const FAVICON_KEY = `${PREFIX}${FAVICON_ID}`;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);
const HTML = Buffer.from('<html><head><title>not an image</title></head><body>polluted</body></html>');

const FAVICON_PUBLIC_CACHE = 'public, max-age=30, must-revalidate';
const SHORT_PUBLIC_CACHE = 'public, max-age=60';
const PUBLIC_REVALIDATE = 'public, no-cache, must-revalidate';

const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/favicon_r2_http_test',
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

function resourceNotFoundCode(body: string): string {
  return (JSON.parse(body) as { error: { code: string } }).error.code;
}

function assertNoSetCookie(headers: Record<string, unknown>): void {
  assert.equal(headers['set-cookie'], undefined, 'favicon GET must not Set-Cookie');
}

function assertShortPublicMissingCache(cacheControl: unknown): void {
  assert.equal(cacheControl, SHORT_PUBLIC_CACHE);
  assert.notEqual(cacheControl, 'private, no-store');
  assert.notEqual(cacheControl, 'no-store');
  assert.notEqual(cacheControl, FAVICON_PUBLIC_CACHE);
  assert.notEqual(cacheControl, PUBLIC_REVALIDATE);
}

describe('BF-02 public favicon GET through the R2 adapter', () => {
  const apps: Array<ReturnType<typeof buildApiApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function buildApp(endpoint: string, accessible = true): ReturnType<typeof buildApiApp> {
    const app = buildApiApp({
      config,
      // This transport test uses an isolated R2 fault server and has no
      // database publication fixture. Inject the positive admission seam
      // explicitly; production wires the PostgreSQL implementation.
      faviconPublicAccess: { isPubliclyAccessible: async () => accessible },
      faviconStore: createR2FaviconStore({
        endpoint,
        region: 'auto',
        bucket: BUCKET,
        prefix: PREFIX,
        rwCredential: { accessKeyId: 'write-access-key-marker', secretAccessKey: 'write-secret-access-key-marker' },
        roCredential: { accessKeyId: 'read-access-key-marker', secretAccessKey: 'read-secret-access-key-marker' },
      }),
    });
    apps.push(app);
    return app;
  }

  test('withdrawn or retired object is denied before the object store is read', async () => {
    const fault = await startFaultServer(() => ({
      status: 500,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('must not be reached'),
    }));
    try {
      const app = buildApp(fault.url, false);
      const response = await app.inject({ method: 'GET', url: `/api/v1/favicon/${FAVICON_ID}` });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(fault.requests.length, 0, 'denied object must not trigger an R2 read');
    } finally {
      await fault.close();
    }
  });

  test('anonymous valid PNG GetObject is served on GET /api/v1/favicon/:id with short revalidation cache', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
          body: PNG,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const app = buildApp(fault.url);
      const response = await app.inject({ method: 'GET', url: `/api/v1/favicon/${FAVICON_ID}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['content-type'], 'image/png');
      assert.deepEqual(response.rawPayload, PNG);
      assert.equal(response.headers['cache-control'], FAVICON_PUBLIC_CACHE);
      assert.notEqual(response.headers['cache-control'], 'no-store');
      assert.notEqual(response.headers['cache-control'], PUBLIC_REVALIDATE);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assertNoSetCookie(response.headers);
      assert.ok(
        fault.requests.some((request) => request.method === 'GET' && request.path.includes(FAVICON_KEY)),
        'the public GET must reach the R2 transport for {prefix}{uuid}',
      );
    } finally {
      await fault.close();
    }
  });

  test('PNG bytes with a lying R2 Content-Type are still served as image/png', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': String(PNG.length) },
          body: PNG,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const app = buildApp(fault.url);
      const response = await app.inject({ method: 'GET', url: `/api/v1/favicon/${FAVICON_ID}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['content-type'], 'image/png');
      assert.deepEqual(response.rawPayload, PNG);
      assert.equal(response.headers['cache-control'], FAVICON_PUBLIC_CACHE);
      assertNoSetCookie(response.headers);
    } finally {
      await fault.close();
    }
  });

  test('declared Content-Length above BOOKMARK_FAVICON_MAX_BYTES is 404 without draining the body', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(BOOKMARK_FAVICON_MAX_BYTES + 1),
          },
          chunks: [{ data: Buffer.from('x') }],
          holdOpen: true,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const app = buildApp(fault.url);
      const response = await app.inject({ method: 'GET', url: `/api/v1/favicon/${FAVICON_ID}` });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(resourceNotFoundCode(response.body), 'resource_not_found');
      assertShortPublicMissingCache(response.headers['cache-control']);
      assertNoSetCookie(response.headers);
      const closed = await fault.waitForPrematureClose();
      assert.ok(closed >= 1, 'the unread R2 body must be destroyed so the holdOpen socket closes');
    } finally {
      await fault.close();
    }
  });

  test('illegal UUID and missing object share the same 404 resource_not_found shape', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? { status: 404, headers: {}, body: s3ErrorBody('NoSuchKey') }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const app = buildApp(fault.url);
      const illegalIds = ['not-a-uuid', 'abc', '123e4567-e89b-42d3-a456-42661417400'];
      const illegalResponses = [];
      for (const illegalId of illegalIds) {
        const response = await app.inject({ method: 'GET', url: `/api/v1/favicon/${illegalId}` });
        assert.equal(response.statusCode, 404, `${illegalId}: ${response.body}`);
        assert.equal(resourceNotFoundCode(response.body), 'resource_not_found');
        assertShortPublicMissingCache(response.headers['cache-control']);
        assertNoSetCookie(response.headers);
        illegalResponses.push(resourceNotFoundCode(response.body));
      }
      const missing = await app.inject({ method: 'GET', url: `/api/v1/favicon/${FAVICON_ID}` });
      assert.equal(missing.statusCode, 404, missing.body);
      assert.equal(resourceNotFoundCode(missing.body), 'resource_not_found');
      assertShortPublicMissingCache(missing.headers['cache-control']);
      assertNoSetCookie(missing.headers);
      for (const code of illegalResponses) {
        assert.equal(code, resourceNotFoundCode(missing.body));
      }
    } finally {
      await fault.close();
    }
  });

  test('polluted HTML body is 404 resource_not_found, not 200 HTML', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': String(HTML.length) },
          body: HTML,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const app = buildApp(fault.url);
      const response = await app.inject({ method: 'GET', url: `/api/v1/favicon/${FAVICON_ID}` });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal(resourceNotFoundCode(response.body), 'resource_not_found');
      assert.notEqual(response.headers['content-type'], 'text/html');
      assert.notEqual(response.statusCode, 200);
      assertShortPublicMissingCache(response.headers['cache-control']);
      assertNoSetCookie(response.headers);
    } finally {
      await fault.close();
    }
  });
});

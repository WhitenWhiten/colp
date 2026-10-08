/**
 * P-08: public Fastify GET /api/v1/avatar/:id through the production R2 adapter.
 *
 * Adapter-only tests already cap GetObject. This file wires that adapter into
 * buildApiApp so an oversized R2 object becomes HTTP 404 resource_not_found
 * without draining a hold-open body.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createR2AvatarStore } from '../../../src/infrastructure/identity/index.js';
import { AVATAR_MAX_BYTES } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  startFaultServer,
  s3ErrorBody,
} from '../../support/phase4a-i06-fault-server.js';
import {
  createIdentityMemoryState,
  createIdentityMemoryUnitOfWork,
} from '../../support/product-http-harness.js';

const BUCKET = 'known-avatars-production';
const PREFIX = 'avatar/';
const AVATAR_ID = '123e4567-e89b-42d3-a456-426614174000';
const AVATAR_KEY = `${PREFIX}${AVATAR_ID}`;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000182e403790000000049454e44ae426082',
  'hex',
);

const config = loadConfig({
  DATABASE_URL: 'postgres://localhost/avatar_r2_http_test',
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

describe('P-08 public avatar GET through the R2 adapter', () => {
  const apps: Array<ReturnType<typeof buildApiApp>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function buildApp(endpoint: string): ReturnType<typeof buildApiApp> {
    const app = buildApiApp({
      config,
      identityUnitOfWork: createIdentityMemoryUnitOfWork(
        createIdentityMemoryState(new Date('2026-08-19T00:00:00.000Z')),
      ),
      avatarStore: createR2AvatarStore({
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

  test('valid PNG GetObject is served on GET /api/v1/avatar/:id', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) },
          body: PNG,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const app = buildApp(fault.url);
      const response = await app.inject({ method: 'GET', url: `/api/v1/avatar/${AVATAR_ID}` });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['content-type'], 'image/png');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin');
      assert.deepEqual(response.rawPayload, PNG);
      assert.ok(
        fault.requests.some((request) => request.method === 'GET' && request.path.includes(AVATAR_KEY)),
        'the public GET must reach the R2 transport',
      );
    } finally {
      await fault.close();
    }
  });

  test('declared Content-Length above AVATAR_MAX_BYTES is 404 without draining the body', async () => {
    const fault = await startFaultServer((request) => (request.method === 'GET'
      ? {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(AVATAR_MAX_BYTES + 1),
          },
          chunks: [{ data: Buffer.from('x') }],
          holdOpen: true,
        }
      : { status: 403, headers: {}, body: s3ErrorBody('AccessDenied') }));
    try {
      const app = buildApp(fault.url);
      const response = await app.inject({ method: 'GET', url: `/api/v1/avatar/${AVATAR_ID}` });
      assert.equal(response.statusCode, 404, response.body);
      assert.equal((response.json() as { error: { code: string } }).error.code, 'resource_not_found');
      const closed = await fault.waitForPrematureClose();
      assert.ok(closed >= 1, 'the unread R2 body must be destroyed so the holdOpen socket closes');
    } finally {
      await fault.close();
    }
  });
});

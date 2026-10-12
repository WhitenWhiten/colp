/**
 * BF-03: independent CORS branch for the extension favicon helper.
 *
 * Must not fold into syncOrigin / collectionsOrigin (those Allow-Headers
 * lack Known-Command-Id). Existing sync collections GET preflight stays pinned.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { createProductOwnedCollectionsCursorSigner } from '../../../src/modules/collections/index.js';
import { ExtensionAuthError } from '../../../src/modules/identity/index.js';
import type { BookmarkFaviconObjectStore } from '../../../src/modules/collections/index.js';
import type { ExtensionCredentialEvidencePort } from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { EXTENSION_COLLECTIONS_PATH } from '../../../src/transport/colp-sync/extension-collection-routes.js';

const PRODUCT_ORIGIN = 'https://app.example.test';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const COLLECTION_ID = 'col-favicon-cors-1';
const NODE_ID = 'node-favicon-cors-1';
const HELPER_PATH = `/colp/v0.1/sync/collections/${COLLECTION_ID}/nodes/${NODE_ID}/favicon`;
const SYNC_COLLECTIONS_ALLOW_HEADERS =
  'Authorization, Content-Type, Cookie, Origin, Idempotency-Key, If-Match, Known-Sync-Session';

const NOW = new Date('2026-07-22T12:00:00.000Z');

function config() {
  return loadConfig({
    DATABASE_URL: 'postgres://localhost/known_test',
    PRODUCT_ORIGIN,
    ALLOWED_ORIGINS: PRODUCT_ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${PRODUCT_ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SYNC_EXTENSION_IDS: EXTENSION_ID,
  });
}

function denyVerifier(): ExtensionCredentialEvidencePort {
  return {
    async verify() {
      throw new ExtensionAuthError('invalid_token');
    },
  };
}

function emptyStore(): BookmarkFaviconObjectStore {
  return {
    async put() {},
    async get() { return null; },
    async delete() {},
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
});

function buildApp(): ReturnType<typeof buildApiApp> {
  const app = buildApiApp({
    config: config(),
    faviconStore: emptyStore(),
    extensionCollectionRoutes: {
      credentialVerifier: denyVerifier(),
      allowedOrigins: [EXTENSION_ORIGIN],
      ownedCollectionsQuery: {
        reads: { async listOwnedCollections() { return []; } },
        cursors: createProductOwnedCollectionsCursorSigner({
          current: { id: 'fav-cors-v1', key: 'favicon-cors-cursor-secret-material-32' },
        }),
        clock: { now: async () => NOW },
      },
    },
  });
  apps.push(app);
  return app;
}

function allowHeaders(value: unknown): string {
  return String(value ?? '');
}

describe('BF-03 bookmark favicon helper CORS branch', () => {
  test('helper OPTIONS 204 allows Known-Command-Id and does not use sync Allow-Headers', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: HELPER_PATH,
      headers: {
        origin: EXTENSION_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, known-command-id',
      },
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(response.headers['access-control-allow-origin'], EXTENSION_ORIGIN);
    const allowed = allowHeaders(response.headers['access-control-allow-headers']);
    assert.match(allowed, /Known-Command-Id/i);
    assert.notEqual(allowed, SYNC_COLLECTIONS_ALLOW_HEADERS);
    assert.doesNotMatch(allowed, /Idempotency-Key/i);
    const methods = String(response.headers['access-control-allow-methods'] ?? '');
    assert.match(methods, /POST/);
    assert.match(methods, /DELETE/);
    assert.match(methods, /OPTIONS/);
  });

  test('sync collections GET preflight Keep-Headers stay without Known-Command-Id', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: EXTENSION_COLLECTIONS_PATH,
      headers: {
        origin: EXTENSION_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(
      allowHeaders(response.headers['access-control-allow-headers']),
      SYNC_COLLECTIONS_ALLOW_HEADERS,
    );
    assert.doesNotMatch(
      allowHeaders(response.headers['access-control-allow-headers']),
      /Known-Command-Id/i,
    );
  });

  test('Web Origin on the helper path keeps Product Allow-Methods, not the helper-only set', async () => {
    const app = buildApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: HELPER_PATH,
      headers: {
        origin: PRODUCT_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, known-command-id',
      },
    });
    assert.equal(response.statusCode, 204, response.body);
    const methods = String(response.headers['access-control-allow-methods'] ?? '');
    assert.match(methods, /PATCH/);
    assert.notEqual(methods, 'POST, DELETE, OPTIONS');
  });
});

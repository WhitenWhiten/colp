import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { assertProductErrorEnvelope } from '../../support/product-http-harness.js';

/**
 * FIX-L-004: a malformed URL (invalid percent-encoding in the PATH) on ANY
 * /api/v1/** path must produce the SAME fixed invalid_request Product
 * envelope with request id, no-store and the full security header set, and
 * must never echo the raw (possibly undecodable) path. Collection/node paths
 * previously fell into Fastify's default JSON shape that reflected the
 * encoded path and lacked request id, no-store and security headers.
 * SEC-T-07: COLP / MCP / other surfaces keep the Fastify-shaped envelope
 * (error / code / message / statusCode) but use a fixed FST_ERR_BAD_URL
 * message and the same applySecurityHeaders + no-store baseline.
 */

function testEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'test',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

function productionEnv(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://localhost/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    PUBLICATION_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
    PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
    PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
    FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
    FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
    FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
    NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
    NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    LOG_LEVEL: 'silent',
    TRUSTED_INGRESS: '',
    ...overrides,
  };
}

const apps: Array<ReturnType<typeof buildApiApp>> = [];
afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app?.close();
  }
});

/** The header set every Product bad-URL response must carry (mirrors applySecurityHeaders). */
function assertBadUrlHeaders(
  response: { headers: Record<string, string | string[] | undefined> },
): void {
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(String(response.headers['permissions-policy'] ?? ''), /camera=\(\)/u);
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-site');
  assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
  assert.match(String(response.headers['content-security-policy'] ?? ''), /default-src 'none'/u);
}

describe('FIX-L-004 unified malformed-URL envelope on /api/v1/**', () => {
  test('collection/node bad URLs return the fixed invalid_request envelope with request id, no-store and all security headers', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()) });
    apps.push(app);
    for (const url of [
      '/api/v1/collections/%ZZ',
      '/api/v1/collections/col-1/nodes/%ZZ',
      '/api/v1/collections/col-1/nodes/node-1/children/%ZZ',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      const error = assertProductErrorEnvelope(response, 400, 'invalid_request');
      assert.equal(error.message, 'The request URL is invalid.', url);
      assert.equal(error.recovery, 'user_action', url);
      assert.equal(error.sameRequestRetrySafe, false, url);
      assert.equal(error.precondition, null, url);
      assert.equal(error.currentEtag, null, url);
      assert.equal(error.retryAfterSeconds, null, url);
      assert.deepEqual(error.fieldErrors, [], url);
      // The malformed URL must never be reflected into the body.
      assert.equal(response.body.includes(url), false, url);
      assert.equal(response.body.includes('%ZZ'), false, url);
      assert.equal(response.body.includes('/api/v1'), false, url);
      assertBadUrlHeaders(response);
      // Test mode does not emit HSTS.
      assert.equal(response.headers['strict-transport-security'], undefined, url);
    }
  });

  test('every /api/v1 surface shares the same fixed invalid_request envelope', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()) });
    apps.push(app);
    for (const url of [
      '/api/v1/profiles/%ZZ',
      '/api/v1/search/%ZZ',
      '/api/v1/me/%ZZ',
      '/api/v1/session/%ZZ',
      '/api/v1/attachments/%ZZ',
      '/api/v1/mcp/approvals/%ZZ',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      const error = assertProductErrorEnvelope(response, 400, 'invalid_request');
      assert.equal(error.message, 'The request URL is invalid.', url);
      assert.equal(response.body.includes(url), false, url);
      assertBadUrlHeaders(response);
    }
  });

  test('production bad-URL responses include HSTS', async () => {
    const app = buildApiApp({ config: loadConfig(productionEnv()) });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/collections/col-1/nodes/%ZZ' });
    const error = assertProductErrorEnvelope(response, 400, 'invalid_request');
    assert.equal(error.message, 'The request URL is invalid.');
    assertBadUrlHeaders(response);
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  });

  test('non-Product/MCP/Sync surfaces keep a fixed FST_ERR_BAD_URL envelope without reflecting the path', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()) });
    apps.push(app);
    for (const url of [
      '/colp/v0.1/collections/col-1/snapshot/%ZZ',
      '/.well-known/collection-protocol/%ZZ',
      '/.well-known/oauth-protected-resource/%ZZ',
      '/collections/-/mcp/%ZZ',
      '/private/snapshot/%ZZ',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 400, url);
      const body = response.json() as {
        error: unknown;
        code: unknown;
        message: unknown;
        statusCode: unknown;
      };
      assert.equal(body.error, 'Bad Request', url);
      assert.equal(body.code, 'FST_ERR_BAD_URL', url);
      assert.equal(body.message, 'The request URL is not a valid url component', url);
      assert.equal(body.statusCode, 400, url);
      assert.equal(response.body.includes(url), false, url);
      assert.equal(response.body.includes('%ZZ'), false, url);
      assertBadUrlHeaders(response);
      assert.equal(response.headers['strict-transport-security'], undefined, url);
    }
  });

  test('production non-Product bad-URL responses include HSTS', async () => {
    const app = buildApiApp({ config: loadConfig(productionEnv()) });
    apps.push(app);
    const url = '/colp/v0.1/collections/col-1/snapshot/%ZZ';
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'FST_ERR_BAD_URL');
    assert.equal(response.json().message, 'The request URL is not a valid url component');
    assert.equal(response.body.includes(url), false);
    assert.equal(response.body.includes('%ZZ'), false);
    assertBadUrlHeaders(response);
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  });

  test('ordinary unknown /api/v1 paths keep the standard 404 Product envelope', async () => {
    const app = buildApiApp({ config: loadConfig(testEnv()) });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    assertProductErrorEnvelope(response, 404, 'resource_not_found');
  });
});

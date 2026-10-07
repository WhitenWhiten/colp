/**
 * Task E1/F1: LEGACY ISOLATION NEGATIVE TEST SET (plan §11 E1 step 5, §12 F1).
 *
 * This suite is the allowlisted legacy exception: it is the ONLY active test
 * that exercises the gated `/__test__/oidc/authorize` route and the
 * `known_test.*` code minting, and it proves the legacy surface stays closed
 * outside explicit NODE_ENV=test + OIDC_ALLOW_TEST_PROVIDER mode AND absent
 * under Better Auth mode. All other active tests mint sessions through
 * `tests/support/better-auth-test-factory.ts` and never reuse this seam.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';

const testEnvironment = {
  DATABASE_URL: 'postgres://localhost/known_test',
  NODE_ENV: 'test',
  PRODUCT_ORIGIN: 'http://localhost:5190',
  OIDC_ISSUER: 'http://localhost:3310/__test__/oidc',
  OIDC_CLIENT_ID: 'known-web-real-stack',
  OIDC_AUDIENCE: 'known-web-real-stack',
  OIDC_REDIRECT_URI: 'http://localhost:5190/api/v1/auth/oidc/callback',
  OIDC_AUTHORIZATION_ENDPOINT: 'http://localhost:3310/__test__/oidc/authorize',
  OIDC_TOKEN_ENDPOINT: 'http://localhost:3310/__test__/oidc/token',
  // Public client + PKCE (no secret): explicit mode must stay legal.
  OIDC_CLIENT_AUTH_MODE: 'none',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
} as const;

test('browser test identity seam is refused outside explicit test-provider mode', () => {
  assert.throws(
    () => loadConfig({
      ...testEnvironment,
      NODE_ENV: 'production',
      PRODUCT_ORIGIN: 'https://app.example.test',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
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
      KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
    }),
    /OIDC_ALLOW_TEST_PROVIDER must not be enabled in production/,
  );
  assert.throws(
    () => loadConfig({
      ...testEnvironment,
      NODE_ENV: 'development',
      KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
    }),
    /OIDC_ALLOW_TEST_PROVIDER requires NODE_ENV=test/,
  );
  assert.throws(
    () => loadConfig({
      ...testEnvironment,
      OIDC_ALLOW_TEST_PROVIDER: 'false',
      KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
    }),
    /requires NODE_ENV=test and OIDC_ALLOW_TEST_PROVIDER=true/,
  );
});

test('test-provider mode without an explicit HMAC secret is refused even under NODE_ENV=test', () => {
  const { OIDC_TEST_PROVIDER_HMAC_SECRET: _omitted, ...withoutSecret } = testEnvironment;
  assert.throws(
    () => loadConfig({
      ...withoutSecret,
      KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
    }),
    /OIDC_TEST_PROVIDER_HMAC_SECRET is required when OIDC_ALLOW_TEST_PROVIDER=true/,
  );
});

test('explicit test authorize route mints a callback code without exposing identity input', async () => {
  const config = loadConfig({
    ...testEnvironment,
    KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
  });
  const app = buildApiApp({ config });

  const response = await app.inject({
    method: 'GET',
    url: '/__test__/oidc/authorize',
    query: {
      response_type: 'code',
      client_id: config.oidc.clientId,
      redirect_uri: config.oidc.redirectUri,
      state: 'opaque-state',
      nonce: 'opaque-nonce',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    },
  });

  assert.equal(response.statusCode, 302);
  const callback = new URL(response.headers.location!);
  assert.equal(callback.origin + callback.pathname, config.oidc.redirectUri);
  assert.equal(callback.searchParams.get('state'), 'opaque-state');
  assert.match(callback.searchParams.get('code') ?? '', /^known_test\./);
  assert.equal(callback.searchParams.has('subject'), false);
  assert.equal(config.oidc.clientAuthMode, 'none');
  assert.equal(config.oidc.clientSecret, '');
  await app.close();
});

test('Better Auth mode registers zero legacy test-OIDC surface: the authorize route is absent (404)', async () => {
  // Legacy isolation negative (plan §11 E1 / §12 F1-F2): with
  // BETTER_AUTH_ENABLED=true the in-process test OIDC authorize route must
  // not exist at all — active tests never mint `known_test.*` codes through
  // the legacy chain (E1 factory replaces the seam).
  const config = loadConfig({
    ...testEnvironment,
    KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
  });
  const app = buildApiApp({ config });
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/__test__/oidc/authorize',
      query: {
        response_type: 'code',
        client_id: config.oidc.clientId,
        redirect_uri: config.oidc.redirectUri,
        state: 'opaque-state',
        nonce: 'opaque-nonce',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      },
    });
    assert.equal(response.statusCode, 404, 'the legacy test-OIDC authorize route must be absent in Better Auth mode');
    assert.equal(response.body.includes('known_test.'), false);
  } finally {
    await app.close();
  }
});

/**
 * Better Auth routes over the real Better Auth handler, Fastify bridge and
 * PostgreSQL fixture. Static manifest/error/product-route contracts remain in
 * better-auth-routes.test.ts.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { loadConfig } from '../../support/test-config.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  buildBetterAuthOptions,
  createBetterAuthRuntime,
  mountBetterAuthAllowlist,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { authManifestEntryFor } from '../../../src/transport/auth/auth-route-manifest.js';
import {
  openBetterAuthPostgres,
  type BetterAuthPostgresFixture,
} from '../../support/better-auth-postgres.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';

function enabledEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef1',
    BETTER_AUTH_BODY_LIMIT_BYTES: '1024',
    ...overrides,
  };
}

describe('Better Auth routes over the real handler + real bridge + real PostgreSQL', () => {
  let fixture: BetterAuthPostgresFixture;
  let app: ReturnType<typeof buildApiApp>;
  let builtConfig: NonNullable<ReturnType<typeof buildBetterAuthConfig>>;

  beforeAll(async () => {
    const config = loadConfig(enabledEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');
    builtConfig = built;
    fixture = await openBetterAuthPostgres(built);
    // C3: the OAuth start/callback paths only EXIST on the real BA handler
    // when at least one provider plugin is installed (no provider => the BA
    // handler itself 404s the mounted paths). The fixture therefore carries a
    // controlled genericOAuth provider (placeholder endpoints that are never
    // contacted: the C3 assertions below only exercise the unknown-provider
    // fail-closed shape).
    const options = buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: fixture.db, type: 'postgres', transaction: true },
    });
    options.plugins = [...(options.plugins ?? []), genericOAuth({
      config: [{
        providerId: 'google',
        clientId: 'unit-test-google-client-id',
        clientSecret: 'unit-test-google-client-secret', // secret-scan: allow 'unit-test-google-client-secret'
        authorizationUrl: 'https://mock-oauth.invalid/authorize',
        tokenUrl: 'https://mock-oauth.invalid/token',
        userInfoUrl: 'https://mock-oauth.invalid/userinfo',
        scopes: ['email'],
        pkce: true,
      }],
    })];
    const auth = betterAuth(options);
    const runtime = {
      mount: (fastifyApp: Parameters<typeof mountBetterAuthAllowlist>[0]) =>
        mountBetterAuthAllowlist(fastifyApp, auth, built),
    };
    // No identity unit of work: the legacy OIDC routes are absent here, so
    // /api/v1/auth/oidc/* 404s (the BA surface never owns them).
    app = buildApiApp({ config, betterAuthRuntime: runtime });
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await fixture?.close();
  });

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `${BASE_PATH}${path}`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, ...headers },
      payload: JSON.stringify(body),
    });
  }

  function uniqueEmail(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  }

  async function markEmailVerified(email: string): Promise<void> {
    const result = await fixture.adminPool.query(
      `UPDATE "${fixture.schemaName}"."auth_users" SET "emailVerified" = true WHERE email = $1`,
      [email],
    );
    assert.equal(result.rowCount, 1, `must mark ${email} verified`);
  }

  test('unknown auth path returns the stable 404 product envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/not-a-route' });
    assert.equal(res.statusCode, 404);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'resource_not_found');
  });

  test('wrong method on an allowlisted path returns 405 with Allow', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/v1/auth/sign-out' });
    assert.equal(res.statusCode, 405);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'method_not_allowed');
    assert.match(String(res.headers.allow ?? ''), /POST/u);
  });

  test('legacy OIDC endpoints are never part of the BA surface (404)', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(start.statusCode, 404);
    const callback = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/callback' });
    assert.equal(callback.statusCode, 404);
    // The manifest marks them legacy-scope only (F3 removes the family).
    const startEntry = authManifestEntryFor('GET', '/api/v1/auth/oidc/start');
    assert.equal(startEntry?.scope, 'legacy-oidc');
  });

  test('pending MFA endpoints are enumerated in the manifest but NOT registered (404)', async () => {
    const pendingRequests: ReadonlyArray<{ readonly method: string; readonly url: string }> = [
      { method: 'POST', url: '/api/v1/auth/two-factor/enable' },
      { method: 'POST', url: '/api/v1/auth/two-factor/verify-totp' },
      { method: 'POST', url: '/api/v1/auth/two-factor/verify-backup-code' },
      { method: 'POST', url: '/api/v1/auth/two-factor/send-otp' },
    ];
    for (const item of pendingRequests) {
      const res = await app.inject({
        method: item.method as 'GET' | 'POST',
        url: item.url,
        headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
        payload: JSON.stringify({}),
      });
      assert.equal(res.statusCode, 404, `${item.method} ${item.url} must not be registered (pending)`);
      assert.equal((res.json() as { error: { code: string } }).error.code, 'resource_not_found');
    }
  });

  test('C2/A4: the email surface is mounted (reset/verification/OTP paths reach the BA handler, never the app router)', async () => {
    // The core reset path exists on the BA handler without the emailOTP
    // plugin: a body-less request fails BA validation, translated to the
    // stable product envelope (never the app-router 404).
    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/request-password-reset',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({}),
    });
    assert.notEqual(reset.statusCode, 404, 'the reset request must be mounted');
    assert.equal((reset.json() as { error: { code: string } }).error.code, 'invalid_request');
    // The verification GET is mounted (BA 1.7.1: GET, token in query): a
    // malformed token answers the BA handler fail-closed, never a 404.
    const verify = await app.inject({ method: 'GET', url: '/api/v1/auth/verify-email?token=not-a-real-token' });
    assert.notEqual(verify.statusCode, 404, 'the verify-email route must be mounted');
    const verifyBody = verify.json() as { error?: { code?: string } };
    assert.equal(verify.statusCode, 400);
    assert.equal(verifyBody.error?.code, 'invalid_request');
    // emailOTP plugin paths are mounted even when the plugin is not wired:
    // the bridge forwards and BA answers its own 404 (empty body), NOT the
    // stable product envelope — the allowlisted surface stays uniform and
    // fail-closed (same contract as the unplugged genericOAuth chain).
    const otp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-otp/send-verification-otp',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({}),
    });
    assert.equal(otp.statusCode, 404);
    assert.equal((otp.body ?? '').includes('resource_not_found'), false, 'the BA-level 404 must not be the product envelope');
  });

  test('C3: the OAuth start/callback are REGISTERED now (no 404; provider-less requests fail closed)', async () => {
    // Better Auth 1.7 folds genericOAuth onto the social-provider path
    // (`/sign-in/social` + `/callback/:id`). The start is mounted: an
    // unknown provider is a fail-closed 400 (stable envelope), never a 404.
    const start = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/social',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ provider: 'unknown-provider', callbackURL: '/dashboard' }),
    });
    assert.notEqual(start.statusCode, 404, 'the OAuth start must be registered');
    assert.equal((start.json() as { error: { code: string } }).error.code, 'invalid_request');
    // The callback is registered; a code-less/state-less callback follows
    // BA's fail-closed redirect contract — the redirect stays on the
    // Know-N origin (never a 404, never an open redirect).
    const callback = await app.inject({ method: 'GET', url: '/api/v1/auth/callback/unknown-provider' });
    assert.notEqual(callback.statusCode, 404, 'the OAuth callback must be registered');
    assert.equal(callback.statusCode, 302, 'a state-less callback redirects to the product error page');
    const callbackLocation = String(callback.headers.location ?? '');
    assert.ok(
      callbackLocation.startsWith(`${TRUSTED_ORIGIN}/`) || callbackLocation.startsWith('/'),
      `the error redirect must stay on the Know-N origin: ${callbackLocation}`,
    );
    // The explicit link endpoint is a product route now: without the product
    // composition it stays absent (this suite builds no identity unit of work).
    const link = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth2/link',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ providerId: 'google', callbackURL: '/settings' }),
    });
    assert.equal(link.statusCode, 404, 'the product link route needs the browser-auth composition');
    assert.equal((link.json() as { error: { code: string } }).error.code, 'resource_not_found');
  });

  test('a real sign-up returns NO session cookie and NO raw token in the body (R9)', async () => {
    const email = uniqueEmail('signup');
    const res = await post('/sign-up/email', { name: 'A4 User', email, password: 'password-123' }); // secret-scan: allow 'password-123'
    assert.equal(res.statusCode, 200);
    const body = res.json() as { token?: unknown; user?: { email?: string } };
    assert.equal('token' in body, false, 'R9: the raw session token must be stripped from sign-up');
    assert.equal(body.user?.email, email);
    const rawCookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
    const sessionEntry = rawCookies.find((cookie) => cookie?.startsWith('__Host-known_session='));
    assert.equal(sessionEntry, undefined, 'P1: password sign-up must not set the session cookie');
  });

  test('unverified password sign-in is verification_required', async () => {
    const email = uniqueEmail('unverified');
    const signUp = await post('/sign-up/email', { name: 'A4 Unverified', email, password: 'password-123' }); // secret-scan: allow 'password-123'
    assert.equal(signUp.statusCode, 200);
    const signIn = await post('/sign-in/email', { email, password: 'password-123' }); // secret-scan: allow 'password-123'
    assert.equal(signIn.statusCode, 403);
    assert.equal((signIn.json() as { error: { code: string } }).error.code, 'verification_required');
  });

  test('sign-in works and get-session strips the nested session token (R9)', async () => {
    const email = uniqueEmail('signin');
    const signUp = await post('/sign-up/email', { name: 'A4 Signin', email, password: 'password-123' }); // secret-scan: allow 'password-123'
    assert.equal(signUp.statusCode, 200);
    await markEmailVerified(email);

    const signIn = await post('/sign-in/email', { email, password: 'password-123' }); // secret-scan: allow 'password-123'
    assert.equal(signIn.statusCode, 200);
    const signInBody = signIn.json() as { token?: unknown };
    assert.equal('token' in signInBody, false, 'R9: sign-in must not expose the raw token');
    const rawCookies = Array.isArray(signIn.headers['set-cookie']) ? signIn.headers['set-cookie'] : [signIn.headers['set-cookie']];
    const cookie = rawCookies.find((entry) => entry?.startsWith('__Host-known_session='))?.split(';', 1)[0];
    assert.ok(cookie, 'verified sign-in must set the session cookie');

    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/get-session?disableRefresh=true',
      headers: { cookie },
    });
    assert.equal(session.statusCode, 200);
    const sessionBody = session.json() as {
      session?: { token?: unknown; id?: string };
      user?: { email?: string };
    };
    assert.equal(sessionBody.user?.email, email);
    assert.ok(sessionBody.session?.id);
    assert.equal('token' in (sessionBody.session ?? {}), false, 'R9: get-session must not expose session.token');
  });

  test('get-session without a cookie stays the BA null shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/get-session' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'null');
  });

  test('wrong password and unknown email return byte-identical 401 invalid_credentials envelopes', async () => {
    const email = uniqueEmail('enum');
    const signUp = await post('/sign-up/email', { name: 'A4 Enum', email, password: 'password-123' }); // secret-scan: allow 'password-123'
    assert.equal(signUp.statusCode, 200);

    const wrongPassword = await post('/sign-in/email', { email, password: 'wrong-password-1' }); // secret-scan: allow 'wrong-password-1'
    const unknownEmail = await post('/sign-in/email', { email: uniqueEmail('nobody'), password: 'password-123' }); // secret-scan: allow 'password-123'
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownEmail.statusCode, 401);

    const wrongBody = wrongPassword.json() as { error: { code: string; message: string; requestId: string } };
    const unknownBody = unknownEmail.json() as { error: { code: string; message: string; requestId: string } };
    assert.equal(wrongBody.error.code, 'invalid_credentials');
    assert.equal(unknownBody.error.code, 'invalid_credentials');
    // No enumeration: identical envelope modulo the request id.
    assert.equal(wrongBody.error.message, unknownBody.error.message);
    assert.equal(wrongBody.error.message.includes(email), false, 'the email must never be echoed');
    assert.equal(wrongBody.error.message.includes('Invalid email or password'), false, 'the BA message must never be echoed');
    const { requestId: wrongRequestId, ...wrongRest } = wrongBody.error;
    const { requestId: unknownRequestId, ...unknownRest } = unknownBody.error;
    void wrongRequestId;
    void unknownRequestId;
    assert.deepEqual(wrongRest, unknownRest);
  });

  test('POST without Origin fails the Know-N check before the BA handler (csrf_failed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'nobody@example.test', password: 'password-123' }), // secret-scan: allow 'password-123'
    });
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'csrf_failed');
  });

  test('POST with a non-trusted Origin fails closed (csrf_failed)', async () => {
    const res = await post('/sign-in/email', { email: 'nobody@example.test', password: 'password-123' }, // secret-scan: allow 'password-123'
      { origin: 'https://evil.example' });
    assert.equal(res.statusCode, 403);
    assert.equal((res.json() as { error: { code: string } }).error.code, 'csrf_failed');
  });

  test('BA endpoints are inside the auth rate-limit surface with the C4 sign-in family', async () => {
    const config = loadConfig(enabledEnv({ AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_WINDOW_MS: '60000' }));
    const runtime = createBetterAuthRuntime({
      enabled: true,
      config: builtConfig,
      database: { db: fixture.db, type: 'postgres', transaction: true },
    });
    assert.ok(runtime);
    const rateApp = buildApiApp({ config, betterAuthRuntime: runtime });
    try {
      const first = await rateApp.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in/email',
        headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
        payload: JSON.stringify({ email: 'nobody@example.test', password: 'password-123' }), // secret-scan: allow 'password-123'
      });
      const second = await rateApp.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in/email',
        headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
        payload: JSON.stringify({ email: 'nobody@example.test', password: 'password-123' }), // secret-scan: allow 'password-123'
      });
      const third = await rateApp.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in/email',
        headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
        payload: JSON.stringify({ email: 'nobody@example.test', password: 'password-123' }), // secret-scan: allow 'password-123'
      });
      assert.equal(first.statusCode, 401, 'unauthenticated sign-in is an auth failure, not a rate-limit denial');
      assert.equal(second.statusCode, 401);
      assert.equal(third.statusCode, 429);
      assert.equal((third.json() as { error: { code: string } }).error.code, 'rate_limited');
      assert.equal(third.headers['ratelimit-policy'], 'auth:sign-in:2:60000');
      assert.ok(third.headers['retry-after']);
    } finally {
      await rateApp.close().catch(() => undefined);
    }
  });

  test('POST /oauth2/register uses oauth-register independently of oauth-authorize', async () => {
    const config = loadConfig(enabledEnv({ AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_WINDOW_MS: '60000' }));
    const registerPayload = JSON.stringify({
      client_name: 't3-register',
      redirect_uris: ['http://127.0.0.1/callback'],
    });
    const registerHeaders = { 'content-type': 'application/json', origin: TRUSTED_ORIGIN };

    const registerRuntime = createBetterAuthRuntime({
      enabled: true,
      config: builtConfig,
      database: { db: fixture.db, type: 'postgres', transaction: true },
    });
    assert.ok(registerRuntime);
    const registerApp = buildApiApp({ config, betterAuthRuntime: registerRuntime });
    try {
      const first = await registerApp.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth2/register',
        headers: registerHeaders,
        payload: registerPayload,
      });
      const second = await registerApp.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth2/register',
        headers: registerHeaders,
        payload: registerPayload,
      });
      const third = await registerApp.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth2/register',
        headers: registerHeaders,
        payload: registerPayload,
      });
      assert.notEqual(first.statusCode, 429);
      assert.notEqual(second.statusCode, 429);
      assert.equal(third.statusCode, 429);
      assert.equal((third.json() as { error: { code: string } }).error.code, 'rate_limited');
      assert.match(String(third.headers['ratelimit-policy'] ?? ''), /^auth:oauth-register:/u);
      assert.equal(third.headers['ratelimit-policy'], 'auth:oauth-register:2:60000');
      assert.ok(third.headers['retry-after']);
      const authorize = await registerApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
      assert.notEqual(authorize.statusCode, 429, 'authorize must not share the oauth-register bucket');
      let authorizeCode: string | undefined;
      try {
        authorizeCode = (authorize.json() as { error?: { code?: string } }).error?.code;
      } catch {
        authorizeCode = undefined;
      }
      assert.notEqual(authorizeCode, 'rate_limited');
    } finally {
      await registerApp.close().catch(() => undefined);
    }

    const authorizeRuntime = createBetterAuthRuntime({
      enabled: true,
      config: builtConfig,
      database: { db: fixture.db, type: 'postgres', transaction: true },
    });
    assert.ok(authorizeRuntime);
    const authorizeApp = buildApiApp({ config, betterAuthRuntime: authorizeRuntime });
    try {
      const first = await authorizeApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
      const second = await authorizeApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
      const third = await authorizeApp.inject({ method: 'GET', url: '/api/v1/auth/oauth2/authorize' });
      assert.notEqual(first.statusCode, 429);
      assert.notEqual(second.statusCode, 429);
      assert.equal(third.statusCode, 429);
      assert.equal((third.json() as { error: { code: string } }).error.code, 'rate_limited');
      assert.equal(third.headers['ratelimit-policy'], 'auth:oauth-authorize:2:60000');
      const register = await authorizeApp.inject({
        method: 'POST',
        url: '/api/v1/auth/oauth2/register',
        headers: registerHeaders,
        payload: registerPayload,
      });
      assert.notEqual(register.statusCode, 429, 'DCR register must not share the oauth-authorize bucket');
      const registerCode = (register.json() as { error?: { code?: string } }).error?.code;
      assert.notEqual(registerCode, 'rate_limited');
    } finally {
      await authorizeApp.close().catch(() => undefined);
    }
  });
});

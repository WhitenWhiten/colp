import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { loadConfig } from '../../support/test-config.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import {
  BETTER_AUTH_ALLOWLIST,
  buildBetterAuthOptions,
  createBetterAuthRuntime,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  openBetterAuthPostgres,
  type BetterAuthPostgresFixture,
} from '../../support/better-auth-postgres.js';
import { TEST_SESSION_TOKEN_PROTECTION } from '../../support/better-auth-session-token-protection.js';

/**
 * Task A1 composition contract:
 * - disabled mode: ZERO Better Auth registration — buildApiApp answers 404 on
 *   every /api/v1/auth path, the Better Auth constructor is never called and
 *   no fetch traffic is produced (spy evidence);
 * - enabled mode: ONLY the G1 §10 allowlist is mounted — unknown paths 404,
 *   wrong methods 405, legacy OIDC endpoints stay absent, and the REAL
 *   schema-backed handler serves a sign-up through the composed app.
 *
 * The better-auth module is mocked with a call-through spy ONLY to observe
 * constructor invocation; all handler evidence still comes from the real
 * implementation (the spy delegates to it).
 */

const TRUSTED_ORIGIN = 'https://app.example.test';

vi.mock('better-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('better-auth')>();
  return { ...actual, betterAuth: vi.fn(actual.betterAuth) };
});

const betterAuthSpy = vi.mocked(betterAuth);

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

function disabledEnv(): Record<string, string> {
  const base = enabledEnv();
  delete base.BETTER_AUTH_ENABLED;
  delete base.BETTER_AUTH_SECRET;
  delete base.BETTER_AUTH_BODY_LIMIT_BYTES;
  return base;
}

/** Better Auth settings value for disabled-mode runtime probes (never used). */
function inertRuntimeConfig(): BetterAuthRuntimeConfig {
  return {
    baseURL: TRUSTED_ORIGIN,
    basePath: '/api/v1/auth',
    secret: 'test-better-auth-secret-0123456789abcdef1', // secret-scan: allow 'test-better-auth-secret-0123456789abcdef1'
    sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
    trustedOrigins: [TRUSTED_ORIGIN],
    cookieName: '__Host-known_session',
    sessionExpiresInSeconds: 86_400,
    sessionUpdateAgeSeconds: 60,
    bodyLimitBytes: 1024,
    emailOtp: null,
    social: null,
    passwordHash: {
      hash: async () => 'unused-hash',
      verify: async () => false,
    },
  };
}

/** Lazy Kysely that is never connected (disabled mode never constructs). */
function inertDatabase(): Kysely<Record<string, never>> {
  return new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: 'postgres://unused.invalid/never' }),
    }),
  });
}

describe('disabled mode (BETTER_AUTH_ENABLED=false): zero registration, zero construction', () => {
  test('createBetterAuthRuntime returns null without calling the Better Auth constructor', () => {
    betterAuthSpy.mockClear();
    const runtime = createBetterAuthRuntime({
      enabled: false,
      config: inertRuntimeConfig(),
      database: { db: inertDatabase(), type: 'postgres', transaction: true },
    });
    assert.equal(runtime, null);
    assert.equal(betterAuthSpy.mock.calls.length, 0);
  });

  test('buildApiApp registers zero Better Auth routes (404 on every auth path)', async () => {
    betterAuthSpy.mockClear();
    const config = loadConfig(disabledEnv());
    const app = buildApiApp({ config });
    const getSession = await app.inject({ method: 'GET', url: '/api/v1/auth/get-session' });
    assert.equal(getSession.statusCode, 404);
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email: 'nobody@example.test', password: 'nope' }),
    });
    assert.equal(signIn.statusCode, 404);
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'X', email: 'x@example.test', password: 'password-1' }), // secret-scan: allow 'password-1'
    });
    assert.equal(signUp.statusCode, 404);
    assert.equal(betterAuthSpy.mock.calls.length, 0);
    await app.close();
  });

  test('disabled mode produces no fetch traffic', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const config = loadConfig(disabledEnv());
      const app = buildApiApp({ config });
      await app.inject({ method: 'GET', url: '/api/v1/auth/get-session' });
      await app.inject({ method: 'GET', url: '/health' });
      assert.equal(fetchSpy.mock.calls.length, 0);
      await app.close();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('enabled mode: allowlist-only mounting with the real handler', () => {
  let fixture: BetterAuthPostgresFixture;
  let app: ReturnType<typeof buildApiApp>;

  beforeAll(async () => {
    const config = loadConfig(enabledEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');
    fixture = await openBetterAuthPostgres(built);
    const runtime = createBetterAuthRuntime({
      enabled: true,
      config: built,
      database: { db: fixture.db, type: 'postgres', transaction: true },
    });
    assert.ok(runtime, 'enabled runtime must construct');
    app = buildApiApp({ config, betterAuthRuntime: runtime });
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await fixture?.close();
  });

  test('enabling constructs the Better Auth instance exactly once (the beforeAll runtime)', () => {
    assert.equal(betterAuthSpy.mock.calls.length, 1);
  });

  test('the allowlist matches the G1 §10 confirmed endpoints + C3 OAuth chain + C2 email surface', () => {
    assert.deepEqual(
      BETTER_AUTH_ALLOWLIST.map((entry) => `${entry.method} ${entry.path}`),
      [
        'POST /sign-up/email',
        'POST /sign-in/email',
        'GET /get-session',
        'POST /sign-out',
        'POST /revoke-session',
        'POST /change-password',
        // C3: the OAuth authorization-code chains (start + callback) are
        // mounted — the built-in social chain (production google/github) plus
        // the genericOAuth chain (controlled test providers); the explicit
        // link endpoint moved to the product route surface.
        'POST /sign-in/social',
        'GET /callback/:providerId',
        'POST /sign-in/oauth2',
        'GET /oauth2/callback/:providerId',
        // C2/A4: the email surface (password reset + verification + emailOTP
        // plugin) is mounted on the real BA 1.6.29 paths; /verify-email is
        // GET (token in query).
        'POST /reset-password',
        'POST /request-password-reset',
        'GET /verify-email',
        'POST /send-verification-email',
        'POST /sign-in/email-otp',
        'POST /email-otp/send-verification-otp',
        'POST /email-otp/check-verification-otp',
        'POST /email-otp/verify-email',
        'POST /email-otp/request-password-reset',
        'POST /email-otp/reset-password',
        'POST /forget-password/email-otp',
        'POST /email-otp/request-email-change',
        'POST /email-otp/change-email',
        // T-04 built-in issuer (mounted only when BETTER_AUTH_OAUTH_ISSUER_ENABLED).
        'GET /oauth2/authorize',
        'POST /oauth2/authorize',
        'POST /oauth2/token',
        'GET /oauth2/userinfo',
        'POST /oauth2/userinfo',
        'GET /jwks',
        'POST /oauth2/consent',
        'GET /oauth2/public-client',
        'GET /oauth2/consent-transaction',
        'POST /oauth2/register',
      ],
    );
  });

  test('flag off exposes no MCP metadata or endpoint routes', async () => {
    const expected = readFileSync(
      new URL('../../support/better-auth-ba-on-issuer-off-print-routes.txt', import.meta.url),
      'utf8',
    );
    assert.equal(app.printRoutes({ commonPrefix: false }), expected);
    for (const item of [
      { method: 'GET' as const, url: '/api/v1/auth/oauth2/authorize' },
      { method: 'POST' as const, url: '/api/v1/auth/oauth2/token' },
      { method: 'GET' as const, url: '/api/v1/auth/oauth2/userinfo' },
      { method: 'GET' as const, url: '/api/v1/auth/jwks' },
      { method: 'POST' as const, url: '/api/v1/auth/oauth2/consent' },
      { method: 'GET' as const, url: '/api/v1/auth/oauth2/public-client' },
      { method: 'GET' as const, url: '/api/v1/auth/oauth2/consent-transaction' },
      { method: 'GET' as const, url: '/api/v1/auth/oauth2/register' },
      { method: 'POST' as const, url: '/api/v1/auth/oauth2/register' },
    ]) {
      const response = await app.inject({
        method: item.method,
        url: item.url,
        headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
        payload: item.method === 'POST' ? JSON.stringify({}) : undefined,
      });
      assert.equal(response.statusCode, 404, item.url);
      assert.doesNotMatch(response.body, /scopes_supported|authorization_servers|jwks_uri/u);
    }
  });

  test('allowlisted GET bridges to the real handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/get-session' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'null');
  });

  test('unknown auth path returns the stable 404 product envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/not-a-route' });
    assert.equal(res.statusCode, 404);
    assert.match(res.body, /resource_not_found/u);
  });

  test('wrong method on an allowlisted path returns 405 with Allow', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/v1/auth/sign-out' });
    assert.equal(res.statusCode, 405);
    assert.match(res.body, /method_not_allowed/u);
    assert.match(String(res.headers.allow ?? ''), /POST/u);
  });

  test('legacy OIDC endpoints are never registered under the auth base path', async () => {
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(start.statusCode, 404);
    const callback = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/callback' });
    assert.equal(callback.statusCode, 404);
  });

  test('a real schema-backed sign-up works through the composed app', async () => {
    const email = `composition-${Date.now()}@example.test`;
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Composition User', email, password: 'composition-password-1' }), // secret-scan: allow 'composition-password-1'
    });
    assert.equal(signUp.statusCode, 200);
    const setCookies = signUp.headers['set-cookie'];
    const rawCookies = setCookies === undefined ? [] : (Array.isArray(setCookies) ? setCookies : [setCookies]);
    const sessionEntry = rawCookies.find((cookie) => cookie.startsWith('__Host-known_session='));
    assert.equal(sessionEntry, undefined, 'P1: password sign-up must not set a session cookie');
    const users = await fixture.adminPool.query(
      `SELECT email FROM "${fixture.schemaName}"."auth_users" WHERE email = $1`,
      [email],
    );
    assert.equal(users.rowCount, 1, 'sign-up must still create the auth user');
  });

  test('emailOTP disableSignUp is pinned so login OTP cannot create users', async () => {
    const options = buildBetterAuthOptions({
      enabled: true,
      config: {
        ...inertRuntimeConfig(),
        emailOtp: {
          enabled: true,
          otpLength: 6,
          expiresInSeconds: 300,
          maxAttempts: 3,
        },
      },
      database: { db: inertDatabase(), type: 'postgres', transaction: true },
    });
    const plugin = (options.plugins ?? []).find((entry) => entry.id === 'email-otp') as
      | {
          readonly options?: {
            readonly disableSignUp?: boolean;
            readonly changeEmail?: { readonly enabled?: boolean; readonly verifyCurrentEmail?: boolean };
          };
        }
      | undefined;
    assert.equal(plugin?.options?.disableSignUp, true, 'P2: emailOTP disableSignUp must stay true');
    assert.equal(plugin?.options?.changeEmail?.enabled, true, 'P9: change-email OTP must stay enabled');
    assert.notEqual(
      plugin?.options?.changeEmail?.verifyCurrentEmail,
      true,
      'P9: do not require a current-mailbox OTP step',
    );
    const deliveries: Array<{ purpose: string; to: string }> = [];
    const withSender = buildBetterAuthOptions({
      enabled: true,
      config: {
        ...inertRuntimeConfig(),
        emailOtp: {
          enabled: true,
          otpLength: 6,
          expiresInSeconds: 300,
          maxAttempts: 3,
        },
      },
      database: { db: inertDatabase(), type: 'postgres', transaction: true },
      authEmail: {
        async sendAuthEmail(input) {
          deliveries.push({ purpose: input.purpose, to: input.to });
          return { outcome: 'queued', correlationId: 'c06-otp', providerMessageId: 'm' };
        },
      },
    });
    const wired = (withSender.plugins ?? []).find((entry) => entry.id === 'email-otp') as
      | {
          readonly options?: {
            readonly sendVerificationOTP?: (data: {
              readonly email: string;
              readonly otp: string;
              readonly type: string;
            }) => Promise<void>;
          };
        }
      | undefined;
    assert.ok(wired?.options?.sendVerificationOTP, 'emailOTP must receive the production sendVerificationOTP');
    await wired.options.sendVerificationOTP({
      email: 'ada@example.test',
      otp: '123456',
      type: 'change-email',
    });
    assert.deepEqual(deliveries, [{ purpose: 'change-email-otp', to: 'ada@example.test' }]);
    assert.equal(options.emailAndPassword?.requireEmailVerification, true, 'P1 occupancy is not an actor');
    assert.equal(
      options.account?.accountLinking?.disableImplicitLinking,
      true,
      'disableImplicitLinking must stay enabled',
    );
    assert.notEqual(
      options.user?.deleteUser?.enabled,
      true,
      'P10 must not enable Better Auth HTTP /delete-user',
    );
  });
});

describe('AUTH-P1-a: single Better Auth construction and password-reset hook', () => {
  test('buildBetterAuthOptions forwards onPasswordReset onto emailAndPassword.onPasswordReset', async () => {
    const onPasswordReset = vi.fn(async () => {});
    const options = buildBetterAuthOptions({
      enabled: true,
      config: inertRuntimeConfig(),
      database: { db: inertDatabase(), type: 'postgres', transaction: true },
      onPasswordReset,
    });
    assert.equal(typeof options.emailAndPassword?.onPasswordReset, 'function');
    await options.emailAndPassword?.onPasswordReset?.({
      user: { id: 'auth-user-1', email: 'ada@example.test' },
    });
    assert.equal(onPasswordReset.mock.calls.length, 1);
    assert.deepEqual(onPasswordReset.mock.calls[0]?.[0], { authUserId: 'auth-user-1' });
  });

  test('composeBetterAuthComposition constructs Better Auth exactly once and shares runtime.auth', () => {
    betterAuthSpy.mockClear();
    const composition = composeBetterAuthComposition({
      config: loadConfig(enabledEnv()),
      db: inertDatabase() as never,
      authEmail: {
        async sendAuthEmail() {
          return {
            outcome: 'email_delivery_unavailable',
            correlationId: 'composition-stub',
            redactedReason: 'stub sender (never contacted)',
          };
        },
      },
      logger: { warn() {} },
    });
    assert.equal(betterAuthSpy.mock.calls.length, 1, 'production composition must construct betterAuth once');
    assert.ok(composition.betterAuth);
    assert.ok(composition.betterAuthRuntime);
    assert.equal(composition.betterAuthRuntime.auth, composition.betterAuth);
    assert.equal(composition.betterAuth, betterAuthSpy.mock.results[0]?.value);
  });
});

describe('testGenericOAuth is NODE_ENV=test only', () => {
  const stubPlugin = { id: 'generic-oauth' } as NonNullable<ReturnType<typeof buildBetterAuthOptions>['plugins']>[number];

  function pluginIds(options: ReturnType<typeof buildBetterAuthOptions>): string[] {
    return (options.plugins ?? []).map((plugin) => plugin.id);
  }

  test('production plugins stay without genericOAuth when the hook is omitted', () => {
    const options = buildBetterAuthOptions({
      enabled: true,
      config: inertRuntimeConfig(),
      database: { db: inertDatabase(), type: 'postgres', transaction: true },
    });
    assert.equal(pluginIds(options).includes('generic-oauth'), false);
    assert.equal(pluginIds(options).includes('jwt'), false);
    assert.equal(pluginIds(options).includes('oauth-provider'), false);
    assert.equal(pluginIds(options).includes('cimd'), false);
  });

  test('NODE_ENV=test appends the hook plugin', () => {
    assert.equal(process.env.NODE_ENV, 'test');
    const options = buildBetterAuthOptions({
      enabled: true,
      config: inertRuntimeConfig(),
      database: { db: inertDatabase(), type: 'postgres', transaction: true },
      testGenericOAuth: stubPlugin,
    });
    assert.equal(pluginIds(options).includes('generic-oauth'), true);
  });

  test('non-test NODE_ENV refuses the hook', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(
        () => buildBetterAuthOptions({
          enabled: true,
          config: inertRuntimeConfig(),
          database: { db: inertDatabase(), type: 'postgres', transaction: true },
          testGenericOAuth: stubPlugin,
        }),
        (error: unknown) => error instanceof Error
          && error.message.includes('testGenericOAuth')
          && error.message.includes('NODE_ENV=test'),
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test('composeBetterAuthComposition forwards the hook into runtime', () => {
    betterAuthSpy.mockClear();
    const composition = composeBetterAuthComposition({
      config: loadConfig(enabledEnv()),
      db: inertDatabase() as never,
      authEmail: {
        async sendAuthEmail() {
          return {
            outcome: 'email_delivery_unavailable',
            correlationId: 'composition-stub',
            redactedReason: 'stub sender (never contacted)',
          };
        },
      },
      logger: { warn() {} },
      testGenericOAuth: genericOAuth({
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
      }),
    });
    assert.ok(composition.betterAuth);
    const constructed = betterAuthSpy.mock.calls[0]?.[0] as { plugins?: ReadonlyArray<{ id?: string }> };
    assert.equal(
      (constructed.plugins ?? []).some((plugin) => plugin.id === 'generic-oauth'),
      true,
      'compose must pass testGenericOAuth into buildBetterAuthOptions',
    );
  });
});

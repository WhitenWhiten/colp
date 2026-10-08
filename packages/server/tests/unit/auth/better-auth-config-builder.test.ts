import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { getCookies } from 'better-auth/cookies';
import { buildBetterAuthOptions } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  BETTER_AUTH_ARGON2ID_PARAMS,
  BETTER_AUTH_COOKIE_NAME,
  buildBetterAuthConfig,
  type BetterAuthConfigInput,
} from '../../../src/modules/auth/better-auth-config.js';
import {
  BETTER_AUTH_PROD_SECRET,
  betterAuthProductionEnv,
  betterAuthTestEnv,
} from '../../support/better-auth-config-test-helpers.js';

/**
 * Task A1 builder / mode contract (G1 §6 / §16):
 * - Better Auth mode (BETTER_AUTH_ENABLED=true) makes the legacy OIDC env
 *   non-required; legacy mode keeps the existing OIDC_JWKS_URI checks;
 * - production test flags (OIDC_ALLOW_TEST_PROVIDER / KNOWN_ENABLE_E2E_TEST_IDENTITY)
 *   stay fail-closed in every Better Auth mode.
 *
 * AUTH-P1-b: BETTER_AUTH_CUTOVER_MODE / BETTER_AUTH_CANARY_ALLOWLIST stay parsed
 * (illegal values fail startup) but are unused at runtime. Routing is only
 * BETTER_AUTH_ENABLED off/on; ADR shadow is not implemented.
 *
 * Flag-parsing contracts live in better-auth-config.test.ts.
 */

describe('Better Auth mode vs legacy OIDC env requirements (G1 §6)', () => {
  test('production without OIDC env loads when BETTER_AUTH_ENABLED=true', () => {
    const config = loadConfig(betterAuthProductionEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    assert.equal(config.betterAuth.enabled, true);
    assert.equal(config.oidc.jwksUri, null);
  });

  test('legacy mode keeps the production OIDC_JWKS_URI requirement', () => {
    // The pre-existing legacy guard fires first (allowTestProvider is off):
    // the requirement is preserved — startup fails without OIDC_JWKS_URI.
    assert.throws(
      () => loadConfig(betterAuthProductionEnv()),
      /OIDC_JWKS_URI is required/u,
    );
  });

  test('production test flags stay fail-closed in every Better Auth mode', () => {
    const enabled = { BETTER_AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET };
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({ ...enabled, OIDC_ALLOW_TEST_PROVIDER: 'true' })),
      /OIDC_ALLOW_TEST_PROVIDER must not be enabled in production/u,
    );
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({
        ...enabled,
        OIDC_ALLOW_TEST_PROVIDER: 'true',
        OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      })),
      /OIDC_ALLOW_TEST_PROVIDER must not be enabled in production/u,
    );
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({ ...enabled, KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true' })),
      /KNOWN_ENABLE_E2E_TEST_IDENTITY requires NODE_ENV=test/u,
    );
  });

  test('production without OIDC env still fails when Better Auth is off (legacy preserved)', () => {
    assert.throws(
      () => loadConfig(betterAuthProductionEnv({ BETTER_AUTH_CUTOVER_MODE: 'shadow' })),
      /OIDC_JWKS_URI is required/u,
    );
  });
});

describe('buildBetterAuthConfig (typed config wrapper)', () => {
  test('disabled input produces no Better Auth config (no instance construction path)', () => {
    const config = loadConfig(betterAuthTestEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.equal(built, null);
  });

  test('typed config flows through to the Better Auth settings', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
      BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
      BETTER_AUTH_SOCIAL_ENABLED: 'true',
      BETTER_AUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      BETTER_AUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
      BETTER_AUTH_SESSION_EXPIRES_IN_SECONDS: '43200',
      BETTER_AUTH_SESSION_UPDATE_AGE_SECONDS: '300',
      BETTER_AUTH_OTP_TTL_SECONDS: '600',
      BETTER_AUTH_OTP_MAX_ATTEMPTS: '5',
    }));
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');
    assert.equal(built.baseURL, 'https://app.example.test');
    assert.equal(built.basePath, '/api/v1/auth');
    assert.equal(built.secret, BETTER_AUTH_PROD_SECRET);
    assert.deepEqual(built.trustedOrigins, ['https://app.example.test']);
    assert.equal(built.cookieName, '__Host-known_session');
    assert.equal(built.sessionExpiresInSeconds, 43_200);
    assert.equal(built.sessionUpdateAgeSeconds, 300);
    assert.ok(built.emailOtp);
    assert.equal(built.emailOtp.enabled, true);
    assert.equal(built.emailOtp.otpLength, 6);
    assert.equal(built.emailOtp.expiresInSeconds, 600);
    assert.equal(built.emailOtp.maxAttempts, 5);
    assert.deepEqual(built.social?.google, { clientId: 'google-client-id', clientSecret: 'google-client-secret' }); // secret-scan: allow 'google-client-secret'
    assert.equal(built.social?.github, undefined);
  });

  test('email OTP and social remain null when their flags are off', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built);
    assert.equal(built.emailOtp, null);
    assert.equal(built.social, null);
  });

  test('password hash hook uses Argon2id and round-trips', async () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built);
    assert.deepEqual(BETTER_AUTH_ARGON2ID_PARAMS, { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const hash = await built.passwordHash.hash('correct-horse-battery-staple');
    assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    assert.equal(await built.passwordHash.verify({ hash, password: 'correct-horse-battery-staple' }), true); // secret-scan: allow 'correct-horse-battery-staple'
    assert.equal(await built.passwordHash.verify({ hash, password: 'wrong-password' }), false); // secret-scan: allow 'wrong-password'
  });

  test('frozen cookie name is enforced at the wrapper boundary too', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    assert.throws(
      () => buildBetterAuthConfig({ ...config.betterAuth, cookieName: '__Host-other_session' }),
      /COOKIE_NAME is frozen/u,
    );
  });

  test('enabled wrapper refuses missing or short secrets', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    assert.throws(
      () => buildBetterAuthConfig({ ...config.betterAuth, secret: null }),
      /BETTER_AUTH_SECRET/u,
    );
    assert.throws(
      () => buildBetterAuthConfig({ ...config.betterAuth, secret: 'too-short' }),
      /at least 32 characters/u,
    );
  });

  test('wrapper re-checks the updateAge < expiresIn invariant', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    assert.throws(
      () => buildBetterAuthConfig({
        ...config.betterAuth,
        sessionExpiresInSeconds: 120,
        sessionUpdateAgeSeconds: 120,
      }),
      /sessionUpdateAgeSeconds must be smaller than sessionExpiresInSeconds/u,
    );
  });

  test('AppConfig.betterAuth is structurally assignable to BetterAuthConfigInput', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    const input: BetterAuthConfigInput = config.betterAuth;
    assert.equal(input.enabled, true);
  });

  test('session_token cookie attributes are explicit HttpOnly / Secure / SameSite=Lax', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    }));
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built);
    const options = buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: {} as never, type: 'postgres', transaction: true },
    });
    const sessionToken = options.advanced?.cookies?.session_token;
    assert.equal(options.advanced?.useSecureCookies, false);
    assert.equal(sessionToken?.name, BETTER_AUTH_COOKIE_NAME);
    assert.equal(sessionToken?.attributes?.httpOnly, true);
    assert.equal(sessionToken?.attributes?.secure, true);
    assert.equal(sessionToken?.attributes?.sameSite, 'Lax');

    const merged = getCookies(options).sessionToken;
    assert.equal(merged.name, BETTER_AUTH_COOKIE_NAME);
    assert.equal(merged.attributes.httpOnly, true);
    assert.equal(merged.attributes.secure, true);
    assert.equal(String(merged.attributes.sameSite).toLowerCase(), 'lax');
  });
});

describe('AUTH-P1-b unused cutover/canary (parsed, not routed)', () => {
  function comparableSettings(built: NonNullable<ReturnType<typeof buildBetterAuthConfig>>) {
    const { passwordHash: _passwordHash, ...rest } = built;
    return rest;
  }

  test('disabled stays null for every CUTOVER_MODE (no ADR shadow surface)', () => {
    for (const mode of ['shadow', 'canary', 'on'] as const) {
      const config = loadConfig(betterAuthTestEnv({ BETTER_AUTH_CUTOVER_MODE: mode }));
      assert.equal(config.betterAuth.enabled, false);
      assert.equal(config.betterAuth.cutoverMode, mode);
      assert.equal(buildBetterAuthConfig(config.betterAuth), null);
    }
  });

  test('enabled builder output is identical across unused CUTOVER_MODE values', () => {
    const base = {
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
    };
    const built = (['shadow', 'canary', 'on'] as const).map((mode) => {
      const config = loadConfig(betterAuthTestEnv({ ...base, BETTER_AUTH_CUTOVER_MODE: mode }));
      assert.equal(config.betterAuth.cutoverMode, mode);
      const settings = buildBetterAuthConfig(config.betterAuth);
      assert.ok(settings, 'enabled config must produce Better Auth settings');
      return comparableSettings(settings);
    });
    assert.deepEqual(built[0], built[1]);
    assert.deepEqual(built[1], built[2]);
  });

  test('canaryAllowlist is stored on the typed section but unused by the builder', () => {
    const config = loadConfig(betterAuthTestEnv({
      BETTER_AUTH_ENABLED: 'true',
      BETTER_AUTH_SECRET: BETTER_AUTH_PROD_SECRET,
      BETTER_AUTH_CANARY_ALLOWLIST: 'canary@example.test',
    }));
    assert.deepEqual(config.betterAuth.canaryAllowlist, ['canary@example.test']);
    const withList = buildBetterAuthConfig(config.betterAuth);
    const withoutList = buildBetterAuthConfig({
      ...config.betterAuth,
      canaryAllowlist: undefined,
    });
    assert.ok(withList && withoutList);
    assert.deepEqual(comparableSettings(withList), comparableSettings(withoutList));
  });
});

/**
 * Better Auth security telemetry redaction and MFA plugin configuration
 * contracts split from auth-security-policy.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { buildBetterAuthOptions } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  redactSensitiveText,
  serializeRawHeaderPairs,
} from '../../../src/infrastructure/telemetry/index.js';
import { TEST_SESSION_TOKEN_PROTECTION } from '../../support/better-auth-session-token-protection.js';

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
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
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

describe('Better Auth log redaction (telemetry)', () => {
  test('BA cookie values, session tokens, OTPs, backup codes and TOTP URIs never survive redaction', () => {
    const text = [
      '__Host-known_session=abcdefghijklmnopqrstuvwxyz012345.signature==',
      'known.two_factor=signed-challenge-value==',
      'known.trust_device=token!identifier',
      'session_token=raw-session-token-value',
      'otp=123456',
      'backupCodes=ABCDE-12345',
      'backup code: FGHIJ-67890',
      'recoveryCode=KLMNO-11111',
      'otpauth://totp/known:user@example.test?secret=JBSWY3DPEHPK3PXP&issuer=known',
    ].join('; ');
    const redacted = redactSensitiveText(text);
    for (const secret of [
      'abcdefghijklmnopqrstuvwxyz012345', 'signed-challenge-value==', 'token!identifier',
      'raw-session-token-value', '123456', 'ABCDE-12345', 'FGHIJ-67890', 'KLMNO-11111',
      'JBSWY3DPEHPK3PXP',
    ]) {
      assert.equal(redacted.includes(secret), false, `secret ${secret} must be redacted`);
    }
    assert.equal(redacted.includes('[REDACTED]'), true);
  });

  test('benign configuration words and unrelated values stay intact', () => {
    const text = 'otpLength=6; otpMaxAttempts=3; period=30; monkey=banana; tokenizer=off; tokens=3; code=200; issuer=known';
    const redacted = redactSensitiveText(text);
    assert.equal(redacted, text, 'config words and unrelated values must not be over-redacted');
  });

  test('raw header pairs redact every Set-Cookie (BA session and challenge cookies)', () => {
    const pairs = serializeRawHeaderPairs([
      ['set-cookie', '__Host-known_session=abc.signature==; Path=/; HttpOnly; Secure'],
      ['content-type', 'application/json'],
      ['set-cookie', 'known.two_factor=challenge==; Max-Age=600'],
    ]);
    assert.deepEqual(pairs, [
      ['set-cookie', '[REDACTED]'],
      ['content-type', 'application/json'],
      ['set-cookie', '[REDACTED]'],
    ]);
  });
});

describe('MFA plugin configuration (better-auth-config + runtime wiring)', () => {
  test('MFA stays null when not enabled; typed settings freeze the library-safe defaults', () => {
    const config = loadConfig(testEnv({ BETTER_AUTH_ENABLED: 'true', BETTER_AUTH_SECRET: 'x'.repeat(40) }));
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built);
    assert.equal(built.mfa, null, 'MFA must be off by default (config.ts env parsing lands the switch)');

    const withMfa = buildBetterAuthConfig({
      ...config.betterAuth,
      mfa: { enabled: true },
    });
    assert.ok(withMfa);
    assert.deepEqual(withMfa.mfa, {
      enabled: true,
      totpDigits: 6,
      totpPeriodSeconds: 30,
      pendingCookieMaxAgeSeconds: 600,
      backupCodesAmount: 10,
      backupCodesLength: 10,
      trustDeviceMaxAgeSeconds: 2_592_000,
    });
  });

  test('invalid MFA settings fail closed at config build time', () => {
    const base = {
      enabled: true,
      cutoverMode: 'shadow' as const,
      emailOtpEnabled: false,
      socialEnabled: false,
      baseUrl: 'https://app.example.test',
      basePath: '/api/v1/auth',
      secret: 'x'.repeat(40),
      sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
      trustedOrigins: ['https://app.example.test'],
      cookieName: '__Host-known_session',
      sessionExpiresInSeconds: 86_400,
      sessionUpdateAgeSeconds: 60,
      otpTtlSeconds: 300,
      otpMaxAttempts: 3,
      bodyLimitBytes: 1024,
      social: {},
    };
    assert.throws(() => buildBetterAuthConfig({ ...base, mfa: { enabled: true, totpDigits: 7 as never } }), /totpDigits/u);
    assert.throws(() => buildBetterAuthConfig({ ...base, mfa: { enabled: true, totpPeriodSeconds: 10 } }), /totpPeriodSeconds/u);
    assert.throws(() => buildBetterAuthConfig({ ...base, mfa: { enabled: true, pendingCookieMaxAgeSeconds: 5 } }), /pendingCookieMaxAgeSeconds/u);
    assert.throws(() => buildBetterAuthConfig({ ...base, mfa: { enabled: true, backupCodesAmount: 1 } }), /backupCodesAmount/u);
  });

  test('the runtime wires the two-factor plugin only when MFA is configured', () => {
    const baseConfig = {
      baseURL: 'https://app.example.test',
      basePath: '/api/v1/auth',
      secret: 'x'.repeat(40),
      sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
      trustedOrigins: ['https://app.example.test'],
      cookieName: '__Host-known_session' as const,
      sessionExpiresInSeconds: 86_400,
      sessionUpdateAgeSeconds: 60,
      bodyLimitBytes: 1024,
      emailOtp: null,
      social: null,
      passwordHash: {
        hash: async (password: string) => `hash:${password}`,
        verify: async () => false,
      },
    };
    const db = {} as never;
    const without = buildBetterAuthOptions({
      enabled: true,
      config: baseConfig,
      database: { db, type: 'postgres', transaction: true },
    });
    assert.ok(Array.isArray(without.plugins));
    assert.equal(
      (without.plugins as Array<{ id?: string }>).some((plugin) => plugin.id === 'two-factor'),
      false,
      'no MFA config => the two-factor plugin must not be wired',
    );

    const withMfa = buildBetterAuthOptions({
      enabled: true,
      config: {
        ...baseConfig,
        mfa: {
          enabled: true,
          totpDigits: 6,
          totpPeriodSeconds: 30,
          pendingCookieMaxAgeSeconds: 600,
          backupCodesAmount: 10,
          backupCodesLength: 10,
          trustDeviceMaxAgeSeconds: 2_592_000,
        },
      },
      database: { db, type: 'postgres', transaction: true },
    });
    assert.ok(Array.isArray(withMfa.plugins));
    assert.equal(
      (withMfa.plugins as Array<{ id?: string; options?: { allowPasswordless?: boolean } }>).some((plugin) => plugin.id === 'two-factor'),
      true,
      'MFA config must wire the two-factor plugin',
    );
    const twoFactorPlugin = (withMfa.plugins as Array<{ id?: string; options?: { allowPasswordless?: boolean } }>)
      .find((plugin) => plugin.id === 'two-factor');
    assert.equal(twoFactorPlugin?.options?.allowPasswordless, false, 'P5 must not flip allowPasswordless');
  });
});

/**
 * G2 runtime shape: username plugin always, and the self-hosted edition drops
 * email verification, email OTP, and two-factor.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { buildBetterAuthOptions } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import type { BetterAuthRuntimeConfig } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { TEST_SESSION_TOKEN_PROTECTION } from '../../support/better-auth-session-token-protection.js';

const previousEdition = process.env.KNOWN_EDITION;

afterEach(() => {
  if (previousEdition === undefined) delete process.env.KNOWN_EDITION;
  else process.env.KNOWN_EDITION = previousEdition;
});

function runtimeConfig(overrides: Partial<BetterAuthRuntimeConfig> = {}): BetterAuthRuntimeConfig {
  return {
    baseURL: 'https://app.example.test',
    basePath: '/api/v1/auth',
    secret: 'x'.repeat(40),
    sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
    trustedOrigins: ['https://app.example.test'],
    cookieName: '__Host-known_session',
    sessionExpiresInSeconds: 86_400,
    sessionUpdateAgeSeconds: 60,
    bodyLimitBytes: 1024,
    emailOtp: {
      enabled: true,
      otpLength: 6,
      expiresInSeconds: 300,
      maxAttempts: 3,
    },
    social: null,
    passwordHash: {
      hash: async (password: string) => `hash:${password}`,
      verify: async () => false,
    },
    mfa: {
      enabled: true,
      totpDigits: 6,
      totpPeriodSeconds: 30,
      pendingCookieMaxAgeSeconds: 600,
      backupCodesAmount: 10,
      backupCodesLength: 10,
      trustDeviceMaxAgeSeconds: 2_592_000,
    },
    ...overrides,
  };
}

function pluginIds(config: BetterAuthRuntimeConfig): string[] {
  const options = buildBetterAuthOptions({
    enabled: true,
    config,
    database: { db: {} as never, type: 'postgres', transaction: true },
  });
  return (options.plugins ?? []).map((plugin) => plugin.id);
}

describe('G2 username plugin and self-hosted sign-up', () => {
  test('hosted mode keeps email verification, email OTP, and two-factor', () => {
    delete process.env.KNOWN_EDITION;
    const options = buildBetterAuthOptions({
      enabled: true,
      config: runtimeConfig(),
      database: { db: {} as never, type: 'postgres', transaction: true },
    });
    assert.equal(options.emailAndPassword?.requireEmailVerification, true);
    assert.equal(options.emailVerification?.sendOnSignUp, true);
    const ids = pluginIds(runtimeConfig());
    assert.equal(ids.includes('username'), true);
    assert.equal(ids.includes('email-otp'), true);
    assert.equal(ids.includes('two-factor'), true);
    assert.equal(ids.includes('colp-registration-state'), true);
  });

  test('self-hosted drops verification, email OTP, and two-factor', () => {
    process.env.KNOWN_EDITION = 'self-hosted';
    const options = buildBetterAuthOptions({
      enabled: true,
      config: runtimeConfig(),
      database: { db: {} as never, type: 'postgres', transaction: true },
    });
    assert.equal(options.emailAndPassword?.requireEmailVerification, false);
    assert.equal(options.emailVerification?.sendOnSignUp, false);
    const ids = pluginIds(runtimeConfig());
    assert.equal(ids.includes('username'), true);
    assert.equal(ids.includes('email-otp'), false);
    assert.equal(ids.includes('two-factor'), false);
  });
});

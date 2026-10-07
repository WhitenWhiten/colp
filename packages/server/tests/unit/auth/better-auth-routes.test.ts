/**
 * Task A4 unit tests: the Better Auth manifest, error translation and product
 * route contract. Real handler/bridge/PostgreSQL coverage lives in
 * better-auth-routes-postgres.test.ts.
 *
 * 假阴性防护:
 * - error classification asserts the STABLE product code AND a fixed message
 *   that never echoes the BA message, the email, an OTP or a raw token;
 *
 * 假阳性防护:
 * - the allowlist assertion compares the manifest's registered Better Auth
 *   entries 1:1 with the frozen BETTER_AUTH_ALLOWLIST (a "any /api/v1/auth/*
 *   returns non-500" check would be a false positive);
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  AccountLinkingError,
  BrowserSessionAuthenticationError,
  type AccountLinkingErrorCode,
  type AccountLinkingService,
  type AccountDeletionService,
  type AuthenticatedBrowserActor,
  type BrowserSessionAuthority,
} from '../../../src/modules/auth/index.js';
import { hashSecret, type IdentityUnitOfWork } from '../../../src/modules/identity/index.js';
import { BETTER_AUTH_ALLOWLIST } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  AUTH_ROUTE_MANIFEST,
  authManifestEntryFor,
  requireAuthManifestEntry,
} from '../../../src/transport/auth/auth-route-manifest.js';
import { mapAccountLinkingError } from '../../../src/transport/auth/browser-auth-routes.js';
import {
  AUTH_RATE_LIMITED_PATHS,
  authRateLimitRouteFamilyForPath,
  isAuthRateLimitedPath,
} from '../../../src/transport/http-security.js';
import { productErrorStatus } from '../../../src/transport/product-codes.js';
import { translateBetterAuthError } from '../../../src/transport/product-error.js';
import { stripBetterAuthRawTokens } from '../../../src/transport/auth/better-auth-routes.js';
import { BETTER_AUTH_PRODUCT_WIRE } from '../../support/better-auth-product-wire.js';

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

describe('auth-route-manifest: single source for OpenAPI/rate-limit/registration', () => {
  test('the registered Better Auth entries are the G1 §10 allowlist + C3 OAuth chains + the C2 email surface', () => {
    const registered = AUTH_ROUTE_MANIFEST.filter((entry) =>
      entry.scope === 'better-auth' && entry.status === 'registered');
    assert.deepEqual(
      registered.map((entry) => `${entry.method} ${entry.path}`),
      [
        'POST /api/v1/auth/sign-up/email',
        'POST /api/v1/auth/sign-in/email',
        'GET /api/v1/auth/get-session',
        'POST /api/v1/auth/sign-out',
        'POST /api/v1/auth/revoke-session',
        'POST /api/v1/auth/change-password',
        // C3: the OAuth authorization-code chains are registered (start + callback):
        // the built-in social chain (production google/github) and the genericOAuth
        // chain (controlled test providers).
        'POST /api/v1/auth/sign-in/social',
        'GET /api/v1/auth/callback/:providerId',
        'POST /api/v1/auth/sign-in/oauth2',
        'GET /api/v1/auth/oauth2/callback/:providerId',
        // C2/A4: the email surface (password reset + verification + emailOTP
        // plugin) is registered against the real BA 1.7.1 paths (G1 §17 P2
        // enumeration). /verify-email is GET — BA 1.7.1 registers the
        // token-in-query GET, never a POST.
        'POST /api/v1/auth/reset-password',
        'POST /api/v1/auth/request-password-reset',
        'GET /api/v1/auth/verify-email',
        'POST /api/v1/auth/send-verification-email',
        'POST /api/v1/auth/sign-in/email-otp',
        'POST /api/v1/auth/email-otp/send-verification-otp',
        'POST /api/v1/auth/email-otp/check-verification-otp',
        'POST /api/v1/auth/email-otp/verify-email',
        'POST /api/v1/auth/email-otp/request-password-reset',
        'POST /api/v1/auth/email-otp/reset-password',
        'POST /api/v1/auth/forget-password/email-otp',
        'POST /api/v1/auth/email-otp/request-email-change',
        'POST /api/v1/auth/email-otp/change-email',
        'GET /api/v1/auth/oauth2/authorize',
        'POST /api/v1/auth/oauth2/authorize',
        'POST /api/v1/auth/oauth2/token',
        'GET /api/v1/auth/oauth2/userinfo',
        'POST /api/v1/auth/oauth2/userinfo',
        'GET /api/v1/auth/jwks',
        'POST /api/v1/auth/oauth2/consent',
        'GET /api/v1/auth/oauth2/public-client',
        'GET /api/v1/auth/oauth2/consent-transaction',
        'POST /api/v1/auth/oauth2/register',
      ],
    );
    const expectedFamily: Readonly<Record<string, 'sign-up' | 'sign-in' | 'session' | 'otp' | 'reset' | 'oauth-callback' | 'oauth-authorize' | 'oauth-register' | 'oauth-token'>> = {
      '/api/v1/auth/sign-up/email': 'sign-up',
      '/api/v1/auth/sign-in/email': 'sign-in',
      '/api/v1/auth/sign-in/social': 'sign-in',
      '/api/v1/auth/sign-in/oauth2': 'sign-in',
      '/api/v1/auth/callback/:providerId': 'oauth-callback',
      '/api/v1/auth/oauth2/callback/:providerId': 'oauth-callback',
      '/api/v1/auth/get-session': 'session',
      '/api/v1/auth/sign-out': 'session',
      '/api/v1/auth/revoke-session': 'session',
      '/api/v1/auth/change-password': 'session',
      '/api/v1/auth/reset-password': 'reset',
      '/api/v1/auth/request-password-reset': 'reset',
      '/api/v1/auth/forget-password/email-otp': 'reset',
      '/api/v1/auth/email-otp/request-password-reset': 'reset',
      '/api/v1/auth/email-otp/reset-password': 'reset',
      '/api/v1/auth/verify-email': 'otp',
      '/api/v1/auth/send-verification-email': 'otp',
      '/api/v1/auth/sign-in/email-otp': 'otp',
      '/api/v1/auth/email-otp/send-verification-otp': 'otp',
      '/api/v1/auth/email-otp/check-verification-otp': 'otp',
      '/api/v1/auth/email-otp/verify-email': 'otp',
      '/api/v1/auth/email-otp/request-email-change': 'otp',
      '/api/v1/auth/email-otp/change-email': 'otp',
      '/api/v1/auth/oauth2/authorize': 'oauth-authorize',
      '/api/v1/auth/oauth2/token': 'oauth-token',
      '/api/v1/auth/oauth2/userinfo': 'oauth-token',
      '/api/v1/auth/jwks': 'oauth-token',
      '/api/v1/auth/oauth2/consent': 'oauth-authorize',
      '/api/v1/auth/oauth2/public-client': 'oauth-authorize',
      '/api/v1/auth/oauth2/consent-transaction': 'oauth-authorize',
      '/api/v1/auth/oauth2/register': 'oauth-register',
    };
    for (const entry of registered) {
      // C4: the Better Auth surface carries dedicated sealed families
      // (sign-up / sign-in / session / otp / reset / oauth-callback).
      const expected = expectedFamily[entry.path];
      assert.ok(expected, `${entry.path} must be covered by the family expectation table`);
      assert.equal(entry.rateLimitFamily, expected, `${entry.path} must carry the ${expected} family`);
    }
    for (const entry of registered) {
      assert.equal(authManifestEntryFor(entry.method, entry.path)?.status, 'registered');
    }
  });

  test('the registered Better Auth entries match BETTER_AUTH_ALLOWLIST 1:1 (single allowlist)', () => {
    const registered = AUTH_ROUTE_MANIFEST.filter((entry) =>
      entry.scope === 'better-auth' && entry.status === 'registered');
    assert.deepEqual(
      registered.map((entry) => `${entry.method} ${entry.path.replace(BASE_PATH, '')}`),
      BETTER_AUTH_ALLOWLIST.map((entry) => `${entry.method} ${entry.path}`),
    );
  });

  test('C3/C4: the OAuth link surface moved to product scope; link/recovery carry their sealed families', () => {
    // The explicit link endpoint is served by the product route (session +
    // Origin/CSRF + re-auth gate) — same path/method, product scope now.
    const link = requireAuthManifestEntry('POST', '/api/v1/auth/oauth2/link');
    assert.equal(link.scope, 'product');
    assert.equal(link.status, 'registered');
    assert.equal(link.rateLimitFamily, 'link');
    const unlink = requireAuthManifestEntry('POST', '/api/v1/auth/unlink-account');
    assert.equal(unlink.scope, 'product');
    assert.equal(unlink.status, 'registered');
    assert.equal(unlink.rateLimitFamily, 'link');
    const listed = requireAuthManifestEntry('GET', '/api/v1/auth/linked-accounts');
    assert.equal(listed.scope, 'product');
    assert.equal(listed.status, 'registered');
    assert.equal(listed.rateLimitFamily, 'link');
    // P3: product GET body is { accounts, hasPassword } (not a frozen OpenAPI BA path).
    assert.ok(listed.note?.includes('hasPassword'), 'the product list note must pin hasPassword');
    assert.ok(listed.note?.includes('{ accounts, hasPassword }'), 'the product list body shape must stay { accounts, hasPassword }');
    const recovery = requireAuthManifestEntry('POST', '/api/v1/auth/recovery/password-reset');
    assert.equal(recovery.scope, 'product');
    assert.equal(recovery.status, 'registered');
    assert.equal(recovery.rateLimitFamily, 'reset');
    const otpReset = requireAuthManifestEntry('POST', '/api/v1/auth/recovery/otp-reset');
    assert.equal(otpReset.scope, 'product');
    assert.equal(otpReset.status, 'registered');
    assert.equal(otpReset.rateLimitFamily, 'reset');
    const sessions = requireAuthManifestEntry('GET', '/api/v1/auth/sessions');
    assert.equal(sessions.scope, 'product');
    assert.equal(sessions.status, 'registered');
    assert.equal(sessions.rateLimitFamily, 'session');
    assert.ok(sessions.note?.includes('never token'), 'P4 list must pin R9: never token');
    const revokeById = requireAuthManifestEntry('POST', '/api/v1/auth/sessions/revoke');
    assert.equal(revokeById.scope, 'product');
    assert.equal(revokeById.status, 'registered');
    assert.equal(revokeById.rateLimitFamily, 'session');
    assert.ok(revokeById.note?.includes('not token'), 'P4 revoke must take the session id, not a token');
    const deleteAccount = requireAuthManifestEntry('POST', '/api/v1/auth/account/delete');
    assert.equal(deleteAccount.scope, 'product');
    assert.equal(deleteAccount.status, 'registered');
    assert.equal(deleteAccount.rateLimitFamily, 'session');
    assert.ok(deleteAccount.note?.includes('DELETE'), 'P10 must pin typed confirmation DELETE');
    assert.ok(!BETTER_AUTH_ALLOWLIST.some((entry) => entry.path.includes('delete-user')),
      'P10 must not add Better Auth HTTP /delete-user to the allowlist');
  });

  test('pending BA 1.7.1 endpoints are enumerated (two-factor/MFA) but NOT registered; C4 seals their families', () => {
    const pending = AUTH_ROUTE_MANIFEST.filter((entry) =>
      entry.scope === 'better-auth' && entry.status === 'pending');
    assert.deepEqual(
      pending.map((entry) => `${entry.method} ${entry.path}`),
      [
        // C4: two-factor (MFA) plugin endpoints (BA 1.7.1 paths). The email
        // surface (reset/verification/emailOTP) flipped to registered.
        'POST /api/v1/auth/two-factor/enable',
        'POST /api/v1/auth/two-factor/disable',
        'POST /api/v1/auth/two-factor/get-totp-uri',
        'POST /api/v1/auth/two-factor/verify-totp',
        'POST /api/v1/auth/two-factor/verify-backup-code',
        'POST /api/v1/auth/two-factor/generate-backup-codes',
        'POST /api/v1/auth/two-factor/send-otp',
        'POST /api/v1/auth/two-factor/verify-otp',
      ],
    );
    for (const entry of pending) {
      assert.notEqual(entry.rateLimitFamily, null, 'pending endpoints carry their sealed C4 family so the admission map is ready');
      if (entry.rateLimitFamily !== null) {
        assert.equal(authRateLimitRouteFamilyForPath(entry.path), entry.rateLimitFamily, `${entry.path} family must be live in the map`);
      }
    }
  });

  test('manifest operationIds are unique (future OpenAPI registration contract)', () => {
    const operationIds = AUTH_ROUTE_MANIFEST.map((entry) => entry.operationId);
    assert.equal(new Set(operationIds).size, operationIds.length, 'operationIds must be unique');
    for (const entry of AUTH_ROUTE_MANIFEST) {
      assert.ok(entry.operationId.length > 0, `${entry.method} ${entry.path} needs an operationId`);
    }
  });

  test('the rate-limit path list and families derive from the manifest (single source)', () => {
    // Every manifest entry with a family is rate-limited with exactly that family.
    for (const entry of AUTH_ROUTE_MANIFEST) {
      if (entry.rateLimitFamily === null) continue;
      assert.equal(isAuthRateLimitedPath(entry.path), true, `${entry.path} must be rate-limited`);
      assert.equal(authRateLimitRouteFamilyForPath(entry.path), entry.rateLimitFamily);
    }
    // The legacy product/oidc surface keeps its sealed families unchanged.
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oidc/start'), 'oidc-start');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oidc/callback'), 'oidc-callback');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/session'), 'session');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me'), 'me');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me/avatar'), 'me');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/me?x=1'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/health'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback/google'), 'oauth-callback');
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/callback/github'), 'oauth-callback');
    assert.equal(isAuthRateLimitedPath('/api/v1/auth/callback/google'), true);
    assert.equal(isAuthRateLimitedPath('/api/v1/auth/oauth2/callback/github'), true);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback/google/extra'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/callback'), null);
    assert.equal(authRateLimitRouteFamilyForPath('/api/v1/auth/oauth2/callback'), null);
    // Every rate-limited path comes from the manifest (nothing hardcoded elsewhere).
    for (const path of AUTH_RATE_LIMITED_PATHS) {
      assert.ok(AUTH_ROUTE_MANIFEST.some((entry) => entry.path === path), `${path} must be in the manifest`);
    }
  });
});

describe('translateBetterAuthError: unified product error classification', () => {
  test('maps the frozen BA codes to stable product codes with fixed messages', () => {
    const cases: ReadonlyArray<{
      readonly status: number;
      readonly body: { readonly message: string; readonly code: keyof typeof BETTER_AUTH_PRODUCT_WIRE };
    }> = [
      { status: 401, body: { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' } },
      { status: 422, body: { message: 'User already exists.', code: 'USER_ALREADY_EXISTS' } },
      { status: 422, body: { message: 'User already exists. Use another email.', code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' } },
      { status: 403, body: { message: 'Email not verified', code: 'EMAIL_NOT_VERIFIED' } },
      { status: 401, body: { message: 'Unauthorized', code: 'UNAUTHORIZED' } },
      { status: 401, body: { message: 'Session is required', code: 'SESSION_REQUIRED' } },
      { status: 403, body: { message: 'Invalid origin', code: 'INVALID_ORIGIN' } },
      { status: 403, body: { message: 'Missing or null Origin', code: 'MISSING_OR_NULL_ORIGIN' } },
      { status: 400, body: { message: 'Social account already linked', code: 'SOCIAL_ACCOUNT_ALREADY_LINKED' } },
      { status: 400, body: { message: 'Linked account already exists', code: 'LINKED_ACCOUNT_ALREADY_EXISTS' } },
      { status: 400, body: { message: "Verification email isn't enabled", code: 'VERIFICATION_EMAIL_NOT_ENABLED' } },
      { status: 400, body: { message: 'Reset password is disabled', code: 'RESET_PASSWORD_DISABLED' } },
      { status: 429, body: { message: 'Too many requests', code: 'TOO_MANY_REQUESTS' } },
      { status: 400, body: { message: 'Invalid OTP', code: 'INVALID_OTP' } },
      { status: 400, body: { message: 'OTP expired', code: 'OTP_EXPIRED' } },
      { status: 403, body: { message: 'Too many attempts', code: 'TOO_MANY_ATTEMPTS' } },
    ];
    for (const item of cases) {
      const wire = BETTER_AUTH_PRODUCT_WIRE[item.body.code];
      const translated = translateBetterAuthError(item.status, item.body);
      assert.ok(translated, `${item.body.code} must translate`);
      assert.equal(translated.productCode, wire.productCode);
      assert.equal(translated.message, wire.message);
      assert.equal(translated.statusCode, wire.statusCode);
      assert.equal(translated.statusCode, productErrorStatus(translated.productCode));
    }
  });

  test('BA status 403 + TOO_MANY_ATTEMPTS still yields 429 rate_limited (BA status is not trusted)', () => {
    const translated = translateBetterAuthError(403, { message: 'Too many attempts', code: 'TOO_MANY_ATTEMPTS' });
    assert.ok(translated);
    assert.equal(translated.productCode, 'rate_limited');
    assert.equal(translated.statusCode, 429);
    assert.equal(translated.recovery, 'same_request');
    assert.equal(translated.message, 'Too many requests. Please try again later.');
    assert.equal(translated.message.includes('Too many attempts'), false);
  });

  test('the fixed messages never echo the BA message, email, OTP or token', () => {
    // The BA message is deliberately discarded; a message containing secret
    // material must never reach the wire.
    const translated = translateBetterAuthError(401, {
      message: 'Invalid email or password for user victim@example.test',
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
    assert.ok(translated);
    assert.equal(translated.message.includes('victim@example.test'), false);
    assert.equal(translated.message.includes('Invalid email or password'), false);
  });

  test('unknown BA codes fail closed to invalid_request (never leak BA text)', () => {
    const translated = translateBetterAuthError(422, { message: 'Password too short', code: 'PASSWORD_TOO_SHORT' });
    assert.ok(translated);
    assert.equal(translated.productCode, 'invalid_request');
    assert.equal(translated.statusCode, 400);
    assert.equal(translated.message.includes('Password too short'), false);
  });

  test('a 429 without a code (BA rate-limit response shape) maps to rate_limited', () => {
    const translated = translateBetterAuthError(429, { message: 'Too many requests. Please try again later.' });
    assert.ok(translated);
    assert.equal(translated.productCode, 'rate_limited');
    assert.equal(translated.statusCode, 429);
  });

  test('product envelopes and non-JSON bodies pass through untouched', () => {
    assert.equal(translateBetterAuthError(404, { error: { code: 'resource_not_found', message: 'x' } }), null);
    assert.equal(translateBetterAuthError(401, null), null);
    assert.equal(translateBetterAuthError(401, 'plain text'), null);
    assert.equal(translateBetterAuthError(200, { code: 'INVALID_EMAIL_OR_PASSWORD' }), null, '2xx is never an error translation');
  });
});

describe('stripBetterAuthRawTokens: R9 response contract', () => {
  test('removes raw token fields recursively and preserves the rest of the shape', () => {
    const stripped = stripBetterAuthRawTokens({
      token: 'raw-token',
      user: { id: 'u1', email: 'a@example.test' },
      session: { id: 's1', token: 'raw-token-2', expiresAt: 'x', nested: { token: 'raw-token-3' } },
      list: [{ token: 'raw-token-4' }, { keep: true }],
    }) as { user: { email: string }; session: { id: string }; list: Array<{ keep: boolean }> };
    assert.equal('token' in stripped, false);
    assert.equal(stripped.user.email, 'a@example.test');
    assert.equal(stripped.session.id, 's1');
    assert.equal('token' in stripped.session, false);
    assert.equal((stripped.list[0] as { keep?: boolean }).keep, undefined);
    assert.equal(stripped.list[1]!.keep, true);
  });

  test('scalars, null and arrays of scalars are untouched', () => {
    assert.equal(stripBetterAuthRawTokens(null), null);
    assert.equal(stripBetterAuthRawTokens('abc'), 'abc');
    assert.deepEqual(stripBetterAuthRawTokens([1, 'two', null]), [1, 'two', null]);
  });
});

describe('mapAccountLinkingError: P7 distinct messages, same wire codes', () => {
  const invalidRequestCases: ReadonlyArray<{
    readonly code: Exclude<AccountLinkingErrorCode, 'reauth_failed'>;
    readonly message: string;
  }> = [
    { code: 'already_linked', message: 'This provider is already connected.' },
    { code: 'last_recovery_method', message: 'Keep at least one sign-in method.' },
    { code: 'invalid_callback_url', message: 'The return path is not allowed.' },
    { code: 'account_not_found', message: 'That sign-in method is not connected.' },
    { code: 'provider_not_configured', message: 'That sign-in provider is not available.' },
    { code: 'link_start_failed', message: 'We could not start connecting that provider. Try again.' },
  ];

  test('maps each AccountLinkingError code to a distinct product message without new enum members', () => {
    for (const item of invalidRequestCases) {
      const mapped = mapAccountLinkingError(new AccountLinkingError(item.code, 'internal detail must not leak'));
      assert.equal(mapped.statusCode, 400, item.code);
      assert.equal(mapped.productCode, 'invalid_request', item.code);
      assert.equal(mapped.message, item.message, item.code);
      assert.equal(mapped.message.includes('internal detail'), false, item.code);
    }
  });

  test('reauth_failed stays invalid_credentials with the existing credentials copy', () => {
    const mapped = mapAccountLinkingError(new AccountLinkingError('reauth_failed', 'the re-authentication proof is invalid'));
    assert.equal(mapped.statusCode, 401);
    assert.equal(mapped.productCode, 'invalid_credentials');
    assert.equal(mapped.message, 'The email or password is incorrect.');
  });

  test('authority failures stay authentication_required', () => {
    const mapped = mapAccountLinkingError(
      new BrowserSessionAuthenticationError('authentication_required', 'no session'),
    );
    assert.equal(mapped.productCode, 'authentication_required');
  });
});

describe('POST /api/v1/auth/unlink-account last recovery method (P7)', () => {
  test('unlink of the last method returns 400 invalid_request with the exact keep-one message', async () => {
    const csrfRaw = 'csrf-p7-raw-token';
    const actor: AuthenticatedBrowserActor = {
      account: {
        id: 'account-1',
        subjectId: 'subject-1',
        status: 'active',
        email: 'owner@example.test',
        securityEpoch: 0n,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
      },
      session: {
        id: 'session-1',
        accountId: 'account-1',
        idleExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
        absoluteExpiresAt: new Date('2026-01-31T00:00:00.000Z'),
        csrfTokenHash: hashSecret(csrfRaw),
        tokenHash: hashSecret('session-token'),
        securityEpoch: 0n,
        rotatedFromSessionId: null,
        lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
        revokedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    };
    const authority: BrowserSessionAuthority = {
      authenticate: async () => actor,
      requireMutationActor: async () => actor,
      bootstrap: async () => ({ authenticated: false }),
      signOut: async () => undefined,
      revokeAll: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
      revokeOthersKeepingCurrent: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
      listLiveSessions: async () => [],
      revokeSessionById: async () => ({ kind: 'not_found' }),
    };
    const accountLinking: AccountLinkingService = {
      beginProviderLink: async () => {
        throw new Error('beginProviderLink is unused in the last-recovery harness');
      },
      listLinkedProviders: async () => ({ accounts: [], hasPassword: true }),
      unlinkProvider: async () => {
        throw new AccountLinkingError('last_recovery_method', 'removing the last recovery method is not allowed');
      },
    };
    const identityUnitOfWork: IdentityUnitOfWork = {
      execute: async () => {
        throw new Error('identity unit of work is unused in the last-recovery harness');
      },
    };
    const config = loadConfig(enabledEnv({
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${TRUSTED_ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    }));
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      browserSessionAuthority: authority,
      accountLinking,
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/unlink-account',
        headers: {
          'content-type': 'application/json',
          origin: TRUSTED_ORIGIN,
          cookie: '__Host-known_session=test-session',
          'x-csrf-token': csrfRaw,
        },
        payload: JSON.stringify({
          providerId: 'google',
          accountId: 'google-sub-1',
          reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
        }),
      });
      assert.equal(response.statusCode, 400);
      const body = response.json() as { error?: { code?: string; message?: string } };
      assert.equal(body.error?.code, 'invalid_request');
      assert.equal(body.error?.message, 'Keep at least one sign-in method.');
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});

describe('POST /api/v1/auth/account/delete (P10)', () => {
  function deleteHarness(accountDeletion: AccountDeletionService) {
    const csrfRaw = 'csrf-p10-raw-token';
    const actor: AuthenticatedBrowserActor = {
      account: {
        id: 'account-1',
        subjectId: 'subject-1',
        status: 'active',
        email: 'owner@example.test',
        securityEpoch: 0n,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
      },
      session: {
        id: 'session-1',
        accountId: 'account-1',
        idleExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
        absoluteExpiresAt: new Date('2026-01-31T00:00:00.000Z'),
        csrfTokenHash: hashSecret(csrfRaw),
        tokenHash: hashSecret('session-token'),
        securityEpoch: 0n,
        rotatedFromSessionId: null,
        lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
        revokedAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    };
    const authority: BrowserSessionAuthority = {
      authenticate: async () => actor,
      requireMutationActor: async () => actor,
      bootstrap: async () => ({ authenticated: false }),
      signOut: async () => undefined,
      revokeAll: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
      revokeOthersKeepingCurrent: async () => ({ securityEpoch: 0n, revokedAuthSessions: 0, revokedLegacySessions: 0 }),
      listLiveSessions: async () => [],
      revokeSessionById: async () => ({ kind: 'not_found' }),
    };
    const identityUnitOfWork: IdentityUnitOfWork = {
      execute: async () => {
        throw new Error('identity unit of work is unused in the delete harness');
      },
    };
    const config = loadConfig(enabledEnv({
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${TRUSTED_ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    }));
    const app = buildApiApp({
      config,
      identityUnitOfWork,
      browserSessionAuthority: authority,
      accountDeletion,
    });
    return { app, csrfRaw, actor };
  }

  test('missing reauth is refused and the service is not called', async () => {
    const calls: unknown[] = [];
    const { app, csrfRaw } = deleteHarness({
      deleteAccount: async (input) => {
        calls.push(input);
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/account/delete',
        headers: {
          'content-type': 'application/json',
          origin: TRUSTED_ORIGIN,
          cookie: '__Host-known_session=test-session',
          'x-csrf-token': csrfRaw,
        },
        payload: JSON.stringify({ confirmation: 'DELETE' }),
      });
      assert.equal(response.statusCode, 400);
      const body = response.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, 'invalid_request');
      assert.equal(calls.length, 0);
    } finally {
      await app.close().catch(() => undefined);
    }
  });

  test('wrong confirmation is invalid_request and the service is not called', async () => {
    const calls: unknown[] = [];
    const { app, csrfRaw } = deleteHarness({
      deleteAccount: async (input) => {
        calls.push(input);
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/account/delete',
        headers: {
          'content-type': 'application/json',
          origin: TRUSTED_ORIGIN,
          cookie: '__Host-known_session=test-session',
          'x-csrf-token': csrfRaw,
        },
        payload: JSON.stringify({
          confirmation: 'please',
          reauth: { kind: 'password', password: 'password-123' }, // secret-scan: allow 'password-123'
        }),
      });
      assert.equal(response.statusCode, 400);
      const body = response.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, 'invalid_request');
      assert.equal(calls.length, 0);
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});

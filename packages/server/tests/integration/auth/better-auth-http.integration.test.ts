/**
 * Task E2: the FULL HTTP stack through the composed product app (plan §11
 * Task E2) — REAL betterAuth 1.7.1 (Argon2id + digest-only OTP + two-factor)
 * mounted through the A1/A4 transport contract inside buildApiApp, REAL
 * PostgreSQL, REAL controlled OAuth provider, REAL C1 mailbox, the REAL A3
 * authority and the product session/me/link/recovery routes.
 *
 * 假阴性防护:
 * - every success is proven by the REAL database rows AND a subsequent real
 *   request (cookie -> product /api/v1/session -> /api/v1/me -> CSRF
 *   mutation), never by a status code alone;
 * - the verification contract is behavioral: the verification email goes out
 *   at sign-up (sendOnSignUp) with a digest-only row, sign-in NEVER re-sends
 *   it (sendOnSignIn=false), and a forget-password OTP proof flips
 *   emailVerified (verified-email proof) with every existing session revoked;
 * - OTPs are read from the mailbox (never guessed) and the reset consumes
 *   the code; the old password stops working afterwards;
 * - MFA TOTP codes are computed from the DECRYPTED stored secret (RFC 6238)
 *   and the pending challenge is proven non-authenticating: HTTP sign-in
 *   returns twoFactorRedirect without a usable session cookie, and the TOTP
 *   completion is the REAL server API with asResponse -> REAL session cookie
 *   -> product session proof;
 * - the same-email OAuth login asserts the disableImplicitLinking contract
 *   (error=account_not_linked, no session, no provider row, no orphan auth
 *   user), and the explicit link runs the REAL product route (session +
 *   Origin/CSRF + re-auth proof) end to end.
 *
 * 假阳性防护:
 * - R9: no success body on the allowlisted surface may carry a raw `token`;
 * - pending endpoints (OTP/verification/MFA completion) must answer 404 from
 *   the REAL composed app — a full-surface mount would be a false positive;
 * - `known_test.` material never appears in any row the flows write.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hexToBytes, managedNonce } from '@noble/ciphers/utils.js';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildBetterAuthOptions,
  mountBetterAuthAllowlist,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
} from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import { createBetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import {
  createPostgresAccountDeletionStore,
  createPostgresBusinessAccountUnitOfWork,
} from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresCollectionPolicyRevisionPort } from '../../../src/infrastructure/collections/index.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME,
  BROWSER_SESSION_TRUST_DEVICE_COOKIE_NAME,
  authEmailIdempotencyKey,
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  createAccountLinkingService,
  createAccountRecoveryService,
  createAccountDeletionService,
  deriveBrowserSessionCsrfTokenRaw,
  otpIdentifierDigest,
  otpValueDigest,
  type BrowserSessionAuthority,
  type OAuthLinkServerPort,
  type ReauthVerifier,
  type RecoveryServerPort,
} from '../../../src/modules/auth/index.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import { applyBetterAuth17LibrarySchemaExpand } from '../../support/better-auth-postgres.js';
import { startControlledOAuthProvider, type ControlledOAuthProvider } from '../../support/auth-test-provider.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const SESSION_COOKIE_NAME = '__Host-known_session';
const MFA_COOKIE_NAME = BROWSER_SESSION_MFA_CHALLENGE_COOKIE_NAME;
const TRUST_DEVICE_COOKIE_NAME = BROWSER_SESSION_TRUST_DEVICE_COOKIE_NAME;
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const NEW_PASSWORD = 'new-password-456';
const MOCK_GOOGLE_CLIENT_ID = 'e2-google-client-id';
const MOCK_GOOGLE_CLIENT_SECRET = 'e2-google-client-secret'; // secret-scan: allow 'e2-google-client-secret'

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    BETTER_AUTH_OTP_TTL_SECONDS: '300',
    AUTH_RATE_LIMIT_MAX: '1000000',
    ...overrides,
  };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

/** RFC 6238 HOTP/TOTP + BA 1.7.1 symmetric-decrypt mirror (same as C4). */
function hotp(secret: Uint8Array, counter: number, digits = 6): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24)
    | (hmac[offset + 1]! << 16)
    | (hmac[offset + 2]! << 8)
    | hmac[offset + 3]!;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

function totpForCounter(secret: Uint8Array, counter: number): string {
  return hotp(secret, counter, 6);
}

function currentTotpCounter(periodSeconds = 30): number {
  return Math.floor(Date.now() / (periodSeconds * 1000));
}

/** Mirrors better-auth 1.7.1 `rawDecrypt` (xchacha20poly1305 + sha256 key). */
function baDecrypt(secret: string, hex: string): Uint8Array {
  const key = createHash('sha256').update(secret, 'utf8').digest();
  return managedNonce(xchacha20poly1305)(new Uint8Array(key)).decrypt(hexToBytes(hex));
}

function stripOrigin(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.pathname}${url.search}`;
}

describeWithPostgres('E2 better-auth-http: full HTTP stack through the composed product app (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let mock: ControlledOAuthProvider;
  let auth: ReturnType<typeof betterAuth>;
  let authority: BrowserSessionAuthority;
  let app: ReturnType<typeof buildApiApp>;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  let built: BetterAuthRuntimeConfig;
  let baSecret: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('e2_better_auth_http', {
      maxConnections: 12,
      applicationName: 'known-e2-better-auth-http-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');

    mock = await startControlledOAuthProvider({
      providerId: 'google',
      clientId: MOCK_GOOGLE_CLIENT_ID,
      clientSecret: MOCK_GOOGLE_CLIENT_SECRET,
      userinfo: { id: 'e2-google-sub', email: 'e2-google@example.test', email_verified: true, name: 'E2 Google' },
    });

    const config = loadConfig(testEnv());
    built = buildBetterAuthConfig({ ...config.betterAuth, mfa: { enabled: true } });
    assert.ok(built, 'enabled config must produce Better Auth settings');
    assert.ok(built.mfa, 'MFA must be enabled for the E2 HTTP suite');
    baSecret = built.secret;

    mailbox = createAuthTestMailbox();
    const sender = createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') });
    const businessUnitOfWork = createPostgresBusinessAccountUnitOfWork(isolated.runtime.db);

    const googleProvider = {
      providerId: 'google',
      clientId: MOCK_GOOGLE_CLIENT_ID,
      clientSecret: MOCK_GOOGLE_CLIENT_SECRET,
      authorizationUrl: `${mock.origin}/authorize`,
      tokenUrl: `${mock.origin}/token`,
      userInfoUrl: `${mock.origin}/userinfo`,
      scopes: ['email'],
      pkce: true,
    };
    const makeOptions = () => {
      const options = buildBetterAuthOptions({
        enabled: true,
        config: built,
        database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
        authEmail: sender,
        businessAccount: { unitOfWork: businessUnitOfWork },
        logger: createLogger('silent'),
      });
      options.plugins = [...(options.plugins ?? []), genericOAuth({ config: [googleProvider] })];
      return options;
    };

    const baOptions = makeOptions();
    // T-02 lands issuer on migrateToLatest; this expand is then a no-op.
    await applyBetterAuth17LibrarySchemaExpand(baOptions);
    auth = betterAuth(baOptions);
    authority = createBetterAuthSessionAuthority({
      db: isolated.runtime.db,
      betterAuth: createBetterAuthServerApi(auth),
      secret: built.secret,
      sessionExpiresInSeconds: built.sessionExpiresInSeconds,
      sessionTokenProtector: createBetterAuthSessionTokenProtector(built.sessionTokenProtection),
    });

    const linkServer: OAuthLinkServerPort = {
      async startLink({ cookie, providerId, callbackURL, errorCallbackURL }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const response = await auth.api.linkSocialAccount({
          headers,
          body: {
            provider: providerId,
            callbackURL,
            ...(errorCallbackURL === undefined ? {} : { errorCallbackURL }),
          },
          asResponse: true,
        });
        const body = (await response.json()) as { url?: string };
        if (typeof body.url !== 'string' || body.url.length === 0) {
          throw new Error('link start did not produce an authorization URL');
        }
        return { url: body.url, stateCookies: response.headers.getSetCookie() };
      },
      async listAccounts({ cookie }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const accounts = await auth.api.listUserAccounts({ headers });
        return accounts.map((account) => ({ providerId: account.providerId, accountId: account.accountId }));
      },
      async unlinkAccount({ cookie, providerId, accountId }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const accounts = await auth.api.listUserAccounts({ headers });
        const target = accounts.find((account) =>
          account.providerId === providerId && account.accountId === accountId);
        if (target === undefined) {
          throw new Error('unlink target is not linked to this session');
        }
        await auth.api.unlinkAccount({ headers, body: { accountId: target.id } });
      },
      async getUserEmail({ cookie }) {
        const headers = new Headers();
        if (cookie !== undefined) headers.set('cookie', cookie);
        const session = await auth.api.getSession({ headers });
        return session?.user?.email ?? null;
      },
    };

    const reauthVerifier: ReauthVerifier = {
      async verifyPassword({ cookie, password }) {
        try {
          const headers = new Headers();
          if (cookie !== undefined) headers.set('cookie', cookie);
          await auth.api.verifyPassword({ headers, body: { password } });
          return true;
        } catch {
          return false;
        }
      },
      async verifyOtp({ email, otp }) {
        try {
          await auth.api.checkVerificationOTP({ body: { email, type: 'email-verification', otp } });
          return true;
        } catch {
          return false;
        }
      },
    };

    const recoveryServer: RecoveryServerPort = {
      async requestPasswordReset({ email }) {
        await auth.api.requestPasswordReset({ body: { email } });
      },
      async resetPasswordWithEmailOtp({ email, otp, newPassword }) {
        await auth.api.resetPasswordEmailOTP({ body: { email, otp, password: newPassword } });
      },
    };

    const identityUnitOfWork = createPostgresIdentityUnitOfWork(isolated.runtime.db);
    app = buildApiApp({
      config,
      identityUnitOfWork,
      browserSessionAuthority: authority,
      betterAuthRuntime: { mount: (fastifyApp) => mountBetterAuthAllowlist(fastifyApp, auth, built) },
      accountLinking: createAccountLinkingService({
        authority,
        server: linkServer,
        reauth: reauthVerifier,
        productOrigin: TRUSTED_ORIGIN,
      }),
      accountRecovery: createAccountRecoveryService(recoveryServer),
      accountDeletion: createAccountDeletionService({
        authority,
        server: linkServer,
        reauth: reauthVerifier,
        // AUTH-03 made deletion atomic across product and auth state; use the
        // production store instead of a hand-rolled markDeleted/deleteUser pair.
        store: createPostgresAccountDeletionStore(isolated.runtime.db, {
          collectionPolicyRevisions: (transaction) => createPostgresCollectionPolicyRevisionPort(transaction),
        }),
        betterAuthUsers: {
          async getAuthUserId({ cookie }) {
            const headers = new Headers();
            if (cookie !== undefined) headers.set('cookie', cookie);
            const session = await auth.api.getSession({ headers });
            return session?.user?.id ?? null;
          },
        },
      }),
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await mock?.close();
    await isolated?.close();
  });

  // -------------------------------------------------------------------------
  // transport helpers
  // -------------------------------------------------------------------------

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `${BASE_PATH}${path}`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, ...headers },
      payload: JSON.stringify(body),
    });
  }

  function sessionCookieOf(res: { cookies?: unknown }): string | null {
    const cookies = (res.cookies ?? []) as Array<{ name: string; value: string }>;
    return cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value ?? null;
  }

  function mfaPendingCookieOf(res: { cookies?: unknown }): string | null {
    const cookies = (res.cookies ?? []) as Array<{ name: string; value: string }>;
    return cookies.find((cookie) => cookie.name === MFA_COOKIE_NAME)?.value ?? null;
  }

  function cookieHeader(name: string, value: string): string {
    return `${name}=${encodeURIComponent(value)}`;
  }

  async function userIdForEmail(email: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ id: string }>(
      `select id from "auth_users" where email = $1`, [email],
    );
    return result.rows[0]?.id ?? null;
  }

  async function accountIdForAuthUser(authUserId: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ account_id: string }>(
      `select account_id from auth_user_account_map where auth_user_id = $1`, [authUserId],
    );
    return result.rows[0]?.account_id ?? null;
  }

  /**
   * A3 product metadata row for a BA-native session cookie (the authority
   * NEVER authenticates a live BA session without metadata — orphan sessions
   * are rejected by design). Snapshots the CURRENT account epoch.
   */
  async function establishMetadata(sessionValue: string): Promise<string> {
    const token = sessionValue.slice(0, sessionValue.lastIndexOf('.'));
    const lookupHashes = createBetterAuthSessionTokenProtector(
      built.sessionTokenProtection,
    ).lookupHashes(token);
    const sessionRow = await isolated.runtime.pool.query<{ id: string; userId: string; token: string }>(
      `select id, "userId", token from auth_sessions where "tokenLookupHash" = any($1::text[])`,
      [lookupHashes],
    );
    assert.equal(sessionRow.rows.length, 1, 'the BA session row must exist for the issued cookie');
    assert.notEqual(sessionRow.rows[0]!.token, token, 'the raw bearer token must not be stored');
    const sessionId = sessionRow.rows[0]!.id;
    const authUserId = sessionRow.rows[0]!.userId;
    const accountId = await accountIdForAuthUser(authUserId);
    assert.ok(accountId, 'the A2 establishment must have mapped the auth user');
    const epochRow = await isolated.runtime.pool.query<{ security_epoch: string }>(
      `select security_epoch from accounts where id = $1`, [accountId],
    );
    assert.equal(epochRow.rowCount, 1);
    const securityEpoch = epochRow.rows[0]!.security_epoch;
    const now = new Date();
    await isolated.runtime.pool.query(
      `insert into known_auth_session_metadata (
        auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
        security_epoch, csrf_token_hash, predecessor_session_id, last_seen_at, revoked_at, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,NULL,$8,NULL,$9)
       on conflict (auth_session_id) do nothing`,
      [
        sessionId,
        browserSessionTokenHash(token),
        accountId,
        new Date(now.getTime() + 86_400_000),
        new Date(now.getTime() + 30 * 86_400_000),
        securityEpoch,
        browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)),
        now,
        now,
      ],
    );
    return accountId;
  }

  async function bootstrapSession(cookieValue: string): Promise<{ readonly csrfToken: string; readonly accountId: string }> {
    const value = decodeURIComponent(cookieValue);
    const accountId = await establishMetadata(value);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(SESSION_COOKIE_NAME, value) },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { authenticated?: boolean; csrfToken?: string };
    assert.equal(body.authenticated, true, 'the product session must authenticate the cookie');
    assert.ok(body.csrfToken, 'bootstrap must return the product CSRF token');
    return { csrfToken: body.csrfToken!, accountId };
  }

  async function signUp(email: string, password = PASSWORD) {
    return post('/sign-up/email', { name: 'E2 User', email, password });
  }

  function get(path: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'GET',
      url: `${BASE_PATH}${path}`,
      headers: { origin: TRUSTED_ORIGIN, ...headers },
    });
  }

  async function verifyMailbox(email: string): Promise<void> {
    const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
    assert.ok(mail, `no verification email was delivered to ${email}`);
    const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'the verification email must carry the JWT');
    const verify = await get(`/verify-email?token=${token}`);
    assert.equal(verify.statusCode, 200, 'mailbox verification must succeed');
    const autoCookie = sessionCookieOf(verify);
    if (autoCookie !== null && autoCookie !== '') {
      await signOut(autoCookie);
    }
  }

  async function signUpVerified(email: string, password = PASSWORD): Promise<{
    readonly cookie: string;
  }> {
    const signup = await signUp(email, password);
    assert.equal(signup.statusCode, 200);
    await verifyMailbox(email);
    const signin = await signIn(email, password);
    assert.equal(signin.statusCode, 200, 'verified password sign-in must issue a session');
    const cookie = sessionCookieOf(signin);
    assert.ok(cookie, 'verified sign-in must set the session cookie');
    return { cookie };
  }

  async function signIn(email: string, password = PASSWORD) {
    return post('/sign-in/email', { email, password });
  }

  async function signOut(cookieValue: string) {
    return post('/sign-out', {}, { cookie: cookieHeader(SESSION_COOKIE_NAME, cookieValue) });
  }

  async function changePassword(cookieValue: string, newPassword: string, currentPassword = PASSWORD) {
    // BA 1.7.1 change-password requires currentPassword + newPassword.
    return post('/change-password', { currentPassword, newPassword }, { cookie: cookieHeader(SESSION_COOKIE_NAME, cookieValue) });
  }

  function otpFor(email: string, purpose: 'otp:forget-password' | 'otp:sign-in'): string {
    const otp = mailbox.otpFor({ email, purpose });
    assert.ok(otp, `no ${purpose} OTP was delivered to ${email}`);
    return otp;
  }

  /** Full provider flow: start over the bridge -> controlled authorize -> callback. */
  async function oauthFlow(input: {
    readonly providerId: string;
    readonly callbackURL: string;
    readonly errorCallbackURL?: string;
    readonly extraCookies?: string;
  }): Promise<{ readonly statusCode: number; readonly location: string | null; readonly setCookies: readonly string[] }> {
    const start = await post('/sign-in/social', {
      provider: input.providerId,
      callbackURL: input.callbackURL,
      ...(input.errorCallbackURL === undefined ? {} : { errorCallbackURL: input.errorCallbackURL }),
    }, input.extraCookies === undefined ? {} : { cookie: input.extraCookies });
    assert.equal(start.statusCode, 200, 'the OAuth start must succeed over the bridge');
    const startBody = start.json() as { url?: string };
    assert.ok(startBody.url, 'the OAuth start must return the provider authorization URL');

    const providerResponse = await fetch(startBody.url!, { redirect: 'manual' });
    assert.equal(providerResponse.status, 302);
    const callbackUrl = String(providerResponse.headers.get('location') ?? '');
    assert.ok(callbackUrl.includes('/api/v1/auth/callback/'),
      'the provider must redirect to the Know-N callback');
    // The BA OAuth start sets the state cookie on the response; the callback
    // MUST carry it (the state check is part of the real flow).
    const stateCookies = (start.cookies ?? []).map((item: { name: string; value: string }) =>
      `${item.name}=${encodeURIComponent(item.value)}`);
    const callbackCookie = [input.extraCookies, stateCookies.join('; ')].filter(Boolean).join('; ');
    const callback = await app.inject({
      method: 'GET',
      url: stripOrigin(callbackUrl),
      headers: callbackCookie === '' ? {} : { cookie: callbackCookie },
    });
    return {
      statusCode: callback.statusCode,
      location: callback.headers.location ?? null,
      setCookies: (callback.cookies ?? []).map((item: { name: string; value: string }) => `${item.name}=${item.value}`),
    };
  }

  /** Plugin server APIs are not inferred through ReturnType<typeof betterAuth>; typed structural cast. */
  const twoFactorApi = () => (auth.api as unknown as {
    readonly enableTwoFactor: (input: {
      readonly body: { readonly password: string };
      readonly headers?: Headers;
    }) => Promise<{ totpURI?: string; backupCodes?: string[] }>;
    readonly verifyTOTP: (input: {
      readonly body: { readonly code: string; readonly trustDevice?: boolean };
      readonly headers?: Headers;
      readonly asResponse?: boolean;
    }) => Promise<Response>;
  });

  // -------------------------------------------------------------------------
  // tests
  // -------------------------------------------------------------------------

  test('local lifecycle over HTTP: sign-up, verification contract, OTP reset proof, sign-in, session/me, CSRF mutation, change-password, logout', async () => {
    const email = uniqueEmail('http-lifecycle');
    mailbox.setTestId('lifecycle');

    // --- sign-up: 2xx, R9 (no raw token in the body), no product session ---
    const signup = await signUp(email);
    assert.equal(signup.statusCode, 200);
    const signupBody = JSON.parse(signup.body) as { token?: unknown; user?: { email?: string } };
    assert.equal('token' in signupBody, false, 'R9: the sign-up body must never carry the raw session token');
    assert.equal(signupBody.user?.email, email);
    const signupCookie = sessionCookieOf(signup);
    assert.equal(signupCookie, null, 'password sign-up must not issue a product session while unverified');

    const pendingSession = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.deepEqual(pendingSession.json(), { authenticated: false });

    // --- verification email delivered at sign-up (sendOnSignUp); the token is
    // digest-only and sign-in never re-sends it (sendOnSignIn=false) ---
    const verificationMail = mailbox.lastMailFor({ email, purpose: 'email-verification', testId: 'lifecycle' });
    assert.ok(verificationMail, 'the verification email must be delivered at sign-up');
    const userId = await userIdForEmail(email);
    assert.ok(userId, 'sign-up must create the auth user');
    const accountId = await accountIdForAuthUser(userId);
    assert.ok(accountId);
    const account = await isolated.runtime.pool.query<{ email: string | null }>(
      `select email from accounts where id = $1`, [accountId],
    );
    assert.equal(account.rows[0]?.email, null, 'an unverified email must not be stored on the business account');

    // --- the verification contract continues: digest-only rows, unverified
    // password sign-in is EMAIL_NOT_VERIFIED (wire verification_required) and
    // never re-sends the mail (sendOnSignIn=false) ---
    const tokenInMail = verificationMail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(tokenInMail, 'the verification email must carry the JWT');
    const verificationRows = await isolated.runtime.pool.query<{ identifier: string; value: string }>(
      `select identifier, value from auth_verifications`,
    );
    for (const row of verificationRows.rows) {
      assert.notEqual(row.identifier, tokenInMail, 'the verification token must never be stored in plaintext');
      assert.notEqual(row.value, tokenInMail, 'the verification token must never be stored in plaintext (value)');
    }

    const unverifiedSignIn = await signIn(email);
    assert.equal(unverifiedSignIn.statusCode, 403, 'unverified password sign-in must be verification_required');
    assert.equal((unverifiedSignIn.json() as { error: { code: string } }).error.code, 'verification_required');
    assert.equal(sessionCookieOf(unverifiedSignIn), null, 'unverified sign-in must not issue a session cookie');
    const verificationMailKey = authEmailIdempotencyKey('email-verification', email);
    assert.equal(
      mailbox.entries.filter((entry) => entry.to === email && entry.idempotencyKey === verificationMailKey).length,
      1,
      'sign-in must never re-send the verification email (sendOnSignIn=false)',
    );

    // --- non-enumerating reset request over the product recovery route ---
    const resetRequest = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/password-reset',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email }),
    });
    assert.equal(resetRequest.statusCode, 200);
    assert.deepEqual(resetRequest.json(), { status: true });
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/password-reset',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email: uniqueEmail('ghost') }),
    });
    assert.deepEqual(ghost.json(), resetRequest.json(), 'unknown email must receive the identical success shape');

    // --- OTP reset over HTTP: mailbox OTP -> verified email -> new password ---
    await auth.api.sendVerificationOTP({ body: { email, type: 'forget-password' } });
    const otp = otpFor(email, 'otp:forget-password');
    // Digest-only OTP row: identifier and value are digests, never the code.
    const otpRow = await isolated.runtime.pool.query<{ identifier: string; value: string }>(
      `select identifier, value from auth_verifications where identifier = $1`,
      [otpIdentifierDigest('forget-password', email)],
    );
    assert.equal(otpRow.rows.length, 1, 'the OTP row must exist under the digest identifier');
    assert.equal(otpRow.rows[0]!.value, otpValueDigest(otp, 0), 'the stored value must be the code digest');
    assert.equal(otpRow.rows[0]!.identifier.includes(email), false, 'the digest identifier never contains the email');

    const otpReset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/otp-reset',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, otp, newPassword: NEW_PASSWORD }),
    });
    assert.equal(otpReset.statusCode, 200, 'the verified-email OTP reset must succeed over HTTP');
    assert.deepEqual(otpReset.json(), { status: true });
    const verified = await isolated.runtime.pool.query<{ emailVerified: boolean }>(
      `select "emailVerified" from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verified.rows[0]?.emailVerified, true, 'a forget-password OTP is a verified-email proof');
    const otpRowAfter = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_verifications where identifier = $1`,
      [otpIdentifierDigest('forget-password', email)],
    );
    assert.equal(otpRowAfter.rows[0]?.n, 0, 'the OTP proof must consume the code row');

    // --- the old password is dead, the new one signs in ---
    const oldAttempt = await signIn(email, PASSWORD);
    assert.equal(oldAttempt.statusCode, 401);
    assert.equal((oldAttempt.json() as { error: { code: string } }).error.code, 'invalid_credentials');
    const fresh = await signIn(email, NEW_PASSWORD);
    assert.equal(fresh.statusCode, 200);
    const freshBody = JSON.parse(fresh.body) as { token?: unknown };
    assert.equal('token' in freshBody, false, 'R9: the sign-in body must never carry the raw session token');
    const cookie = sessionCookieOf(fresh);
    assert.ok(cookie, 'the verified sign-in must set the session cookie');

    // --- product session/me + CSRF mutation ---
    const session = await bootstrapSession(cookie);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(SESSION_COOKIE_NAME, cookie) },
    });
    assert.equal(me.statusCode, 200);
    const meBody = me.json() as { profile: { displayName: string } };
    assert.equal(meBody.profile.displayName, 'E2 User');
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: {
        cookie: cookieHeader(SESSION_COOKIE_NAME, cookie),
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': session.csrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174111',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ handle: 'e2_lifecycle', displayName: 'E2 Updated' }),
    });
    assert.equal(patch.statusCode, 200);
    assert.equal((patch.json() as { profile: { displayName: string } }).profile.displayName, 'E2 Updated');

    // --- change-password over the registered BA endpoint (the current
    // password at this point is NEW_PASSWORD from the OTP reset) ---
    const changed = await changePassword(cookie, NEW_PASSWORD + '-2', NEW_PASSWORD);
    assert.equal(changed.statusCode, 200);
    const changedCookie = sessionCookieOf(changed);
    assert.ok(changedCookie, 'change-password must mint a successor cookie');
    const oldNow = await signIn(email, NEW_PASSWORD);
    assert.equal(oldNow.statusCode, 401, 'the previous password must stop working after change-password');
    const relogin = await signIn(email, NEW_PASSWORD + '-2');
    assert.equal(relogin.statusCode, 200);
    const reloginCookie = sessionCookieOf(relogin);
    assert.ok(reloginCookie);
    // Drop every session minted by change-password / relogin so the final
    // logout assertion can require ZERO remaining rows.
    await signOut(cookie);
    if (changedCookie !== cookie) {
      await signOut(changedCookie);
    }

    // --- logout: BA sign-out revokes the real session and the product surface closes ---
    await establishMetadata(decodeURIComponent(reloginCookie));
    const logout = await signOut(reloginCookie);
    assert.equal(logout.statusCode, 200);
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(SESSION_COOKIE_NAME, reloginCookie) },
    });
    assert.deepEqual(after.json(), { authenticated: false });
    const meAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHeader(SESSION_COOKIE_NAME, reloginCookie) },
    });
    assert.equal(meAfter.statusCode, 401);
    const sessionCount = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_sessions where "userId" = $1`, [userId],
    );
    assert.equal(sessionCount.rows[0]?.n, 0, 'sign-out must delete every session row of the user');
  });

  test('duplicate and concurrent sign-up converge on one user with no secret leakage', async () => {
    const email = uniqueEmail('http-concurrent');
    mailbox.setTestId('concurrent');

    const [first, second] = await Promise.all([signUp(email), signUp(email)]);
    const statuses = [first.statusCode, second.statusCode].sort();
    assert.equal(statuses[0], 200, 'at least one concurrent sign-up must succeed');
    // requireEmailVerification returns a non-enumerating 200 synthetic user
    // for the loser; a UNIQUE-email race may still surface as 400/401.
    assert.ok(statuses[1] === 200 || statuses[1] === 400 || statuses[1] === 401 || statuses[1] === 422,
      `the concurrent loser must be 200 synthetic or refused (got ${statuses.join(',')})`);
    for (const res of [first, second]) {
      const body = res.json() as { error?: { code: string }; user?: { email: string } };
      if (res.statusCode !== 200) {
        assert.ok(body.error?.code === 'invalid_credentials' || body.error?.code === 'invalid_request',
          `the loser error must be a stable product code (got ${body.error?.code})`);
        assert.equal(res.body.includes(email), false, 'the duplicate sign-up error must not echo the email');
      }
      if (res.statusCode === 200) {
        assert.equal('token' in body, false, 'R9: no raw token in the sign-up body');
      }
    }

    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const users = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n from "auth_users" where email = $1`, [email]);
    assert.equal(users.rows[0]?.n, 1, 'concurrent sign-up must converge on ONE auth user');
    const mappings = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_user_account_map where auth_user_id = $1`, [userId],
    );
    assert.equal(mappings.rows[0]?.n, 1, 'concurrent sign-up must converge on ONE mapping');
    const accounts = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from accounts a
        join auth_user_account_map m on m.account_id = a.id where m.auth_user_id = $1`, [userId],
    );
    assert.equal(accounts.rows[0]?.n, 1, 'concurrent sign-up must converge on ONE business account');
  });

  test('wrong-account CSRF and logout isolation across two sessions', async () => {
    const emailA = uniqueEmail('http-a');
    const emailB = uniqueEmail('http-b');
    mailbox.setTestId('isolation');

    const { cookie: cookieA } = await signUpVerified(emailA);
    const { cookie: cookieB } = await signUpVerified(emailB);
    assert.ok(cookieA && cookieB);

    const sessionA = await bootstrapSession(cookieA);
    const sessionB = await bootstrapSession(cookieB);
    assert.notEqual(sessionA.accountId, sessionB.accountId, 'two users must never share a business account');

    // A's cookie with B's CSRF must fail (wrong account).
    const foreign = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: {
        cookie: cookieHeader(SESSION_COOKIE_NAME, cookieA),
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': sessionB.csrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174222',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ handle: 'e2_isolation', displayName: 'Wrong' }),
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal((foreign.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // A logs out; B's session must survive (isolation).
    await signOut(cookieA);
    const aAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(SESSION_COOKIE_NAME, cookieA) },
    });
    assert.deepEqual(aAfter.json(), { authenticated: false });
    const bAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(SESSION_COOKIE_NAME, cookieB) },
    });
    assert.equal((bAfter.json() as { authenticated?: boolean }).authenticated, true,
      'logging out one account must never revoke another account session');
  });

  test('MFA: HTTP pending challenge over the composed app, TOTP completion, encrypted-at-rest row, pending endpoints 404', async () => {
    const email = uniqueEmail('http-mfa');
    mailbox.setTestId('mfa');
    const { cookie } = await signUpVerified(email);
    await establishMetadata(decodeURIComponent(cookie));

    // Enrollment runs through the REAL server API (the HTTP surface stays
    // gated: /two-factor/* is pending -> 404 from the composed app).
    const pending404 = await post('/two-factor/enable', { password: PASSWORD }, { cookie: cookieHeader(SESSION_COOKIE_NAME, cookie) });
    assert.equal(pending404.statusCode, 404, 'the pending MFA surface must not be mounted over HTTP');
    assert.match(pending404.body, /resource_not_found/u);

    const enroll = await twoFactorApi().enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie: cookieHeader(SESSION_COOKIE_NAME, cookie) }),
    });
    assert.ok(enroll.totpURI?.startsWith('otpauth://totp/'), 'enrollment must produce the TOTP URI');
    assert.ok(Array.isArray(enroll.backupCodes) && enroll.backupCodes.length === 10);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const row = await isolated.runtime.pool.query<{ secret: string; backupCodes: string }>(
      `select secret, "backupCodes" from auth_two_factor where "userId" = $1`, [userId],
    );
    assert.equal(row.rows.length, 1);
    assert.match(row.rows[0]!.secret, /^[0-9a-f]+$/u, 'the stored TOTP secret must be encrypted at rest');
    assert.equal(row.rows[0]!.secret.includes(enroll.backupCodes[0]!), false);
    assert.equal(row.rows[0]!.backupCodes.includes(enroll.backupCodes[0]!), false,
      'backup codes must be encrypted, never plaintext JSON');
    const secret = Buffer.from(baDecrypt(baSecret, row.rows[0]!.secret));
    assert.equal(secret.length, 32);

    // First TOTP verification enables the flag (enrollment proof).
    await twoFactorApi().verifyTOTP({
      body: { code: totpForCounter(secret, currentTotpCounter(30)) },
      headers: new Headers({ cookie: cookieHeader(SESSION_COOKIE_NAME, cookie) }),
    });
    const flag = await isolated.runtime.pool.query<{ twoFactorEnabled: boolean }>(
      `select "twoFactorEnabled" from auth_users where id = $1`, [userId],
    );
    assert.equal(flag.rows[0]?.twoFactorEnabled, true);

    // Sign-out, then the HTTP sign-in enters the pending challenge.
    await signOut(cookie);
    const challenge = await signIn(email);
    assert.equal(challenge.statusCode, 200);
    const challengeBody = challenge.json() as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    assert.equal(challengeBody.twoFactorRedirect, true, '2FA-enabled sign-in must enter the pending challenge');
    assert.deepEqual(challengeBody.twoFactorMethods, ['totp']);
    const pending = mfaPendingCookieOf(challenge);
    assert.ok(pending, 'the pending challenge cookie must be set');
    // BA clears any prior session cookie with an EMPTY-value cookie during
    // the challenge — an empty value is not a usable session credential.
    const challengeSessionValue = sessionCookieOf(challenge);
    assert.equal(challengeSessionValue === null || challengeSessionValue === '', true,
      'no usable session cookie may be issued during the challenge');

    // The pending cookie never authenticates the product surface.
    const pendingSession = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(MFA_COOKIE_NAME, pending) },
    });
    assert.deepEqual(pendingSession.json(), { authenticated: false });

    // TOTP completion through the REAL server API with the pending cookie:
    // asResponse gives the REAL session cookie BA would set over HTTP.
    const completed = await twoFactorApi().verifyTOTP({
      body: { code: totpForCounter(secret, currentTotpCounter(30)) },
      headers: new Headers({ cookie: cookieHeader(MFA_COOKIE_NAME, pending) }),
      asResponse: true,
    });
    assert.equal(completed.status, 200);
    const issuedCookieValue = completed.headers.getSetCookie()
      .map((item) => item.split(';', 1)[0] ?? '')
      .find((item) => item.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1);
    assert.ok(issuedCookieValue, 'a valid TOTP must issue the session cookie');
    const issuedCookie = cookieHeader(SESSION_COOKIE_NAME, decodeURIComponent(issuedCookieValue));

    // The TOTP-minted session authenticates the product surface.
    await establishMetadata(decodeURIComponent(issuedCookieValue));
    const productSession = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: issuedCookie },
    });
    const productBody = productSession.json() as { authenticated?: boolean };
    assert.equal(productBody.authenticated, true, 'the TOTP-completed session must authenticate the product surface');

    // A replayed pending challenge is refused even with a fresh valid code.
    const challenge2 = await signIn(email);
    const pending2 = mfaPendingCookieOf(challenge2);
    assert.ok(pending2);
    const replayed = await twoFactorApi().verifyTOTP({
      body: { code: totpForCounter(secret, currentTotpCounter(30)) },
      headers: new Headers({ cookie: cookieHeader(MFA_COOKIE_NAME, pending2) }),
      asResponse: true,
    });
    assert.equal(replayed.status, 200, 'the first use of the fresh challenge succeeds');
    const replayed2 = await twoFactorApi().verifyTOTP({
      body: { code: totpForCounter(secret, currentTotpCounter(30)) },
      headers: new Headers({ cookie: cookieHeader(MFA_COOKIE_NAME, pending2) }),
      asResponse: true,
    });
    assert.equal(replayed2.status, 401);
  });

  test('P5: HTTP change-password expires trust-device so a copied cookie cannot skip TOTP', async () => {
    const email = uniqueEmail('http-mfa-trust');
    mailbox.setTestId('mfa-trust');
    const { cookie } = await signUpVerified(email);
    await establishMetadata(decodeURIComponent(cookie));
    const userId = await userIdForEmail(email);
    assert.ok(userId);

    const enroll = await twoFactorApi().enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie: cookieHeader(SESSION_COOKIE_NAME, cookie) }),
    });
    assert.ok(enroll.totpURI?.startsWith('otpauth://totp/'));
    const row = await isolated.runtime.pool.query<{ secret: string }>(
      `select secret from auth_two_factor where "userId" = $1`, [userId],
    );
    const secret = Buffer.from(baDecrypt(baSecret, row.rows[0]!.secret));
    await twoFactorApi().verifyTOTP({
      body: { code: totpForCounter(secret, currentTotpCounter(30)) },
      headers: new Headers({ cookie: cookieHeader(SESSION_COOKIE_NAME, cookie) }),
    });

    await signOut(cookie);
    const challenge = await signIn(email);
    const pending = mfaPendingCookieOf(challenge);
    assert.ok(pending);
    const trusted = await twoFactorApi().verifyTOTP({
      body: { code: totpForCounter(secret, currentTotpCounter(30)), trustDevice: true },
      headers: new Headers({ cookie: cookieHeader(MFA_COOKIE_NAME, pending) }),
      asResponse: true,
    });
    assert.equal(trusted.status, 200);
    const setCookies = trusted.headers.getSetCookie();
    const trustPair = setCookies
      .map((item) => item.split(';', 1)[0] ?? '')
      .find((item) => item.startsWith(`${TRUST_DEVICE_COOKIE_NAME}=`));
    assert.ok(trustPair, 'trustDevice must set known.trust_device');
    const trustValue = decodeURIComponent(trustPair.slice(TRUST_DEVICE_COOKIE_NAME.length + 1));
    assert.ok(trustValue.length > 0);
    const issuedSession = setCookies
      .map((item) => item.split(';', 1)[0] ?? '')
      .find((item) => item.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1);
    assert.ok(issuedSession);

    await signOut(decodeURIComponent(issuedSession));
    const skippedWithTrust = await post('/sign-in/email', { email, password: PASSWORD }, {
      cookie: cookieHeader(TRUST_DEVICE_COOKIE_NAME, trustValue),
    });
    const skippedBody = skippedWithTrust.json() as { twoFactorRedirect?: boolean };
    assert.notEqual(skippedBody.twoFactorRedirect, true, 'precondition: trusted sign-in must skip TOTP');
    const skippedSession = sessionCookieOf(skippedWithTrust);
    assert.ok(skippedSession, 'precondition: trusted sign-in must issue a session');

    const changed = await changePassword(skippedSession, NEW_PASSWORD);
    assert.equal(changed.statusCode, 200);
    const successor = sessionCookieOf(changed);
    assert.ok(successor, 'the current successor session must still be issued');
    const expiredTrust = (changed.cookies ?? []) as Array<{ name: string; value: string; maxAge?: number }>;
    const expired = expiredTrust.find((cookie) => cookie.name === TRUST_DEVICE_COOKIE_NAME);
    const raw = changed.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    const expiredHeader = list.some((entry) => typeof entry === 'string'
      && /^known\.trust_device=/i.test(entry)
      && /max-age=0/i.test(entry));
    assert.equal(
      expiredHeader || expired?.maxAge === 0 || expired?.value === '',
      true,
      'change-password must Set-Cookie Max-Age=0 on known.trust_device',
    );

    const flag = await isolated.runtime.pool.query<{ twoFactorEnabled: boolean }>(
      `select "twoFactorEnabled" from auth_users where id = $1`, [userId],
    );
    assert.equal(flag.rows[0]?.twoFactorEnabled, true, 'password change must not disable 2FA');
    const leftover = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_verifications where value = $1`, [userId],
    );
    assert.equal(leftover.rows[0]!.n, 0, 'trust-device verification rows must be gone');

    const again = await post('/sign-in/email', { email, password: NEW_PASSWORD }, {
      cookie: cookieHeader(TRUST_DEVICE_COOKIE_NAME, trustValue),
    });
    const againBody = again.json() as { twoFactorRedirect?: boolean; twoFactorMethods?: string[] };
    assert.equal(againBody.twoFactorRedirect, true, 'a copied trust cookie must not skip TOTP after password change');
    assert.deepEqual(againBody.twoFactorMethods, ['totp']);
    const againSession = sessionCookieOf(again);
    assert.equal(againSession === null || againSession === '', true, 'no usable session until TOTP');
  });

  test('OAuth same-email non-link stays account-not-linked; explicit link + unlink work through the product routes', async () => {
    const email = uniqueEmail('http-oauth');
    mailbox.setTestId('oauth');
    const googleId = `e2-sub-${randomUUID().slice(0, 8)}`;
    mock.setUserinfo({ id: googleId, email, email_verified: true, name: 'OAuth Same' });

    const { cookie } = await signUpVerified(email);
    const session = await bootstrapSession(cookie);
    const localUserId = await userIdForEmail(email);
    assert.ok(localUserId);

    // Same-email provider login: refused by disableImplicitLinking.
    const flow = await oauthFlow({ providerId: 'google', callbackURL: '/dashboard', errorCallbackURL: '/error' });
    assert.ok(flow.location?.includes('error=account_not_linked'), `location=${flow.location}`);
    assert.equal(flow.setCookies.some((item) => item.startsWith(`${SESSION_COOKIE_NAME}=`)), false,
      'the same-email callback must not issue a session cookie');
    const providerRows = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_accounts where "userId" = $1 and "providerId" = 'google'`, [localUserId],
    );
    assert.equal(providerRows.rows[0]?.n, 0, 'the same-email callback must not create a provider row');
    const userCount = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_users" where email = $1`, [email],
    );
    assert.equal(userCount.rows[0]?.n, 1, 'the same-email callback must not create an orphan auth user');

    // Explicit link through the product route (session + CSRF + password re-auth).
    const link = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth2/link',
      headers: {
        cookie: cookieHeader(SESSION_COOKIE_NAME, cookie),
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        providerId: 'google',
        callbackURL: '/settings',
        reauth: { kind: 'password', password: PASSWORD },
      }),
    });
    assert.equal(link.statusCode, 200, 'the explicit link start must succeed');
    const linkBody = link.json() as { url?: string; redirect?: boolean };
    assert.equal(linkBody.redirect, true);
    assert.ok(linkBody.url, 'the link start must return the provider authorization URL');
    const stateCookies = (link.cookies ?? []).map((item: { name: string; value: string }) =>
      `${item.name}=${encodeURIComponent(item.value)}`);

    const providerResponse = await fetch(linkBody.url!, { redirect: 'manual' });
    assert.equal(providerResponse.status, 302);
    const location = providerResponse.headers.get('location');
    assert.ok(location);
    const callback = await app.inject({
      method: 'GET',
      url: stripOrigin(location),
      headers: { cookie: stateCookies.join('; ') },
    });
    assert.notEqual(callback.statusCode, 404);
    assert.ok((callback.headers.location ?? '').startsWith('/settings'),
      `the linked callback must redirect to the allowlisted callbackURL, got ${callback.headers.location}`);

    const providerRowsAfter = await isolated.runtime.pool.query<{ "providerId": string; "accountId": string }>(
      `select "providerId", "accountId" from auth_accounts where "userId" = $1 order by "providerId"`, [localUserId],
    );
    assert.deepEqual(
      providerRowsAfter.rows,
      [
        { providerId: 'credential', accountId: localUserId },
        { providerId: 'google', accountId: googleId },
      ],
      'the explicit link must create the provider row for the SAME auth user',
    );

    // Unlink through the product route (session + CSRF + re-auth).
    const unlink = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/unlink-account',
      headers: {
        cookie: cookieHeader(SESSION_COOKIE_NAME, cookie),
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        providerId: 'google',
        accountId: googleId,
        reauth: { kind: 'password', password: PASSWORD },
      }),
    });
    assert.equal(unlink.statusCode, 200);
    assert.deepEqual(unlink.json(), { status: true });
    const providerRowsAfterUnlink = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_accounts where "userId" = $1 and "providerId" = 'google'`, [localUserId],
    );
    assert.equal(providerRowsAfterUnlink.rows[0]?.n, 0, 'unlink must remove the provider row');
  });

  test('P10: verified password user deletes; old cookie is dead; same email signs up as a new user', async () => {
    const email = uniqueEmail('http-delete');
    mailbox.setTestId('delete');
    const { cookie } = await signUpVerified(email);
    const session = await bootstrapSession(cookie);
    const oldUserId = await userIdForEmail(email);
    assert.ok(oldUserId);
    const oldAccountId = await accountIdForAuthUser(oldUserId);
    assert.ok(oldAccountId);

    const cookieHdr = cookieHeader(SESSION_COOKIE_NAME, cookie);
    const missingReauth = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/account/delete',
      headers: {
        cookie: cookieHdr,
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ confirmation: 'DELETE' }),
    });
    assert.ok(missingReauth.statusCode === 400 || missingReauth.statusCode === 401);
    const missingCode = (missingReauth.json() as { error?: { code?: string } }).error?.code;
    assert.ok(missingCode === 'invalid_request' || missingCode === 'invalid_credentials');

    const wrongConfirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/account/delete',
      headers: {
        cookie: cookieHdr,
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        confirmation: 'please',
        reauth: { kind: 'password', password: PASSWORD },
      }),
    });
    assert.equal(wrongConfirm.statusCode, 400);
    assert.equal((wrongConfirm.json() as { error?: { code?: string } }).error?.code, 'invalid_request');
    const stillActive = await isolated.runtime.pool.query<{ status: string; email: string | null }>(
      `select status, email from accounts where id = $1`, [oldAccountId],
    );
    assert.equal(stillActive.rows[0]?.status, 'active');

    const deleted = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/account/delete',
      headers: {
        cookie: cookieHdr,
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': session.csrfToken,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        confirmation: 'DELETE',
        reauth: { kind: 'password', password: PASSWORD },
      }),
    });
    assert.equal(deleted.statusCode, 200);
    const deletedBody = deleted.json() as Record<string, unknown>;
    assert.deepEqual(deletedBody, { status: true });
    assert.equal('token' in deletedBody, false, 'R9: delete must not echo a session token');

    const productSession = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHdr },
    });
    assert.equal(productSession.statusCode, 200);
    assert.deepEqual(productSession.json(), { authenticated: false });

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieHdr },
    });
    assert.equal(me.statusCode, 401);
    assert.equal((me.json() as { error?: { code?: string } }).error?.code, 'authentication_required');

    const baSession = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/get-session?disableRefresh=true`,
      headers: { cookie: cookieHdr, origin: TRUSTED_ORIGIN },
    });
    assert.equal(baSession.statusCode, 200);
    assert.equal(baSession.body === 'null' || JSON.parse(baSession.body) === null, true);

    const accountRow = await isolated.runtime.pool.query<{ status: string; email: string | null; deleted_at: Date | null }>(
      `select status, email, deleted_at from accounts where id = $1`, [oldAccountId],
    );
    assert.equal(accountRow.rows[0]?.status, 'deleted');
    assert.equal(accountRow.rows[0]?.email, null);
    assert.ok(accountRow.rows[0]?.deleted_at instanceof Date);

    const oldPassword = await post('/sign-in/email', { email, password: PASSWORD });
    assert.notEqual(oldPassword.statusCode, 200);
    const oldOtpSend = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    assert.equal(oldOtpSend.statusCode, 200);
    const otpMail = mailbox.lastMailFor({ email, purpose: 'otp:sign-in', testId: 'delete' });
    if (otpMail) {
      const otp = otpMail.textBody.match(/\b\d{6}\b/u)?.[0];
      if (otp) {
        const otpSignIn = await post('/sign-in/email-otp', { email, otp });
        assert.notEqual(otpSignIn.statusCode, 200);
      }
    }

    const signupAgain = await signUp(email);
    assert.equal(signupAgain.statusCode, 200);
    await verifyMailbox(email);
    const newUserId = await userIdForEmail(email);
    assert.ok(newUserId);
    assert.notEqual(newUserId, oldUserId, 're-signup must occupy a new auth_users.id');
    const newAccountId = await accountIdForAuthUser(newUserId);
    assert.ok(newAccountId);
    assert.notEqual(newAccountId, oldAccountId, 're-signup must create a new accounts.id');
  });
});

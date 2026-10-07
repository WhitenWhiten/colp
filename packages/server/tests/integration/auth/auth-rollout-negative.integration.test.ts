/**
 * Task E2 negative controls: legacy isolation, availability failures and
 * migration down guards over the REAL composed app (plan §11 Task E2).
 *
 * 假阴性防护 (every negative case carries the three evidence classes):
 * - ROUTE TABLE: route absence is proven by Fastify printRoutes AND real
 *   404/405 responses from the composed app (never a static grep);
 * - FETCH SPY: a global fetch spy around the REAL betterAuth handler proves
 *   zero outbound legacy OIDC/JWKS/discovery traffic while local BA calls
 *   (get-session) keep working;
 * - DB QUERY AUDIT: after every flow the legacy tables (sessions /
 *   account_identities / legacy_oidc_identity_archive) stay empty and no
 *   `known_test.` material exists in any row the flows write.
 *
 * 假阳性防护:
 * - availability failures assert the STABLE product code and the absence of
 *   fabricated quota facts (a 503 never carries Retry-After /
 *   RateLimit-Policy) — an outage must never silently admit traffic;
 * - the OTP expiry/replay cases read the REAL auth_verifications rows and
 *   the REAL recovery route responses (digest-only storage, single use);
 * - migration down guards run REAL migrations: down with rows must REFUSE
 *   inside the migration transaction (tables stay intact), and the upgrade
 *   from the old identity head must be additive (legacy rows survive).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test, vi } from 'vitest';
import { betterAuth } from 'better-auth';
import type { Kysely } from 'kysely';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import {
  buildBetterAuthOptions,
  mountBetterAuthAllowlist,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
} from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import {
  createBetterAuthSessionTokenProtector,
  type BetterAuthSessionTokenProtector,
} from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { mintTestAuthorizationCode } from '../../../src/infrastructure/auth/legacy-oidc-boundary.js';
import type { AuthRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  createAccountLinkingService,
  createAccountRecoveryService,
  deriveBrowserSessionCsrfTokenRaw,
  otpIdentifierDigest,
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
import { productionMigrationNamesFromInclusive } from '../../../scripts/lexical-migration-head.mjs';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const SESSION_COOKIE_NAME = '__Host-known_session';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const NEW_PASSWORD = 'new-password-456';
const PREVIOUS_STABLE_MIGRATION = '202609040100_seed_versions';
const AFTER_MFA_MIGRATIONS = productionMigrationNamesFromInclusive('202609060100_identity_profile_about');
// Down-stepping from the mutable production head can never reach the MFA
// guard: 202610101000_classification_credit_integrity refuses `down`
// unconditionally by design. Bound the upgrade window just above MFA so both
// the MFA and better_auth_schema row guards stay reachable (TQ-02 policy).
const DOWN_GUARD_WINDOW = '202609070100_publication_insights';

/** BA-mode env with ZERO OIDC_* keys and zero test-identity flags. */
function zeroOidcEnv(overrides: Record<string, string> = {}): Record<string, string> {
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

/** BA-mode env WITH a full legacy-style OIDC env but NO test-provider flag. */
function oidcEnvWithoutTestProvider(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...zeroOidcEnv(),
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_AUDIENCE: 'known-web',
    OIDC_REDIRECT_URI: `${TRUSTED_ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    ...overrides,
  };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

/** Compose the REAL BA runtime + authority + product routes over the suite database. */
function buildSuiteApp(input: {
  readonly db: Kysely<DatabaseSchema>;
  readonly config: ReturnType<typeof loadConfig>;
  readonly sender?: ReturnType<typeof createAuthEmailAdapter>;
  readonly authRateLimiter?: AuthRateLimiter;
}): {
  readonly app: ReturnType<typeof buildApiApp>;
  readonly auth: ReturnType<typeof betterAuth>;
  readonly sessionTokenProtector: BetterAuthSessionTokenProtector;
} {
  const built = buildBetterAuthConfig(input.config.betterAuth);
  assert.ok(built, 'enabled config must produce Better Auth settings');
  const options = buildBetterAuthOptions({
    enabled: true,
    config: built,
    database: { db: input.db, type: 'postgres', transaction: true },
    ...(input.sender === undefined ? {} : { authEmail: input.sender }),
    businessAccount: { unitOfWork: createPostgresBusinessAccountUnitOfWork(input.db) },
    logger: createLogger('silent'),
  });
  const auth = betterAuth(options);
  const authority = createBetterAuthSessionAuthority({
    db: input.db,
    betterAuth: createBetterAuthServerApi(auth),
    secret: built.secret,
    sessionExpiresInSeconds: built.sessionExpiresInSeconds,
    sessionTokenProtector: createBetterAuthSessionTokenProtector(built.sessionTokenProtection),
  });

  const linkServer: OAuthLinkServerPort = {
    async startLink() {
      throw new Error('unused in the negative suite');
    },
    async listAccounts({ cookie }) {
      const headers = new Headers();
      if (cookie !== undefined) headers.set('cookie', cookie);
      return (await auth.api.listUserAccounts({ headers }))
        .map((account) => ({ providerId: account.providerId, accountId: account.accountId }));
    },
    async unlinkAccount() {
      throw new Error('unused in the negative suite');
    },
    async getUserEmail({ cookie }) {
      const headers = new Headers();
      if (cookie !== undefined) headers.set('cookie', cookie);
      const session = await auth.api.getSession({ headers });
      return session?.user?.email ?? null;
    },
  };
  const reauthVerifier: ReauthVerifier = {
    async verifyPassword() {
      return false;
    },
    async verifyOtp() {
      return false;
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

  const app = buildApiApp({
    config: input.config,
    identityUnitOfWork: createPostgresIdentityUnitOfWork(input.db),
    browserSessionAuthority: authority,
    betterAuthRuntime: { mount: (fastifyApp) => mountBetterAuthAllowlist(fastifyApp, auth, built) },
    accountLinking: createAccountLinkingService({
      authority,
      server: linkServer,
      reauth: reauthVerifier,
      productOrigin: TRUSTED_ORIGIN,
    }),
    accountRecovery: createAccountRecoveryService(recoveryServer),
    ...(input.authRateLimiter === undefined ? {} : { authRateLimiter: input.authRateLimiter }),
  });
  return {
    app,
    auth,
    sessionTokenProtector: createBetterAuthSessionTokenProtector(built.sessionTokenProtection),
  };
}

describeWithPostgres('E2 auth rollout negatives: legacy isolation, availability failures, migration guards (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: ReturnType<typeof buildApiApp>;
  let auth: ReturnType<typeof betterAuth>;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  let sessionTokenProtector: BetterAuthSessionTokenProtector;

  // Dedicated low-budget app for the rate-limit evidence.
  let rateLimitedApp: ReturnType<typeof buildApiApp>;
  let rateLimiter: ReturnType<typeof createMemoryAuthRateLimiter>;

  // Dedicated app WITHOUT an auth email sender (DirectMail unavailable).
  let noSenderApp: ReturnType<typeof buildApiApp>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('e2_auth_rollout_negative', {
      maxConnections: 14,
      applicationName: 'known-e2-auth-rollout-negative-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');

    const config = loadConfig(zeroOidcEnv());
    mailbox = createAuthTestMailbox();
    const sender = createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') });
    const main = buildSuiteApp({ db: isolated.runtime.db, config, sender });
    app = main.app;
    auth = main.auth;
    sessionTokenProtector = main.sessionTokenProtector;

    const rateConfig = loadConfig(zeroOidcEnv({ AUTH_RATE_LIMIT_MAX: '3' }));
    rateLimiter = createMemoryAuthRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    rateLimitedApp = buildSuiteApp({
      db: isolated.runtime.db,
      config: rateConfig,
      sender,
      authRateLimiter: rateLimiter,
    }).app;

    const noSenderConfig = loadConfig(zeroOidcEnv());
    noSenderApp = buildSuiteApp({ db: isolated.runtime.db, config: noSenderConfig }).app;
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await rateLimitedApp?.close().catch(() => undefined);
    await noSenderApp?.close().catch(() => undefined);
    await isolated?.close();
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function post(target: ReturnType<typeof buildApiApp>, path: string, body: unknown, headers: Record<string, string> = {}) {
    return target.inject({
      method: 'POST',
      url: `${BASE_PATH}${path}`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, ...headers },
      payload: JSON.stringify(body),
    });
  }

  async function rowCount(sqlText: string, params: unknown[] = []): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n ${sqlText}`, params);
    return result.rows[0]?.n ?? 0;
  }

  /** Route-table evidence: registered BA surface, zero legacy/test surface. */
  function routeTable(): string {
    return app.printRoutes({ commonPrefix: false });
  }

  /** Real-404 evidence: the path is absent from the composed app (product envelope). */
  async function expect404(target: ReturnType<typeof buildApiApp>, method: 'GET' | 'POST', fullPath: string): Promise<void> {
    const res = await target.inject({
      method,
      url: fullPath,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(res.statusCode, 404, `${method} ${fullPath} must be absent (route table + real 404)`);
    assert.match(res.body, /resource_not_found/u, `${fullPath} must answer the product 404 envelope`);
  }

  async function signUp(target: ReturnType<typeof buildApiApp>, email: string) {
    return post(target, '/sign-up/email', { name: 'Negative User', email, password: PASSWORD });
  }

  function get(target: ReturnType<typeof buildApiApp>, path: string, headers: Record<string, string> = {}) {
    return target.inject({
      method: 'GET',
      url: `${BASE_PATH}${path}`,
      headers: { origin: TRUSTED_ORIGIN, ...headers },
    });
  }

  function sessionCookieOf(res: { cookies?: unknown }): string | null {
    const cookies = (res.cookies ?? []) as Array<{ name: string; value: string }>;
    return cookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME)?.value ?? null;
  }

  async function verifyMailbox(target: ReturnType<typeof buildApiApp>, email: string): Promise<void> {
    const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
    assert.ok(mail, `no verification email was delivered to ${email}`);
    const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'the verification email must carry the JWT');
    const verify = await get(target, `/verify-email?token=${token}`);
    assert.equal(verify.statusCode, 200, 'mailbox verification must succeed');
    const autoCookie = sessionCookieOf(verify);
    if (autoCookie !== null && autoCookie !== '') {
      await post(target, '/sign-out', {}, { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(autoCookie)}` });
    }
  }

  async function signUpVerified(target: ReturnType<typeof buildApiApp>, email: string): Promise<{
    readonly cookie: string;
  }> {
    const signup = await signUp(target, email);
    assert.equal(signup.statusCode, 200);
    assert.equal(sessionCookieOf(signup), null, 'password sign-up must not issue a session while unverified');
    await verifyMailbox(target, email);
    const signin = await post(target, '/sign-in/email', { email, password: PASSWORD });
    assert.equal(signin.statusCode, 200, 'verified password sign-in must issue a session');
    const cookie = sessionCookieOf(signin);
    assert.ok(cookie, 'verified sign-in must set the session cookie');
    return { cookie };
  }

  /**
   * A3 product metadata row for a BA-native session cookie (the authority
   * NEVER authenticates a live BA session without metadata — orphan sessions
   * are rejected by design).
   */
  async function establishMetadata(cookieValue: string): Promise<void> {
    const token = cookieValue.slice(0, cookieValue.lastIndexOf('.'));
    const sessionRow = await isolated.runtime.pool.query<{ id: string; userId: string; token: string }>(
      `select id, "userId", token from auth_sessions where "tokenLookupHash" = any($1::text[])`,
      [sessionTokenProtector.lookupHashes(token)],
    );
    assert.equal(sessionRow.rows.length, 1, 'the BA session row must exist for the issued cookie');
    assert.notEqual(sessionRow.rows[0]!.token, token, 'the raw bearer token must not be stored');
    const sessionId = sessionRow.rows[0]!.id;
    const authUserId = sessionRow.rows[0]!.userId;
    const mapping = await isolated.runtime.pool.query<{ account_id: string }>(
      `select account_id from auth_user_account_map where auth_user_id = $1`, [authUserId],
    );
    assert.equal(mapping.rows.length, 1, 'the A2 establishment must have mapped the auth user');
    const accountId = mapping.rows[0]!.account_id;
    const epochRow = await isolated.runtime.pool.query<{ security_epoch: string }>(
      `select security_epoch from accounts where id = $1`, [accountId],
    );
    assert.equal(epochRow.rowCount, 1);
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
        epochRow.rows[0]!.security_epoch,
        browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)),
        now,
        now,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // legacy isolation (route table + fetch spy + DB audit)
  // -------------------------------------------------------------------------

  test('zero-OIDC-env app: no legacy routes, no test-authorize route, pending BA endpoints absent', async () => {
    const routes = routeTable();
    for (const absent of ['/api/v1/auth/oidc/start', '/api/v1/auth/oidc/callback', '/__test__/oidc/authorize']) {
      assert.equal(routes.includes(absent), false, `${absent} must be absent from the route table`);
    }
    for (const present of ['/api/v1/auth/sign-up/email', '/api/v1/auth/registration-state',
      '/api/v1/auth/sign-in/email', '/api/v1/auth/sign-in/username', '/api/v1/auth/get-session',
      '/api/v1/auth/sign-out', '/api/v1/auth/change-password', '/api/v1/auth/sign-in/oauth2',
      '/api/v1/auth/oauth2/callback/:providerId', '/api/v1/session', '/api/v1/me',
      // C2/A4: the email surface is mounted (reset/verification/emailOTP).
      // /api/v1/auth/sign-in/email-otp is NOT listed here: printRoutes
      // compresses its branch under /sign-in/email (`-otp` suffix), so the
      // literal path never appears — it is proven mounted by the real-request
      // probe below instead.
      '/api/v1/auth/reset-password', '/api/v1/auth/request-password-reset',
      '/api/v1/auth/verify-email', '/api/v1/auth/send-verification-email',
      '/api/v1/auth/email-otp/send-verification-otp',
      '/api/v1/auth/email-otp/check-verification-otp', '/api/v1/auth/email-otp/verify-email',
      '/api/v1/auth/email-otp/request-password-reset', '/api/v1/auth/email-otp/reset-password',
      '/api/v1/auth/forget-password/email-otp', '/api/v1/auth/email-otp/request-email-change',
      '/api/v1/auth/email-otp/change-email']) {
      assert.equal(routes.includes(present), true, `${present} must stay registered`);
    }
    // The email-OTP sign-in branch is compressed by printRoutes (`-otp`
    // suffix under /sign-in/email), so prove the mount with a real request:
    // a body-less call reaches the BA handler (validation failure translated
    // to the stable envelope), never the app-router 404.
    const otpSignIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email-otp',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({}),
    });
    assert.equal((otpSignIn.body ?? '').includes('resource_not_found'), false,
      'the email-OTP sign-in must be mounted (the request must reach the BA handler)');
    // Pending (gated) BA endpoints are NOT mounted: 404 from the real router.
    // The email surface flipped to registered; only the two-factor (MFA)
    // plugin endpoints stay gated.
    for (const [method, path] of [
      ['GET', '/api/v1/auth/oidc/start'],
      ['GET', '/api/v1/auth/oidc/callback'],
      ['GET', '/__test__/oidc/authorize'],
      ['POST', '/api/v1/auth/two-factor/enable'],
      ['POST', '/api/v1/auth/two-factor/verify-totp'],
    ] as const) {
      await expect404(app, method, path);
    }
    // Wrong method on a registered path: 405 from the real router.
    const wrongMethod = await app.inject({ method: 'GET', url: `${BASE_PATH}/sign-out` });
    assert.equal(wrongMethod.statusCode, 405);
    assert.match(wrongMethod.body, /method_not_allowed/u);
  });

  test('zero legacy network calls during real BA flows (global fetch spy) while local BA calls work', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const email = uniqueEmail('no-network');
      const signup = await signUp(app, email);
      assert.equal(signup.statusCode, 200);
      assert.equal(sessionCookieOf(signup), null, 'password sign-up must not issue a session while unverified');
      const unverifiedSignIn = await post(app, '/sign-in/email', { email, password: PASSWORD });
      assert.equal(unverifiedSignIn.statusCode, 403, 'unverified password sign-in must be verification_required');
      assert.equal((unverifiedSignIn.json() as { error: { code: string } }).error.code, 'verification_required');
      const getSession = await app.inject({ method: 'GET', url: `${BASE_PATH}/get-session` });
      assert.equal(getSession.statusCode, 200, 'the local BA get-session call must work (network-deny only blocks legacy OIDC)');
      const health = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(health.statusCode, 200);
      assert.equal(fetchSpy.mock.calls.length, 0,
        `no legacy OIDC discovery/JWKS/issuer fetch may happen in BA mode (got ${fetchSpy.mock.calls.length})`);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('DB query audit: the real flows write zero legacy rows and zero known_test.* material', async () => {
    const email = uniqueEmail('db-audit');
    const signup = await signUp(app, email);
    assert.equal(signup.statusCode, 200);
    assert.equal(await rowCount(`from sessions`), 0, 'the legacy sessions table must stay empty');
    assert.equal(await rowCount(`from account_identities`), 0, 'the legacy account_identities table must stay empty');
    assert.equal(await rowCount(`from legacy_oidc_identity_archive`), 0, 'the archive table must stay empty');

    const prefixAudit = await isolated.runtime.pool.query<{ n: number }>(`
      select count(*)::int n from (
        select email as value from "auth_users"
        union all select token from "auth_sessions"
        union all select identifier from auth_verifications
        union all select id from "auth_users"
      ) audit where value like 'known_test.%'`);
    assert.equal(prefixAudit.rows[0]?.n, 0, 'no known_test.* material may appear in any auth table');
  });

  test('known_test.* authorization codes are never accepted (route absent + DB audit)', async () => {
    // Mint a cryptographically VALID known_test.* code (NODE_ENV=test) — the
    // negative proof is that no route exists that could ever redeem it.
    const code = mintTestAuthorizationCode({
      subject: 'known-test-subject',
      nonce: 'known-test-nonce',
      codeVerifier: 'known-test-verifier',
      email: 'known-test@example.test',
      emailVerified: true,
      name: 'Known Test',
      hmacSecret: 'test-oidc-provider-hmac-secret-not-prod-default',
      issuer: 'https://issuer.example/realms/known',
      audience: 'known-web',
    });
    assert.match(code, /^known_test\./u);

    const callback = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/oidc/callback?code=${encodeURIComponent(code)}&state=known-test-state`,
    });
    assert.equal(callback.statusCode, 404, 'the legacy OIDC callback route is absent — a known_test code cannot be redeemed');
    const start = await app.inject({ method: 'GET', url: `${BASE_PATH}/oidc/start` });
    assert.equal(start.statusCode, 404);

    assert.equal(await rowCount(`from accounts where id like 'known_test.%'`), 0);
    assert.equal(await rowCount(`from "auth_users" where email = 'known-test@example.test'`), 0,
      'the known_test code must not mint an auth user');
    assert.equal(await rowCount(`from sessions`), 0);
  });

  test('the test-identity flags never open the test-authorize route in Better Auth mode', async () => {
    // Even with the FULL legacy test-provider env (flags on), BA mode keeps
    // the in-process test OIDC surface absent.
    const flaggedConfig = loadConfig({
      ...zeroOidcEnv(),
      OIDC_ISSUER: 'http://localhost:3310/__test__/oidc',
      OIDC_CLIENT_ID: 'known-web-real-stack',
      OIDC_AUDIENCE: 'known-web-real-stack',
      OIDC_REDIRECT_URI: `${TRUSTED_ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'http://localhost:3310/__test__/oidc/authorize',
      OIDC_TOKEN_ENDPOINT: 'http://localhost:3310/__test__/oidc/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_ENABLE_E2E_TEST_IDENTITY: 'true',
    });
    const flagged = buildSuiteApp({ db: isolated.runtime.db, config: flaggedConfig });
    try {
      const routes = flagged.app.printRoutes({ commonPrefix: false });
      assert.equal(routes.includes('/__test__/oidc/authorize'), false,
        'the test-authorize route must be absent in Better Auth mode even with the flags on');
      const res = await flagged.app.inject({ method: 'GET', url: '/__test__/oidc/authorize' });
      assert.equal(res.statusCode, 404);
      assert.match(res.body, /resource_not_found/u);
    } finally {
      await flagged.app.close();
    }
  });

  test('OIDC env present without the test-provider flag: config stays closed and legacy routes stay absent', () => {
    // The no-test-provider config (a full legacy-style OIDC env) loads in BA
    // mode and never enables the in-process test provider.
    const config = loadConfig(oidcEnvWithoutTestProvider());
    assert.equal(config.oidc.allowTestProvider, false);
    assert.equal(config.testIdentityProviderEnabled, false);
    assert.equal(config.betterAuth.enabled, true);
    const routes = routeTable();
    assert.equal(routes.includes('/__test__/oidc/authorize'), false);
    assert.equal(routes.includes('/api/v1/auth/oidc/start'), false);
  });

  // -------------------------------------------------------------------------
  // Origin/CSRF negative matrix
  // -------------------------------------------------------------------------

  test('Origin and CSRF negative matrix over the composed app', async () => {
    const email = uniqueEmail('csrf-matrix');
    const { cookie: cookieValue } = await signUpVerified(app, email);
    await establishMetadata(decodeURIComponent(cookieValue));
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieValue)}`;

    // BA endpoint without Origin: the transport pre-check fires first.
    const noOrigin = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal((noOrigin.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // BA endpoint with a foreign Origin.
    const foreignOrigin = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/email`,
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      payload: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(foreignOrigin.statusCode, 403);
    assert.equal((foreignOrigin.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // Product route: session bootstrap then PATCH /me without / with garbage CSRF.
    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    assert.equal((session.json() as { authenticated?: boolean }).authenticated, true);
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie, origin: TRUSTED_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ handle: 'csrf_matrix', displayName: 'X' }),
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal((noCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');
    const garbageCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie, origin: TRUSTED_ORIGIN, 'x-csrf-token': 'garbage', 'content-type': 'application/json' },
      payload: JSON.stringify({ handle: 'csrf_matrix', displayName: 'X' }),
    });
    assert.equal(garbageCsrf.statusCode, 403);
    assert.equal((garbageCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // Recovery route without Origin (unauthenticated POST; Origin is the line).
    const recoveryNoOrigin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/password-reset',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email }),
    });
    assert.equal(recoveryNoOrigin.statusCode, 403);
    assert.equal((recoveryNoOrigin.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // Link route without CSRF.
    const linkNoCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/oauth2/link',
      headers: { cookie, origin: TRUSTED_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ providerId: 'google', callbackURL: '/settings', reauth: { kind: 'password', password: PASSWORD } }),
    });
    assert.equal(linkNoCsrf.statusCode, 403);
    assert.equal((linkNoCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

    // Unauthenticated product surface.
    const meAnon = await app.inject({ method: 'GET', url: '/api/v1/me' });
    assert.equal(meAnon.statusCode, 401);
    assert.equal((meAnon.json() as { error: { code: string } }).error.code, 'authentication_required');
  });

  // -------------------------------------------------------------------------
  // rate limit + unavailable dependencies
  // -------------------------------------------------------------------------

  test('auth rate limit: the sign-in family exhausts to a stable 429 and never leaks secrets', async () => {
    const email = uniqueEmail('rate-limit');
    const signup = await signUp(rateLimitedApp, email);
    assert.equal(signup.statusCode, 200);

    const responses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      responses.push(await post(rateLimitedApp, '/sign-in/email', { email, password: 'wrong-password' })); // secret-scan: allow 'wrong-password'
    }
    assert.equal(responses[0]!.statusCode, 401, 'wrong password -> invalid_credentials');
    assert.equal(responses[1]!.statusCode, 401);
    assert.equal(responses[2]!.statusCode, 401);
    const denied = responses[3]!;
    assert.equal(denied.statusCode, 429, 'the 4th sign-in-family request must be rate limited');
    const deniedBody = denied.json() as { error: { code: string; retryAfterSeconds: number | null; message: string } };
    assert.equal(deniedBody.error.code, 'rate_limited');
    assert.ok(deniedBody.error.retryAfterSeconds !== null && deniedBody.error.retryAfterSeconds > 0);
    assert.equal(deniedBody.error.message, 'Too many requests. Please try again later.');
    assert.ok(denied.headers['retry-after'], 'the 429 must carry Retry-After');
    assert.match(String(denied.headers['ratelimit-policy'] ?? ''), /^auth:sign-in:/u,
      'the 429 must carry the family-scoped RateLimit-Policy header (Fastify lowercases header names)');
    assert.equal(denied.body.includes(email), false, 'the 429 envelope must not echo the email');

    // Family isolation: the sign-up family has its own budget and still passes.
    const signupAfter = await signUp(rateLimitedApp, uniqueEmail('rate-limit-2'));
    assert.equal(signupAfter.statusCode, 200, 'an exhausted sign-in family must not throttle the sign-up family');

    // Legacy OIDC paths consume no family bucket in BA mode (route absent).
    const sizeBefore = rateLimiter.size();
    const legacy = await rateLimitedApp.inject({ method: 'GET', url: `${BASE_PATH}/oidc/start` });
    assert.equal(legacy.statusCode, 404);
    assert.equal(rateLimiter.size(), sizeBefore, 'a 404 legacy path must not create a rate-limit bucket');
  });

  test('shared limiter failure (Redis outage) fails closed with a stable 503 and no quota facts', async () => {
    const failingLimiter: AuthRateLimiter = {
      async consume() {
        return { kind: 'failed', failure: { class: 'unavailable', code: 'redis_unreachable' } };
      },
      readiness() {
        return { status: 'degraded', reason: 'last_command_failed', lastCheckedAtEpochMs: Date.now() };
      },
      async close() {},
    };
    const config = loadConfig(zeroOidcEnv());
    const failing = buildSuiteApp({ db: isolated.runtime.db, config, authRateLimiter: failingLimiter });
    try {
      const email = uniqueEmail('redis-down');
      const signin = await post(failing.app, '/sign-in/email', { email, password: PASSWORD });
      assert.equal(signin.statusCode, 503, 'a failing shared limiter must fail closed, never silently admit');
      const body = signin.json() as { error: { code: string; message: string } };
      assert.equal(body.error.code, 'feature_temporarily_unavailable');
      assert.equal(body.error.message, 'Rate limiting service is temporarily unavailable. Please try again later.');
      assert.equal(signin.headers['retry-after'], undefined, 'a 503 must never fabricate quota facts');
      assert.equal(signin.headers['ratelimit-policy'], undefined,
        'a 503 must never fabricate quota facts (RateLimit-Policy absent; Fastify lowercases header names)');
      assert.equal(signin.body.includes(email), false, 'the 503 must not echo the email');
    } finally {
      await failing.app.close();
    }
  });

  test('DirectMail unavailable: recovery reports email_delivery_unavailable, sign-up still works, nothing is claimed', async () => {
    const email = uniqueEmail('dm-down');
    const signup = await signUp(noSenderApp, email);
    assert.equal(signup.statusCode, 200, 'sign-up must work without a sender (no claimed delivery)');
    const userCount = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_users" where email = $1`, [email],
    );
    assert.equal(userCount.rows[0]?.n, 1);

    const reset = await post(noSenderApp, '/recovery/password-reset', { email });
    assert.equal(reset.statusCode, 503);
    const body = reset.json() as { error: { code: string; message: string; recovery: string } };
    assert.equal(body.error.code, 'email_delivery_unavailable');
    assert.equal(body.error.message, 'Email delivery is temporarily unavailable. Please try again later.');
    assert.equal(body.error.recovery, 'none');
    assert.equal(reset.body.includes(email), false, 'the 503 must not echo the email');

    // Without a sender NOTHING is ever claimed as delivered. Unverified
    // password sign-in is verification_required (P1) and still does not
    // claim a delivery — only the recovery surface reports the outage.
    const mailBefore = mailbox.sentCount;
    const signin = await post(noSenderApp, '/sign-in/email', { email, password: PASSWORD });
    assert.equal(signin.statusCode, 403, 'unverified password sign-in must be verification_required');
    assert.equal((signin.json() as { error: { code: string } }).error.code, 'verification_required');
    assert.equal(sessionCookieOf(signin), null, 'unverified sign-in must not issue a session');
    assert.equal(mailbox.sentCount, mailBefore, 'the no-sender app must never claim a delivery');
    assert.equal(mailbox.entries.filter((entry) => entry.to === email).length, 0,
      'no verification/OTP mail may exist for the no-sender app');
  });

  // -------------------------------------------------------------------------
  // OTP expiry / replay over the composed app
  // -------------------------------------------------------------------------

  test('expired OTP is refused with the stable envelope and the row is deleted', async () => {
    const email = uniqueEmail('otp-expired');
    mailbox.setTestId('otp-expired');
    const signup = await signUp(app, email);
    assert.equal(signup.statusCode, 200);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now();
      vi.setSystemTime(t0);
      await auth.api.sendVerificationOTP({ body: { email, type: 'forget-password' } });
      const otp = mailbox.otpFor({ email, purpose: 'otp:forget-password' });
      assert.ok(otp, 'the forget-password OTP must be delivered to the mailbox');
      assert.equal(await rowCount(`from auth_verifications where identifier = $1`, [otpIdentifierDigest('forget-password', email)]), 1);

      vi.setSystemTime(t0 + 301_000);
      const reset = await post(app, '/recovery/otp-reset', { email, otp, newPassword: NEW_PASSWORD });
      assert.equal(reset.statusCode, 401, 'an expired OTP must be refused');
      const body = reset.json() as { error: { code: string } };
      assert.equal(body.error.code, 'invalid_credentials', 'OTP_EXPIRED maps to the stable invalid_credentials envelope');
      assert.equal(reset.body.includes(otp), false, 'the envelope must never echo the OTP');
      assert.equal(await rowCount(`from auth_verifications where identifier = $1`, [otpIdentifierDigest('forget-password', email)]), 0,
        'the expired OTP row must be deleted');
    } finally {
      vi.useRealTimers();
    }
  });

  test('replayed OTP is single-use: the first reset wins, the replay is refused', async () => {
    const email = uniqueEmail('otp-replay');
    mailbox.setTestId('otp-replay');
    const signup = await signUp(app, email);
    assert.equal(signup.statusCode, 200);

    await auth.api.sendVerificationOTP({ body: { email, type: 'forget-password' } });
    const otp = mailbox.otpFor({ email, purpose: 'otp:forget-password' });
    assert.ok(otp);

    const first = await post(app, '/recovery/otp-reset', { email, otp, newPassword: NEW_PASSWORD });
    assert.equal(first.statusCode, 200, 'the first OTP reset must succeed');
    const replay = await post(app, '/recovery/otp-reset', { email, otp, newPassword: NEW_PASSWORD + '-2' });
    assert.equal(replay.statusCode, 401, 'the replayed OTP must be refused');
    assert.equal((replay.json() as { error: { code: string } }).error.code, 'invalid_credentials');
    assert.equal(replay.body.includes(otp), false, 'the replay envelope must never echo the OTP');
    assert.equal(await rowCount(`from auth_verifications where identifier = $1`, [otpIdentifierDigest('forget-password', email)]), 0,
      'the consumed OTP row must be gone');

    // The winner's password works; the replayed request changed nothing.
    const relogin = await post(app, '/sign-in/email', { email, password: NEW_PASSWORD });
    assert.equal(relogin.statusCode, 200);
  });

  // -------------------------------------------------------------------------
  // migration: upgrade from the old identity head + down guards with rows
  // -------------------------------------------------------------------------

  test('migration: upgrade from the old identity schema is additive and down with rows is refused', async () => {
    const upgrade = await createIsolatedPostgresRuntime('e2_better_auth_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, DOWN_GUARD_WINDOW);
      const previous = await migrator.migrateTo(PREVIOUS_STABLE_MIGRATION);
      if (previous.error) throw previous.error;

      // Old identity schema: legacy business tables exist, BA tables do not.
      const legacyBefore = await upgrade.runtime.pool.query<{ name: string }>(
        `select table_name as name from information_schema.tables
          where table_schema = current_schema() and table_name in ('accounts', 'sessions', 'account_identities')`,
      );
      assert.equal(legacyBefore.rows.length, 3, 'the old identity head must carry the legacy tables');
      const baBefore = await upgrade.runtime.pool.query<{ name: string }>(
        `select table_name as name from information_schema.tables
          where table_schema = current_schema() and table_name in ('auth_users', 'auth_sessions', 'auth_accounts')`,
      );
      assert.equal(baBefore.rows.length, 0, 'no BA table may exist before the expand chain');

      // Legacy identity rows survive the upgrade (additive contract).
      // The OIDC profile-handle invariant (202607270100) requires a handle
      // for an active account with an identity row — a real legacy account
      // always has one, so plant it before the identity row.
      await upgrade.runtime.pool.query(
        `insert into accounts (id, subject_id, status, email, security_epoch, created_at, deleted_at)
         values ('legacy-account-1', 'legacy-subject-1', 'active', 'legacy@example.test', 0, now(), null)`,
      );
      await upgrade.runtime.pool.query(
        `insert into profile_handles (handle, account_id) values ('legacy-handle-1', 'legacy-account-1')`,
      );
      await upgrade.runtime.pool.query(
        `insert into account_identities (id, account_id, issuer, subject, created_at)
         values ('legacy-identity-1', 'legacy-account-1', 'https://issuer.example/realms/known', 'legacy-subject-1', now())`,
      );

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const legacyAfter = await upgrade.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from accounts where id = 'legacy-account-1'`,
      );
      assert.equal(legacyAfter.rows[0]?.n, 1, 'the upgrade must never drop legacy identity rows');
      const identityAfter = await upgrade.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from account_identities where id = 'legacy-identity-1'`,
      );
      assert.equal(identityAfter.rows[0]?.n, 1);
      const archive = await upgrade.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from information_schema.tables
          where table_schema = current_schema() and table_name = 'legacy_oidc_identity_archive'`,
      );
      assert.equal(archive.rows[0]?.n, 1, 'the archive table must land with the expand chain');

      // Down guard 1: an MFA row refuses the C4 down (rows remain). Later
      // expand migrations (e.g. profile about) sit above MFA, so step down
      // until the MFA guard is the one that refuses.
      await upgrade.runtime.pool.query(
        `insert into "auth_users" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ('ba-user-1', 'BA User', 'ba@example.test', false, now(), now())`,
      );
      await upgrade.runtime.pool.query(
        `insert into "auth_two_factor" (id, secret, "backupCodes", "userId", verified, "createdAt", "updatedAt")
         values ('tf-1', 'aa', 'bb', 'ba-user-1', false, now(), now())`,
      );
      let mfaGuardRejected = false;
      for (let step = 0; step < AFTER_MFA_MIGRATIONS.length + 1 && !mfaGuardRejected; step += 1) {
        try {
          await runMigrations(upgrade.runtime.db, 'down');
        } catch (error) {
          assert.match(String(error), /better_auth_mfa_schema down refused: rows remain/u,
            `down step ${step}: expected the MFA row guard (got: ${String(error)})`);
          mfaGuardRejected = true;
        }
      }
      assert.equal(mfaGuardRejected, true, 'stepping down must refuse at the MFA row guard while MFA rows remain');
      const tfTable = await upgrade.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from information_schema.tables
          where table_schema = current_schema() and table_name = 'auth_two_factor'`,
      );
      assert.equal(tfTable.rows[0]?.n, 1, 'a refused down must leave the table intact (transactional guard)');

      // Down guard 2: with MFA clean, Kysely migrateDown steps ONE migration
      // per call, so the expand chain (MFA -> archive -> metadata -> mapping)
      // rolls back cleanly (all empty) and the down must refuse exactly when
      // the better_auth_schema guard is reached while BA rows remain — the
      // refusal is transactional (tables and rows stay intact).
      await upgrade.runtime.pool.query(`delete from "auth_two_factor"`);
      let schemaGuardRejected = false;
      for (let step = 0; step < 32 && !schemaGuardRejected; step += 1) {
        try {
          await runMigrations(upgrade.runtime.db, 'down');
        } catch (error) {
          assert.match(String(error), /better_auth_schema down refused: rows remain/u,
            `down step ${step}: the only acceptable down failure is the schema guard while BA rows remain (got: ${String(error)})`);
          schemaGuardRejected = true;
        }
      }
      assert.equal(schemaGuardRejected, true,
        'stepping down must reach the better_auth_schema guard while BA rows remain');
      const users = await upgrade.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from "auth_users" where id = 'ba-user-1'`,
      );
      assert.equal(users.rows[0]?.n, 1, 'a refused down must keep every BA row');
      const schemaTable = await upgrade.runtime.pool.query<{ n: number }>(
        `select count(*)::int n from information_schema.tables
          where table_schema = current_schema() and table_name = 'auth_users'`,
      );
      assert.equal(schemaTable.rows[0]?.n, 1, 'the refused down must leave the schema table intact');
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});

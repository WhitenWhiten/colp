/**
 * Task C3 integration: OAuth providers + explicit account linking + recovery
 * over REAL Better Auth 1.7.1 + REAL PostgreSQL + a CONTROLLED OAuth
 * provider (real HTTP authorization/token/userinfo endpoints with S256 PKCE,
 * one-time codes and per-test state resets — the G0 spike pattern).
 *
 * 假阴性防护:
 * - the authorization code / state / PKCE chain is executed for real: the
 *   mock provider issues one-time codes bound to code_challenge, the token
 *   endpoint validates the code_verifier challenge and the client secret,
 *   and the callback is followed over the REAL bridge (never stubbed);
 * - every flow asserts DATABASE rows (auth_users / auth_accounts /
 *   auth_user_account_map) and the product /api/v1/me surface — never just
 *   the redirect target;
 * - each test starts from an empty provider/account state (beforeEach
 *   cleanup + mock state reset) and unique emails;
 * - the explicit-link flow runs with the REAL A3 authority (session +
 *   CSRF) and REAL re-auth proofs (password via auth.api.verifyPassword,
 *   OTP via the digest-only email-OTP plugin).
 *
 * 假阳性防护:
 * - the same-email negative tests assert the exact G0 disableImplicitLinking
 *   contract (error=account_not_linked, no session, no orphan auth user, no
 *   provider row) AND the test suite asserts the options object still carries
 *   `disableImplicitLinking: true` — removing that configuration must fail
 *   this suite;
 * - link success is never a pre-inserted account row: the provider account
 *   is created by the REAL callback, and the cross-user case proves the
 *   UNIQUE(providerId, accountId) ownership check refuses a second owner;
 * - the provider callback open-redirect scenario asserts the start endpoint
 *   refuses foreign callback URLs and every callback redirect stays on the
 *   Know-N origin.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { genericOAuth } from 'better-auth/plugins';
import { loadConfig } from '../../support/test-config.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildBetterAuthOptions,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { createBetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createAuthEmailAdapter, createInProcessMailboxSink } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  createAccountLinkingService,
  createAccountRecoveryService,
  deriveBrowserSessionCsrfTokenRaw,
  type AccountLinkingService,
  type AccountRecoveryService,
  type BrowserSessionAuthority,
  type OAuthLinkServerPort,
  type ReauthVerifier,
  type RecoveryServerPort,
} from '../../../src/modules/auth/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const NEW_PASSWORD = 'new-password-456'; // secret-scan: allow 'new-password-456'
const MOCK_GOOGLE_CLIENT_ID = 'test-google-client-id';
const MOCK_GOOGLE_CLIENT_SECRET = 'test-google-client-secret'; // secret-scan: allow 'test-google-client-secret'
const MOCK_GITHUB_CLIENT_ID = 'test-github-client-id';
const MOCK_GITHUB_CLIENT_SECRET = 'test-github-client-secret'; // secret-scan: allow 'test-github-client-secret'

function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: TRUSTED_ORIGIN,
    ALLOWED_ORIGINS: TRUSTED_ORIGIN,
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: `${TRUSTED_ORIGIN}/api/v1/auth/oidc/callback`,
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef1',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    BETTER_AUTH_BODY_LIMIT_BYTES: '1024',
    // The suite exercises the auth surface end-to-end (~80 session-family
    // requests); the default 60/min memory limiter would exhaust mid-suite
    // and 429 unrelated flows. Rate limiting itself is covered by its own
    // suites (auth-local-flows / rl06).
    AUTH_RATE_LIMIT_MAX: '1000000',
    // SOCIAL_ENABLED stays false: the test providers come from genericOAuth
    // (controlled endpoints); the typed-config socialProviders mapping is
    // pinned by the unit tests.
    ...overrides,
  };
}

interface IssuedCode {
  readonly codeChallenge: string;
  readonly state: string;
  readonly clientId: string;
  used: boolean;
}

interface MockProviderState {
  userinfo: { readonly id: string; readonly email: string; readonly email_verified: boolean; readonly name: string } | null;
  readonly codes: Map<string, IssuedCode>;
  readonly tokens: Set<string>;
  readonly tokenRequests: Array<{ readonly hasCodeVerifier: boolean; readonly clientId: string | null; readonly clientSecret: string | null }>;
}

/** Controlled OAuth2 provider: real HTTP authorize/token/userinfo (spike §N7). */
function startMockOAuthProvider(): {
  readonly state: MockProviderState;
  readonly origin: string;
  readonly close: () => Promise<void>;
} {
  const state: MockProviderState = {
    userinfo: null,
    codes: new Map(),
    tokens: new Set(),
    tokenRequests: [],
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const stateParam = url.searchParams.get('state');
      const codeChallenge = url.searchParams.get('code_challenge');
      const clientId = url.searchParams.get('client_id');
      if (!redirectUri) {
        res.writeHead(400); res.end(); return;
      }
      const code = `mock-code-${randomUUID().replaceAll('-', '')}`;
      state.codes.set(code, {
        codeChallenge: codeChallenge ?? '',
        state: stateParam ?? '',
        clientId: clientId ?? '',
        used: false,
      });
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(stateParam ?? '')}` });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const code = params.get('code') ?? '';
      const verifier = params.get('code_verifier');
      const grantType = params.get('grant_type');
      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');
      state.tokenRequests.push({ hasCodeVerifier: verifier !== null, clientId, clientSecret });
      const issued = state.codes.get(code);
      if (!issued || issued.used || grantType !== 'authorization_code') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      // REAL PKCE S256 verification when the authorize request carried a challenge.
      if (issued.codeChallenge !== '') {
        const challenge = createHash('sha256').update(verifier ?? '').digest('base64url');
        if (challenge !== issued.codeChallenge) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
      }
      issued.used = true;
      const accessToken = `mock-access-${randomUUID().replaceAll('-', '')}`;
      state.tokens.add(accessToken);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    if (url.pathname === '/userinfo') {
      const auth = req.headers.authorization ?? '';
      const token = auth.replace(/^Bearer\s+/u, '');
      if (!state.tokens.has(token) || state.userinfo === null) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.userinfo));
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock provider must listen on a TCP port'));
        return;
      }
      resolve({
        state,
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

function stripOrigin(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.pathname}${url.search}`;
}

function setCookieEntries(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function absorbCookies(res: { headers: Record<string, unknown> }, jar: Map<string, string>): void {
  for (const entry of setCookieEntries(res)) {
    const pair = entry.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    jar.set(pair.slice(0, eq).trim(), decodeURIComponent(pair.slice(eq + 1)));
  }
}

function jarHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

describeWithPostgres('C3 OAuth linking: controlled provider + explicit link + recovery (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let mock: { readonly state: MockProviderState; readonly origin: string; readonly close: () => Promise<void> };
  let auth: NonNullable<ReturnType<typeof composeBetterAuthComposition>['betterAuth']>;
  let authority: BrowserSessionAuthority;
  let accountLinking: AccountLinkingService;
  let accountRecovery: AccountRecoveryService;
  let app: ReturnType<typeof buildApiApp>;
  let sink: ReturnType<typeof createInProcessMailboxSink>;
  let built: BetterAuthRuntimeConfig;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('c3_oauth_linking', {
      maxConnections: 12,
      applicationName: 'known-c3-oauth-linking-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');

    mock = await startMockOAuthProvider();

    const config = loadConfig(testEnv());
    built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');

    sink = createInProcessMailboxSink();
    const sender = createAuthEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });

    const mockProviders = [
      {
        providerId: 'google',
        clientId: MOCK_GOOGLE_CLIENT_ID,
        clientSecret: MOCK_GOOGLE_CLIENT_SECRET,
        authorizationUrl: `${mock.origin}/authorize`,
        tokenUrl: `${mock.origin}/token`,
        userInfoUrl: `${mock.origin}/userinfo`,
        scopes: ['email'],
        pkce: true,
      },
      {
        providerId: 'github',
        clientId: MOCK_GITHUB_CLIENT_ID,
        clientSecret: MOCK_GITHUB_CLIENT_SECRET,
        authorizationUrl: `${mock.origin}/authorize`,
        tokenUrl: `${mock.origin}/token`,
        userInfoUrl: `${mock.origin}/userinfo`,
        scopes: ['email'],
        pkce: true,
      },
    ];
    const testGenericOAuth = genericOAuth({ config: mockProviders });

    // Probe the frozen options shape: disableImplicitLinking must stay on.
    const probeOptions = buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
      authEmail: sender,
      logger: createLogger('silent'),
      testGenericOAuth,
    });
    const probeLinking = (probeOptions as unknown as { readonly account?: { readonly accountLinking?: { readonly disableImplicitLinking?: boolean } } }).account?.accountLinking;
    assert.equal(probeLinking?.disableImplicitLinking, true, 'disableImplicitLinking must stay enabled (C3 negative tests depend on it)');
    const probeEmail = (probeOptions as unknown as { readonly emailAndPassword?: { readonly requireEmailVerification?: boolean } }).emailAndPassword;
    assert.equal(probeEmail?.requireEmailVerification, true, 'requireEmailVerification must stay enabled (P1 occupancy is not an actor)');
    assert.equal(
      (probeOptions.plugins ?? []).some((plugin) => plugin.id === 'generic-oauth'),
      true,
      'NODE_ENV=test must honor testGenericOAuth so the oauth2 callback chain exists',
    );

    const composition = composeBetterAuthComposition({
      config,
      db: isolated.runtime.db,
      authEmail: sender,
      logger: createLogger('silent'),
      testGenericOAuth,
    });
    assert.ok(composition.betterAuth, 'compose must expose the shared Better Auth instance');
    assert.ok(composition.browserSessionAuthority, 'compose must wire the production session authority');
    assert.ok(composition.betterAuthRuntime, 'compose must wire the production Better Auth runtime');
    auth = composition.betterAuth;
    authority = composition.browserSessionAuthority;

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
        // Better Auth 1.7 unlink takes the auth_accounts row `id`, not the
        // provider subject + providerId pair (mirrors the production port).
        const accounts = await auth.api.listUserAccounts({ headers });
        const target = accounts.find((account) =>
          account.providerId === providerId && account.accountId === accountId);
        if (target === undefined) throw new Error('unlink target is not linked to this session');
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

    accountLinking = createAccountLinkingService({
      authority,
      server: linkServer,
      reauth: reauthVerifier,
      productOrigin: TRUSTED_ORIGIN,
    });
    accountRecovery = createAccountRecoveryService(recoveryServer);

    app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
      betterAuthRuntime: composition.betterAuthRuntime,
      accountLinking,
      accountRecovery,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await mock?.close();
    await isolated?.close();
  });

  /** Every case starts from an empty provider/account state. */
  beforeEach(async () => {
    await isolated.runtime.pool.query(`delete from sync_sessions`);
    await isolated.runtime.pool.query(`delete from sync_extension_credentials`);
    await isolated.runtime.pool.query(`delete from sync_replicas`);
    await isolated.runtime.pool.query(`delete from sync_replica_generations`);
    await isolated.runtime.pool.query(`delete from sync_replica_id_ledger`);
    await isolated.runtime.pool.query(`begin; delete from nodes; delete from collections; commit`);
    await isolated.runtime.pool.query(`delete from sync_devices`);
    await isolated.runtime.pool.query(`delete from known_auth_session_metadata`);
    await isolated.runtime.pool.query(`delete from "auth_sessions"`);
    await isolated.runtime.pool.query(`delete from "auth_accounts"`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);
    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from legacy_oidc_identity_archive`);
    await isolated.runtime.pool.query(`delete from account_identities`);
    await isolated.runtime.pool.query(`delete from sessions`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    mock.state.userinfo = null;
    mock.state.codes.clear();
    mock.state.tokens.clear();
    mock.state.tokenRequests.length = 0;
  });

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `${BASE_PATH}${path}`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, ...headers },
      payload: JSON.stringify(body),
    });
  }

  async function userIdForEmail(email: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ id: string }>(
      `select id from "auth_users" where email = $1`, [email],
    );
    return result.rows[0]?.id ?? null;
  }

  async function accountRowsForUser(userId: string): Promise<Array<{ providerId: string; accountId: string }>> {
    const result = await isolated.runtime.pool.query<{ providerId: string; accountId: string }>(
      `select "providerId", "accountId" from "auth_accounts" where "userId" = $1 order by "providerId"`,
      [userId],
    );
    return result.rows;
  }

  async function mappingForUser(userId: string): Promise<Array<{ account_id: string }>> {
    const result = await isolated.runtime.pool.query<{ account_id: string }>(
      `select account_id from auth_user_account_map where auth_user_id = $1`, [userId],
    );
    return result.rows;
  }

  async function signUpUnverifiedLocal(email: string): Promise<string> {
    const res = await post('/sign-up/email', { name: 'C3 Local', email, password: PASSWORD });
    assert.equal(res.statusCode, 200, 'local sign-up must succeed');
    const userId = await userIdForEmail(email);
    assert.ok(userId, 'sign-up must create the auth user');
    return userId;
  }

  async function verifyLocalMailbox(email: string): Promise<void> {
    const entry = sink.entries.find((item) => item.to === email && item.subject.includes('Verify'))
      ?? sink.entries.find((item) => item.to === email);
    assert.ok(entry, `no verification email was delivered to ${email}`);
    const token = entry.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'the verification email must carry the JWT');
    const verify = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/verify-email?token=${token}`,
      headers: { origin: TRUSTED_ORIGIN },
    });
    assert.equal(verify.statusCode, 200, 'mailbox verification must succeed');
  }

  async function signUpLocal(email: string): Promise<string> {
    const userId = await signUpUnverifiedLocal(email);
    await verifyLocalMailbox(email);
    return userId;
  }

  function lastOtpFor(email: string): string {
    const entries = sink.entries.filter((entry) => entry.to === email);
    const entry = entries.at(-1);
    assert.ok(entry, `no OTP email was delivered to ${email}`);
    const match = entry.textBody.match(/\b\d{6}\b/u);
    assert.ok(match, 'the OTP email body must contain the 6-digit code');
    return match[0];
  }

  /**
   * Production composition wiring (F2) creates the known_auth_session_metadata
   * row on session creation; this test performs that step explicitly, then
   * the product surfaces authenticate (a live BA session without metadata
   * NEVER authenticates).
   */
  async function establishMetadata(cookieValue: string): Promise<{ readonly accountId: string }> {
    const token = cookieValue.slice(0, cookieValue.indexOf('.'));
    const lookupHashes = createBetterAuthSessionTokenProtector(
      built.sessionTokenProtection,
    ).lookupHashes(token);
    const sessionRow = await isolated.runtime.pool.query<{ id: string; userId: string; token: string }>(
      `select id, "userId", token from "auth_sessions" where "tokenLookupHash" = any($1::text[])`,
      [lookupHashes],
    );
    assert.equal(sessionRow.rows.length, 1, 'the BA session row must exist');
    assert.notEqual(sessionRow.rows[0]!.token, token, 'the raw bearer token must not be stored');
    const sessionId = sessionRow.rows[0]!.id;
    const authUserId = sessionRow.rows[0]!.userId;
    const mapping = await mappingForUser(authUserId);
    assert.equal(mapping.length, 1, 'the A2 establishment must create the mapping');
    const accountId = mapping[0]!.account_id;
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
        '0',
        browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(token)),
        now,
        now,
      ],
    );
    return { accountId };
  }

  async function bootstrapSession(cookie: string): Promise<{ readonly csrfToken: string; readonly accountId: string }> {
    const value = cookie.split('=', 2)[1]!;
    const { accountId } = await establishMetadata(value);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { authenticated?: boolean; csrfToken?: string };
    assert.equal(body.authenticated, true, 'the product session must authenticate');
    assert.ok(body.csrfToken, 'bootstrap must return the product CSRF token');
    return { csrfToken: body.csrfToken!, accountId };
  }

  async function me(cookie: string): Promise<{ statusCode: number; body: unknown }> {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    return { statusCode: res.statusCode, body: res.json() };
  }

  async function signInProductSession(email: string): Promise<{ cookie: string; csrfToken: string }> {
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(signIn.statusCode, 200, signIn.body);
    const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry, 'sign-in must set the session cookie');
    const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const cookie = `__Host-known_session=${cookieValue}`;
    const { csrfToken } = await bootstrapSession(cookie);
    return { cookie, csrfToken };
  }

  async function accountEpoch(accountId: string): Promise<bigint> {
    const row = await isolated.runtime.pool.query<{ security_epoch: string }>(
      'select security_epoch::text as security_epoch from accounts where id = $1',
      [accountId],
    );
    return BigInt(row.rows[0]!.security_epoch);
  }

  /**
   * Full provider sign-in: start -> mock authorize -> callback, over the real
   * bridge with a real cookie jar.
   */
  async function oauthSignIn(input: {
    readonly providerId: string;
    readonly email: string;
    readonly name: string;
    readonly callbackURL?: string;
    readonly errorCallbackURL?: string;
  }): Promise<{
    readonly startStatus: number;
    readonly startBody: unknown;
    readonly cbStatus: number;
    readonly location: string;
    readonly sessionCookie: string | null;
    readonly jar: Map<string, string>;
  }> {
    const jar = new Map<string, string>();
    const start = await post('/sign-in/social', {
      provider: input.providerId,
      callbackURL: input.callbackURL ?? '/dashboard',
      errorCallbackURL: input.errorCallbackURL ?? '/error',
    });
    absorbCookies(start, jar);
    const startBody = start.json() as { url?: string };
    if (typeof startBody.url !== 'string') {
      return { startStatus: start.statusCode, startBody, cbStatus: 0, location: '', sessionCookie: null, jar };
    }
    const authorize = await fetch(startBody.url, { redirect: 'manual' });
    const callbackUrl = String(authorize.headers.get('location') ?? '');
    assert.ok(callbackUrl.includes('/api/v1/auth/callback/'), 'the provider must redirect to the Know-N callback');
    const cb = await app.inject({
      method: 'GET',
      url: stripOrigin(callbackUrl),
      headers: { cookie: jarHeader(jar), origin: TRUSTED_ORIGIN },
    });
    absorbCookies(cb, jar);
    const sessionEntry = jar.get('__Host-known_session') ?? null;
    return {
      startStatus: start.statusCode,
      startBody,
      cbStatus: cb.statusCode,
      location: String(cb.headers.location ?? ''),
      sessionCookie: sessionEntry,
      jar,
    };
  }

  /**
   * Explicit link from an authenticated product session: re-auth proof ->
   * link start (state cookie) -> mock authorize -> callback.
   */
  async function explicitLink(input: {
    readonly cookie: string;
    readonly csrfToken: string;
    readonly providerId: string;
    readonly email: string;
    readonly name: string;
    readonly callbackURL?: string;
    readonly errorCallbackURL?: string;
    readonly reauth?: { readonly kind: 'password'; readonly password: string } | { readonly kind: 'otp'; readonly email: string; readonly otp: string };
    readonly tamperState?: boolean;
  }): Promise<{
    readonly startStatus: number;
    readonly startBody: unknown;
    readonly cbStatus: number;
    readonly location: string;
    readonly callbackUrl: string | null;
    readonly jar: Map<string, string>;
  }> {
    const jar = new Map<string, string>();
    const cookieValue = input.cookie.split('=', 2)[1]!;
    jar.set('__Host-known_session', decodeURIComponent(cookieValue));
    const start = await post('/oauth2/link', {
      providerId: input.providerId,
      callbackURL: input.callbackURL ?? '/settings',
      ...(input.errorCallbackURL === undefined ? {} : { errorCallbackURL: input.errorCallbackURL }),
      reauth: input.reauth ?? { kind: 'password', password: PASSWORD },
    }, { cookie: jarHeader(jar), 'x-csrf-token': input.csrfToken });
    absorbCookies(start, jar);
    const startBody = start.json() as { url?: string };
    if (typeof startBody.url !== 'string') {
      return { startStatus: start.statusCode, startBody, cbStatus: 0, location: '', callbackUrl: null, jar };
    }
    const authorize = await fetch(startBody.url, { redirect: 'manual' });
    let callbackUrl = String(authorize.headers.get('location') ?? '');
    if (input.tamperState === true && callbackUrl.includes('state=')) {
      callbackUrl = callbackUrl.replace(/state=[^&]*/u, 'state=tampered-state-value');
    }
    const cb = await app.inject({
      method: 'GET',
      url: stripOrigin(callbackUrl),
      headers: { cookie: jarHeader(jar), origin: TRUSTED_ORIGIN },
    });
    absorbCookies(cb, jar);
    return {
      startStatus: start.statusCode,
      startBody,
      cbStatus: cb.statusCode,
      location: String(cb.headers.location ?? ''),
      callbackUrl,
      jar,
    };
  }

  test('the frozen contracts are in force: disableImplicitLinking + registered OAuth paths', async () => {
    // disableImplicitLinking asserted in beforeAll against the real options.
    // The OAuth start/callback must now be REGISTERED (not pending 404) and
    // the start refuses a provider-less request with a stable envelope.
    const start = await post('/sign-in/social', { provider: 'unknown-provider', callbackURL: '/dashboard' });
    assert.notEqual(start.statusCode, 404, 'the OAuth start must be registered');
    assert.equal((start.json() as { error?: { code?: string } }).error?.code, 'invalid_request');
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
  });

  test('first Google login: new auth user, provider account row, business mapping, product /me', async () => {
    const email = uniqueEmail('g-first');
    mock.state.userinfo = { id: 'google-sub-1', email, email_verified: true, name: 'Google First' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'Google First' });
    assert.equal(flow.startStatus, 200);
    assert.equal(flow.cbStatus, 302);
    assert.equal(flow.location, '/dashboard', 'the new-email callback must redirect to the callbackURL');
    assert.ok(flow.sessionCookie, 'the provider login must set the session cookie');

    const userId = await userIdForEmail(email);
    assert.ok(userId, 'the provider login must create the auth user');
    const accounts = await accountRowsForUser(userId);
    assert.deepEqual(accounts, [{ providerId: 'google', accountId: 'google-sub-1' }],
      'the provider account must use the stable provider id and the provider account id');
    const mappings = await mappingForUser(userId);
    assert.equal(mappings.length, 1, 'the provider user must get a business mapping');

    const cookie = `__Host-known_session=${flow.sessionCookie}`;
    const session = await bootstrapSession(cookie);
    const my = await me(cookie);
    assert.equal(my.statusCode, 200);
    const body = my.body as { account?: { id?: string } };
    assert.equal(body.account?.id, session.accountId, '/me must resolve to the provider user business account');
  });

  test('first GitHub login uses its own stable provider identity', async () => {
    const email = uniqueEmail('gh-first');
    mock.state.userinfo = { id: 'github-sub-1', email, email_verified: true, name: 'GitHub First' };
    const flow = await oauthSignIn({ providerId: 'github', email, name: 'GitHub First' });
    assert.equal(flow.startStatus, 200);
    assert.equal(flow.cbStatus, 302);
    assert.equal(flow.location, '/dashboard');
    assert.ok(flow.sessionCookie);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    const accounts = await accountRowsForUser(userId);
    assert.deepEqual(accounts, [{ providerId: 'github', accountId: 'github-sub-1' }]);
  });

  test('unverified local occupancy is adopted by a verified same-email Google login (P1)', async () => {
    const email = uniqueEmail('adopt-unverified');
    const userId = await signUpUnverifiedLocal(email);
    const verifiedBefore = await isolated.runtime.pool.query<{ emailVerified: boolean }>(
      `select "emailVerified" from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verifiedBefore.rows[0]?.emailVerified, false);
    const mappingsBefore = await mappingForUser(userId);
    assert.equal(mappingsBefore.length, 1, 'password sign-up must already have a business mapping');
    const usersBefore = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n from "auth_users"`);

    mock.state.userinfo = { id: 'google-sub-adopt', email, email_verified: true, name: 'Adopt Google' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'Adopt Google' });

    assert.equal(flow.cbStatus, 302);
    assert.equal(flow.location, '/dashboard', 'the adopt callback must complete into the callbackURL');
    assert.ok(flow.sessionCookie, 'verified OAuth adopt must issue a session');
    const usersAfter = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n from "auth_users"`);
    assert.equal(usersAfter.rows[0]!.n, usersBefore.rows[0]!.n, 'adopt must not create a second auth user');
    assert.equal(await userIdForEmail(email), userId, 'adopt must keep the SAME auth_users.id');
    const verifiedAfter = await isolated.runtime.pool.query<{ emailVerified: boolean }>(
      `select "emailVerified" from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verifiedAfter.rows[0]?.emailVerified, true, 'verified OAuth is mailbox proof');
    assert.deepEqual(await accountRowsForUser(userId), [
      { providerId: 'google', accountId: 'google-sub-adopt' },
    ]);
    assert.deepEqual(await mappingForUser(userId), mappingsBefore, 'adopt must reuse the existing business mapping');

    const cookie = `__Host-known_session=${flow.sessionCookie}`;
    const session = await bootstrapSession(cookie);
    const my = await me(cookie);
    assert.equal(my.statusCode, 200);
    assert.equal((my.body as { account?: { id?: string } }).account?.id, session.accountId);
    assert.equal(session.accountId, mappingsBefore[0]!.account_id);
  });

  test('verified local occupancy still refuses same-email Google login (G0 contract)', async () => {
    const email = uniqueEmail('same-local');
    const userId = await signUpLocal(email);
    const usersBefore = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n from "auth_users"`);
    const mappingsBefore = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n from auth_user_account_map`);

    mock.state.userinfo = { id: 'google-sub-2', email, email_verified: true, name: 'Same Email' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'Same Email', errorCallbackURL: '/error' });

    // G0 verified: non-enumerating error redirect, no session, no orphan
    // user, no provider row.
    assert.ok(flow.location.includes('error=account_not_linked'), `location=${flow.location}`);
    assert.equal(flow.sessionCookie, null, 'the same-email callback must NOT issue a session');
    const usersAfter = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n from "auth_users"`);
    assert.equal(usersAfter.rows[0]!.n, usersBefore.rows[0]!.n, 'no orphan auth user may be created');
    assert.equal(await userIdForEmail(email), userId, 'the local user still exists');
    const accounts = await accountRowsForUser(userId);
    assert.deepEqual(accounts, [{ providerId: 'credential', accountId: userId }],
      'no provider account row may be linked to the local user');
    const mappingsAfter = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n from auth_user_account_map`);
    assert.equal(mappingsAfter.rows[0]!.n, mappingsBefore.rows[0]!.n, 'the mapping set must stay unchanged');
    // The redirect stays on the Know-N origin (no open redirect).
    assert.equal(flow.location.startsWith('/'), true, `error redirect must stay relative: ${flow.location}`);
  });

  test('same-email provider login never adopts an account behind a legacy OIDC archive row', async () => {
    const email = uniqueEmail('archive');
    // A business account that only exists as a legacy OIDC identity (B2
    // archive): no auth user, no mapping — the provider claim must NOT
    // resurrect or adopt it.
    const accountId = `legacy-${randomUUID().slice(0, 12)}`;
    await isolated.runtime.pool.query(
      `insert into accounts (id, subject_id, status, email, security_epoch, created_at) values ($1,$2,'active',$3,0,now())`,
      [accountId, `subj-${accountId}`, email],
    );
    await isolated.runtime.pool.query(
      `insert into profiles (account_id, display_name, updated_at) values ($1,'Legacy',now())`, [accountId],
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles (handle, account_id, created_at) values ($1,$2,now())`,
      [`handle_${accountId}`, accountId],
    );
    await isolated.runtime.pool.query(
      `insert into legacy_oidc_identity_archive (issuer, subject, account_id, migration_source, email_verified_claim)
       values ('https://old-issuer.example','old-subject-1',$1,'b2-controlled-import',true)`,
      [accountId],
    );

    mock.state.userinfo = { id: 'google-sub-3', email, email_verified: true, name: 'Archive Claim' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'Archive Claim', errorCallbackURL: '/error' });

    // The archive row is invisible to Better Auth (no auth_users row holds
    // the email): the provider login SUCCEEDS with a brand-new auth user.
    // The non-adoption contract (plan §4.3.4 / G1 ADR §11) is that the bare
    // provider claim must NEVER attach the archived business account —
    // asserted below on the mapping and archive rows.
    assert.equal(flow.cbStatus, 302);
    assert.equal(flow.location, '/dashboard');
    assert.ok(flow.sessionCookie, 'the provider login issues a session for the fresh user');
    const newUserId = await userIdForEmail(email);
    assert.ok(newUserId, 'the provider login creates a new auth user (the archived email is not an auth user)');
    const archive = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from legacy_oidc_identity_archive where account_id = $1`, [accountId],
    );
    assert.equal(archive.rows[0]!.n, 1, 'the archive row must stay intact');
    const adopted = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from auth_user_account_map where account_id = $1`, [accountId],
    );
    assert.equal(adopted.rows[0]!.n, 0, 'the archived account must never be adopted by a provider email claim');
    const mappings = await mappingForUser(newUserId);
    assert.equal(mappings.length, 1, 'the fresh user gets exactly one business mapping');
    assert.notEqual(mappings[0]!.account_id, accountId,
      'the fresh user must map to a NEW business account, never the archived one');
  });

  test('the OAuth start refuses foreign-origin callback URLs and never leaks the client secret', async () => {
    const start = await post('/sign-in/social', {
      provider: 'google',
      callbackURL: 'https://evil.example/steal',
      errorCallbackURL: '/error',
    });
    assert.equal(start.statusCode, 400);
    assert.equal((start.json() as { error?: { code?: string } }).error?.code, 'invalid_request');
    assert.equal(String(start.body).includes('evil.example'), false, 'the rejection must not echo the hostile URL');

    const evilError = await post('/sign-in/social', {
      provider: 'google',
      callbackURL: '/dashboard',
      errorCallbackURL: '//evil.example/steal',
    });
    assert.equal(evilError.statusCode, 400);

    // A legitimate start: the authorization URL carries client_id only —
    // client_secret is a server-side token-endpoint credential.
    const email = uniqueEmail('secret');
    mock.state.userinfo = { id: 'google-sub-4', email, email_verified: true, name: 'Secret Check' };
    const jar = new Map<string, string>();
    const ok = await post('/sign-in/social', { provider: 'google', callbackURL: '/dashboard', errorCallbackURL: '/error' });
    absorbCookies(ok, jar);
    const okBody = ok.json() as { url?: string };
    assert.ok(okBody.url, 'a legitimate start must produce an authorization URL');
    assert.equal(String(ok.body).includes(MOCK_GOOGLE_CLIENT_SECRET), false, 'the start response must not contain the client secret');
    assert.ok(okBody.url.includes(`client_id=${MOCK_GOOGLE_CLIENT_ID}`), 'the authorization URL carries the client_id');
    assert.equal(okBody.url.includes('client_secret'), false, 'the authorization URL must never carry the client secret');

    // Follow the full flow so the token endpoint receives the secret server-side.
    const authorize = await fetch(okBody.url, { redirect: 'manual' });
    const cb = await app.inject({
      method: 'GET',
      url: stripOrigin(String(authorize.headers.get('location') ?? '')),
      headers: { cookie: jarHeader(jar), origin: TRUSTED_ORIGIN },
    });
    assert.equal(cb.statusCode, 302);
    const tokenRequest = mock.state.tokenRequests.at(-1);
    assert.ok(tokenRequest, 'the callback must exchange the code at the token endpoint');
    assert.equal(tokenRequest.clientId, MOCK_GOOGLE_CLIENT_ID);
    assert.equal(tokenRequest.clientSecret, MOCK_GOOGLE_CLIENT_SECRET,
      'the client secret must flow server-side only (token endpoint), never to the browser');
  });

  test('explicit link success: session + Origin/CSRF + password re-auth -> atomic provider account', async () => {
    const email = uniqueEmail('link-ok');
    const userId = await signUpLocal(email);
    // Sign in to get a product session.
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(signIn.statusCode, 200);
    const rawCookies = setCookieEntries(signIn);
    const sessionEntry = rawCookies.find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry, 'sign-in must set the session cookie');
    const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const cookie = `__Host-known_session=${cookieValue}`;
    const { csrfToken, accountId } = await bootstrapSession(cookie);
    const epochBefore = await accountEpoch(accountId);

    mock.state.userinfo = { id: 'google-sub-5', email, email_verified: true, name: 'Linked Google' };
    const flow = await explicitLink({
      cookie,
      csrfToken,
      providerId: 'google',
      email,
      name: 'Linked Google',
      callbackURL: '/settings',
      reauth: { kind: 'password', password: PASSWORD },
    });
    assert.equal(flow.startStatus, 200, `link start must succeed: ${JSON.stringify(flow.startBody)}`);
    assert.equal(flow.cbStatus, 302);
    assert.equal(flow.location, '/settings', 'the link callback must redirect to the settings callbackURL');

    // Atomic result: exactly one provider account row bound to the SAME user
    // and the SAME business account.
    const accounts = await accountRowsForUser(userId);
    assert.deepEqual(accounts, [
      { providerId: 'credential', accountId: userId },
      { providerId: 'google', accountId: 'google-sub-5' },
    ]);
    const mappings = await mappingForUser(userId);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0]!.account_id, accountId, 'the link must not change the business mapping');
    assert.equal(await accountEpoch(accountId), epochBefore + 1n, 'a completed provider link bumps security_epoch once');

    const my = await me(cookie);
    assert.equal(my.statusCode, 401, 'the pre-link session must die with the epoch bump');

    // Positive control: once linked, a provider login with the same email
    // signs into the SAME user instead of erroring.
    const relogin = await oauthSignIn({ providerId: 'google', email, name: 'Linked Google' });
    assert.equal(relogin.cbStatus, 302);
    assert.equal(relogin.location, '/dashboard');
    assert.ok(relogin.sessionCookie, 'the linked provider login must issue a session');
    const reloginUserId = await userIdForEmail(email);
    assert.equal(reloginUserId, userId, 'the provider login must resolve to the linked user');
    assert.equal((await accountRowsForUser(userId)).length, 2, 'no duplicate provider row may appear');
  });

  test('explicit link with a tampered state is rejected and writes nothing', async () => {
    const email = uniqueEmail('link-state');
    const userId = await signUpLocal(email);
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry);
    const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const cookie = `__Host-known_session=${cookieValue}`;
    const { csrfToken } = await bootstrapSession(cookie);

    mock.state.userinfo = { id: 'google-sub-6', email, email_verified: true, name: 'Tampered' };
    const flow = await explicitLink({
      cookie,
      csrfToken,
      providerId: 'google',
      email,
      name: 'Tampered',
      tamperState: true,
      reauth: { kind: 'password', password: PASSWORD },
    });
    assert.equal(flow.startStatus, 200);
    assert.ok(flow.location.includes('error='), `the tampered callback must error: ${flow.location}`);
    assert.equal(flow.location.includes('state_mismatch'), true, `location=${flow.location}`);
    const accounts = await accountRowsForUser(userId);
    assert.deepEqual(accounts, [{ providerId: 'credential', accountId: userId }], 'no provider row may be written');
  });

  test('link callback replay is rejected: one-time code + consumed state, nothing written', async () => {
    const email = uniqueEmail('link-replay');
    const userId = await signUpLocal(email);
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry);
    const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const cookie = `__Host-known_session=${cookieValue}`;
    const { csrfToken } = await bootstrapSession(cookie);

    mock.state.userinfo = { id: 'google-sub-7', email, email_verified: true, name: 'Replay' };
    const first = await explicitLink({ cookie, csrfToken, providerId: 'google', email, name: 'Replay', reauth: { kind: 'password', password: PASSWORD } });
    assert.equal(first.cbStatus, 302);
    assert.equal(first.location, '/settings');
    assert.equal((await accountRowsForUser(userId)).length, 2);

    // Replay the SAME callback URL: the code is spent at the provider and the
    // state row was consumed by the callback — the replay must error and
    // write nothing.
    assert.ok(first.callbackUrl, 'the first callback URL must be captured');
    const replay = await app.inject({
      method: 'GET',
      url: stripOrigin(first.callbackUrl),
      headers: { cookie: jarHeader(first.jar), origin: TRUSTED_ORIGIN },
    });
    assert.ok(String(replay.headers.location ?? '').includes('error='), `the replay must error: ${replay.headers.location ?? ''}`);
    assert.equal(replay.statusCode, 302);

    const accounts = await accountRowsForUser(userId);
    assert.deepEqual(accounts, [
      { providerId: 'credential', accountId: userId },
      { providerId: 'google', accountId: 'google-sub-7' },
    ], 'a replay must not create a duplicate provider account');

    // Direct replay of the consumed authorization code at the provider: the
    // one-time code must be refused.
    const replayBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: [...mock.state.codes.keys()][0]!,
      redirect_uri: `${TRUSTED_ORIGIN}/api/v1/auth/callback/google`,
      client_id: MOCK_GOOGLE_CLIENT_ID,
      client_secret: MOCK_GOOGLE_CLIENT_SECRET,
      code_verifier: 'replayed-verifier',
    });
    const replayed = await fetch(`${mock.origin}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: replayBody.toString(),
    });
    assert.equal(replayed.status, 400, 'a consumed one-time code must be refused by the provider');
    void replay;
  });

  test('PKCE: the token request carries the code_verifier and a wrong verifier is rejected', async () => {
    const email = uniqueEmail('pkce');
    mock.state.userinfo = { id: 'google-sub-8', email, email_verified: true, name: 'PKCE' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'PKCE' });
    assert.equal(flow.cbStatus, 302);
    const tokenRequest = mock.state.tokenRequests.at(-1);
    assert.ok(tokenRequest, 'the callback must exchange the code');
    assert.equal(tokenRequest.hasCodeVerifier, true, 'PKCE code_verifier must reach the token endpoint');

    // A fresh authorization code with a WRONG verifier must fail the S256
    // challenge and stay unconsumed; a missing verifier must also fail.
    const authorize = await fetch(
      `${mock.origin}/authorize?redirect_uri=${encodeURIComponent(`${TRUSTED_ORIGIN}/api/v1/auth/callback/google`)}&state=pkce-state&code_challenge=${encodeURIComponent('invalid-challenge')}&client_id=${MOCK_GOOGLE_CLIENT_ID}`,
      { redirect: 'manual' },
    );
    const freshCode = new URL(String(authorize.headers.get('location') ?? '')).searchParams.get('code');
    assert.ok(freshCode);
    async function tokenAttempt(verifier: string | null): Promise<number> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: freshCode,
        redirect_uri: `${TRUSTED_ORIGIN}/api/v1/auth/callback/google`,
        client_id: MOCK_GOOGLE_CLIENT_ID,
        client_secret: MOCK_GOOGLE_CLIENT_SECRET,
        ...(verifier === null ? {} : { code_verifier: verifier }),
      });
      const res = await fetch(`${mock.origin}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      return res.status;
    }
    assert.equal(await tokenAttempt('definitely-not-the-verifier'), 400, 'a mismatched S256 challenge must be refused');
    assert.equal(await tokenAttempt(null), 400, 'a missing code_verifier must be refused');
    const issued = mock.state.codes.get(freshCode);
    assert.equal(issued?.used, false, 'the code must not be consumed by failed challenges');
  });

  test('an already linked provider is refused before any OAuth round trip', async () => {
    const email = uniqueEmail('already');
    const userId = await signUpLocal(email);
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry);
    const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const cookie = `__Host-known_session=${cookieValue}`;
    const { csrfToken } = await bootstrapSession(cookie);

    mock.state.userinfo = { id: 'google-sub-9', email, email_verified: true, name: 'Already' };
    const first = await explicitLink({ cookie, csrfToken, providerId: 'google', email, name: 'Already', reauth: { kind: 'password', password: PASSWORD } });
    assert.equal(first.cbStatus, 302);
    assert.equal(first.location, '/settings');
    assert.equal((await accountRowsForUser(userId)).length, 2);

    // The completed link revoked the pre-link session. A fresh sign-in still
    // refuses a second link of the same provider before any OAuth round trip.
    const again = await signInProductSession(email);
    const authorizeBefore = mock.state.codes.size;
    const second = await explicitLink({
      cookie: again.cookie,
      csrfToken: again.csrfToken,
      providerId: 'google',
      email,
      name: 'Already',
      reauth: { kind: 'password', password: PASSWORD },
    });
    assert.equal(second.startStatus, 400);
    assert.equal((second.startBody as { error?: { code?: string; message?: string } }).error?.code, 'invalid_request');
    assert.equal(
      (second.startBody as { error?: { message?: string } }).error?.message,
      'This provider is already connected.',
    );
    assert.equal(mock.state.codes.size, authorizeBefore, 'no authorize request may be issued for an already-linked provider');
    assert.equal((await accountRowsForUser(userId)).length, 2, 'no duplicate provider row');
  });

  test('a provider account already linked to another user cannot be linked (unique ownership check)', async () => {
    const emailA = uniqueEmail('owner-a');
    const emailB = uniqueEmail('owner-b');
    await signUpLocal(emailA);
    await signUpLocal(emailB);

    async function sessionFor(email: string): Promise<{ cookie: string; csrfToken: string }> {
      const signIn = await post('/sign-in/email', { email, password: PASSWORD });
      const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
      assert.ok(sessionEntry);
      const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
      const cookie = `__Host-known_session=${cookieValue}`;
      const { csrfToken } = await bootstrapSession(cookie);
      return { cookie, csrfToken };
    }

    const sessionA = await sessionFor(emailA);
    const userIdA = await userIdForEmail(emailA);
    assert.ok(userIdA);

    // User A links the provider account google-sub-10.
    mock.state.userinfo = { id: 'google-sub-10', email: emailA, email_verified: true, name: 'Owner A' };
    const first = await explicitLink({ ...sessionA, providerId: 'google', email: emailA, name: 'Owner A', reauth: { kind: 'password', password: PASSWORD } });
    assert.equal(first.cbStatus, 302);
    assert.equal(first.location, '/settings');

    // User B tries to link the SAME provider account (the controlled provider
    // returns the same id): the callback must refuse the cross-user link.
    const sessionB = await sessionFor(emailB);
    const userIdB = await userIdForEmail(emailB);
    assert.ok(userIdB);
    const second = await explicitLink({ ...sessionB, providerId: 'google', email: emailB, name: 'Owner B', reauth: { kind: 'password', password: PASSWORD } });
    assert.ok(second.location.includes('error='), `the cross-user link must error: ${second.location}`);
    assert.ok(
      second.location.includes('account_already_linked_to_different_user') || second.location.includes('error='),
      `location=${second.location}`,
    );
    const accountsB = await accountRowsForUser(userIdB);
    assert.deepEqual(accountsB, [{ providerId: 'credential', accountId: userIdB }],
      'user B must not gain the provider account');
    const accountsA = await accountRowsForUser(userIdA);
    assert.equal(accountsA.filter((account) => account.providerId === 'google').length, 1,
      'user A keeps exactly one provider row (UNIQUE providerId+accountId)');
  });

  test('unlink refuses the last recovery method and succeeds when another remains', async () => {
    const email = uniqueEmail('unlink');
    const userId = await signUpLocal(email);
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry);
    const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const cookie = `__Host-known_session=${cookieValue}`;
    const { csrfToken } = await bootstrapSession(cookie);

    // Link google so the user has credential + provider.
    mock.state.userinfo = { id: 'google-sub-11', email, email_verified: true, name: 'Unlink' };
    const link = await explicitLink({ cookie, csrfToken, providerId: 'google', email, name: 'Unlink', reauth: { kind: 'password', password: PASSWORD } });
    assert.equal(link.cbStatus, 302);
    assert.equal((await accountRowsForUser(userId)).length, 2);

    // The completed link revoked the pre-link session. Unlink uses a fresh one.
    const again = await signInProductSession(email);
    const unlink = await post('/unlink-account', {
      providerId: 'google',
      accountId: 'google-sub-11',
      reauth: { kind: 'password', password: PASSWORD },
    }, { cookie: again.cookie, 'x-csrf-token': again.csrfToken });
    assert.equal(unlink.statusCode, 200);
    assert.deepEqual((await accountRowsForUser(userId)), [{ providerId: 'credential', accountId: userId }],
      'the provider row must be deleted, the credential stays');
    const my = await me(again.cookie);
    assert.equal(my.statusCode, 200, 'the product session must survive the unlink');

    // Removing the last credential is refused.
    const last = await post('/unlink-account', {
      providerId: 'credential',
      accountId: userId,
      reauth: { kind: 'password', password: PASSWORD },
    }, { cookie: again.cookie, 'x-csrf-token': again.csrfToken });
    assert.equal(last.statusCode, 400);
    assert.equal((last.json() as { error?: { code?: string; message?: string } }).error?.code, 'invalid_request');
    assert.equal(
      (last.json() as { error?: { message?: string } }).error?.message,
      'Keep at least one sign-in method.',
    );
    assert.equal((await accountRowsForUser(userId)).length, 1, 'the last credential must survive');

    // Unlink without a session is refused.
    const noSession = await post('/unlink-account', {
      providerId: 'credential',
      accountId: userId,
      reauth: { kind: 'password', password: PASSWORD },
    });
    assert.equal(noSession.statusCode, 401);
  });

  test('unlink re-auth can be a verified-email OTP for provider-only users', async () => {
    const email = uniqueEmail('otp-reauth');
    // Provider-only user: no password credential.
    mock.state.userinfo = { id: 'google-sub-12', email, email_verified: true, name: 'Otp Reauth' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'Otp Reauth' });
    assert.equal(flow.cbStatus, 302);
    assert.ok(flow.sessionCookie);
    const cookie = `__Host-known_session=${flow.sessionCookie}`;
    const { csrfToken } = await bootstrapSession(cookie);

    // Send the re-auth OTP to the verified email (the send side is the C1
    // email surface; the verify side runs inside the unlink facade).
    await auth.api.sendVerificationOTP({ body: { email, type: 'email-verification' } });
    const otp = lastOtpFor(email);

    // Removing the only recovery method stays refused even with a valid OTP.
    const refused = await post('/unlink-account', {
      providerId: 'google',
      accountId: 'google-sub-12',
      reauth: { kind: 'otp', email, otp },
    }, { cookie, 'x-csrf-token': csrfToken });
    assert.equal(refused.statusCode, 400);
    assert.equal((refused.json() as { error?: { code?: string; message?: string } }).error?.code, 'invalid_request');
    assert.equal(
      (refused.json() as { error?: { message?: string } }).error?.message,
      'Keep at least one sign-in method.',
    );
    const providerOnlyUserId = await userIdForEmail(email);
    assert.ok(providerOnlyUserId, 'the provider-only user must exist');
    assert.equal((await accountRowsForUser(providerOnlyUserId)).length, 1,
      'the only recovery method must survive');

    // A wrong OTP is a re-auth failure (invalid_credentials), never a write.
    await auth.api.sendVerificationOTP({ body: { email, type: 'email-verification' } });
    const wrongOtp = lastOtpFor(email) === '000000' ? '000001' : '000000';
    const wrong = await post('/unlink-account', {
      providerId: 'google',
      accountId: 'google-sub-12',
      reauth: { kind: 'otp', email, otp: wrongOtp },
    }, { cookie, 'x-csrf-token': csrfToken });
    assert.equal(wrong.statusCode, 401);
    assert.equal((wrong.json() as { error?: { code?: string } }).error?.code, 'invalid_credentials');
  });

  test('P3: OAuth-only user sets a password with mailbox OTP; credential appears; last recovery still refused', async () => {
    const email = uniqueEmail('set-password');
    mock.state.userinfo = { id: 'google-sub-p3', email, email_verified: true, name: 'Set Password' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'Set Password' });
    assert.equal(flow.cbStatus, 302);
    assert.ok(flow.sessionCookie, 'the provider login must set the session cookie');
    const cookie = `__Host-known_session=${flow.sessionCookie}`;
    await bootstrapSession(cookie);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/linked-accounts',
      headers: { cookie, origin: TRUSTED_ORIGIN },
    });
    assert.equal(listed.statusCode, 200, `linked-accounts must succeed: ${listed.body}`);
    const listedBody = listed.json() as {
      accounts?: ReadonlyArray<{ providerId?: string; accountId?: string }>;
      hasPassword?: unknown;
      token?: unknown;
    };
    assert.equal(listedBody.hasPassword, false, 'OAuth-only users have no credential');
    assert.deepEqual(listedBody.accounts, [{ providerId: 'google', accountId: 'google-sub-p3' }]);
    assert.equal('token' in listedBody, false, 'R9: linked-accounts must not expose a session token');
    assert.equal(
      listedBody.accounts?.some((account) => account.providerId === 'credential'),
      false,
      'the credential accountId must not appear in the social list',
    );

    const userId = await userIdForEmail(email);
    assert.ok(userId, 'the provider-only user must exist');
    assert.deepEqual(await accountRowsForUser(userId), [{ providerId: 'google', accountId: 'google-sub-p3' }]);

    await auth.api.sendVerificationOTP({ body: { email, type: 'forget-password' } });
    const otp = lastOtpFor(email);
    const reset = await post('/recovery/otp-reset', { email, otp, newPassword: NEW_PASSWORD });
    assert.equal(reset.statusCode, 200, `otp set-password must succeed: ${reset.body}`);
    assert.deepEqual(reset.json(), { status: true });

    const rowsAfter = await accountRowsForUser(userId);
    assert.ok(
      rowsAfter.some((row) => row.providerId === 'credential' && row.accountId === userId),
      `set-password must create a credential row: ${JSON.stringify(rowsAfter)}`,
    );
    assert.ok(
      rowsAfter.some((row) => row.providerId === 'google' && row.accountId === 'google-sub-p3'),
      'the Google recovery method must remain',
    );

    const signIn = await post('/sign-in/email', { email, password: NEW_PASSWORD });
    assert.equal(signIn.statusCode, 200, 'the new password must sign in');
    const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry);
    const newCookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const newCookie = `__Host-known_session=${newCookieValue}`;
    const { csrfToken } = await bootstrapSession(newCookie);

    const listedAfter = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/linked-accounts',
      headers: { cookie: newCookie, origin: TRUSTED_ORIGIN },
    });
    assert.equal(listedAfter.statusCode, 200);
    const afterBody = listedAfter.json() as {
      accounts?: ReadonlyArray<{ providerId?: string; accountId?: string }>;
      hasPassword?: unknown;
    };
    assert.equal(afterBody.hasPassword, true, 'hasPassword must flip after a credential exists');
    assert.deepEqual(
      afterBody.accounts,
      [{ providerId: 'google', accountId: 'google-sub-p3' }],
      'credential accountId must stay out of the social list after set-password',
    );

    const unlinkGoogle = await post('/unlink-account', {
      providerId: 'google',
      accountId: 'google-sub-p3',
      reauth: { kind: 'password', password: NEW_PASSWORD },
    }, { cookie: newCookie, 'x-csrf-token': csrfToken });
    assert.equal(unlinkGoogle.statusCode, 200, `unlink google must succeed once a credential exists: ${unlinkGoogle.body}`);

    const unlinkLast = await post('/unlink-account', {
      providerId: 'credential',
      accountId: userId,
      reauth: { kind: 'password', password: NEW_PASSWORD },
    }, { cookie: newCookie, 'x-csrf-token': csrfToken });
    assert.equal(unlinkLast.statusCode, 400);
    assert.equal((unlinkLast.json() as { error?: { code?: string; message?: string } }).error?.code, 'invalid_request');
    assert.equal(
      (unlinkLast.json() as { error?: { message?: string } }).error?.message,
      'Keep at least one sign-in method.',
    );
    assert.deepEqual(await accountRowsForUser(userId), [{ providerId: 'credential', accountId: userId }],
      'the last recovery method must survive');
  });

  test('recovery after password reset: verified-email OTP proof restores the SAME business account', async () => {
    const email = uniqueEmail('recover');
    const userId = await signUpLocal(email);
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    const sessionEntry = setCookieEntries(signIn).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(sessionEntry);
    const cookieValue = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const cookie = `__Host-known_session=${cookieValue}`;
    const { accountId } = await bootstrapSession(cookie);
    assert.equal((await me(cookie)).statusCode, 200);

    // The recovery request is non-enumerating: identical success for unknown
    // emails and no delivery for them.
    const known = await post('/recovery/password-reset', { email });
    assert.equal(known.statusCode, 200);
    assert.deepEqual(known.json(), { status: true });
    const mailBefore = sink.sentCount;
    const ghost = await post('/recovery/password-reset', { email: uniqueEmail('recover-ghost') });
    assert.equal(ghost.statusCode, 200);
    assert.deepEqual(ghost.json(), { status: true });
    assert.equal(sink.sentCount, mailBefore, 'no reset email may be delivered for unknown emails');

    // OTP-based recovery: send the forget-password OTP (C1 email surface),
    // then run the product recovery route.
    await auth.api.sendVerificationOTP({ body: { email, type: 'forget-password' } });
    const otp = lastOtpFor(email);
    const reset = await post('/recovery/otp-reset', { email, otp, newPassword: NEW_PASSWORD });
    assert.equal(reset.statusCode, 200, `otp reset must succeed: ${reset.body}`);
    assert.deepEqual(reset.json(), { status: true });

    // revokeSessionsOnPasswordReset: every session row is gone.
    const sessions = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_sessions" where "userId" = $1`, [userId],
    );
    assert.equal(sessions.rows[0]!.n, 0, 'the reset must revoke every session');
    const verified = await isolated.runtime.pool.query<{ emailVerified: boolean }>(
      `select "emailVerified" from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verified.rows[0]?.emailVerified, true, 'a forget-password OTP is a verified-email proof');

    // Old password dead, new password signs back into the SAME account.
    const oldPassword = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(oldPassword.statusCode, 401);
    const newPassword = await post('/sign-in/email', { email, password: NEW_PASSWORD });
    assert.equal(newPassword.statusCode, 200);
    const newSessionEntry = setCookieEntries(newPassword).find((entry) => entry.startsWith('__Host-known_session='));
    assert.ok(newSessionEntry);
    const newCookieValue = newSessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const newCookie = `__Host-known_session=${newCookieValue}`;
    const recovered = await bootstrapSession(newCookie);
    assert.equal(recovered.accountId, accountId, 'the recovered session must map to the SAME business account');
    const my = await me(newCookie);
    assert.equal(my.statusCode, 200);
    assert.equal((my.body as { account?: { id?: string } }).account?.id, accountId);

    // A wrong OTP is a non-enumerating invalid_credentials failure.
    await auth.api.sendVerificationOTP({ body: { email, type: 'forget-password' } });
    const wrongOtp = lastOtpFor(email) === '000000' ? '000001' : '000000';
    const wrong = await post('/recovery/otp-reset', { email, otp: wrongOtp, newPassword: 'another-password-789' }); // secret-scan: allow 'another-password-789'
    assert.equal(wrong.statusCode, 401);
    assert.equal((wrong.json() as { error?: { code?: string } }).error?.code, 'invalid_credentials');
  });

  test('a provider email claim can never reset a local password (recovery proof policy)', async () => {
    // The recovery facade rejects the provider-claim proof kind outright
    // (unit-tested); over the wire, a provider login with an existing local
    // email hits the disableImplicitLinking contract instead of any recovery
    // path. The OTP reset route requires the forget-password OTP — a
    // provider claim alone (no OTP) cannot reset anything.
    const email = uniqueEmail('claim-only');
    await signUpLocal(email);
    mock.state.userinfo = { id: 'google-sub-13', email, email_verified: true, name: 'Claim Only' };
    const flow = await oauthSignIn({ providerId: 'google', email, name: 'Claim Only', errorCallbackURL: '/error' });
    assert.ok(flow.location.includes('error=account_not_linked'), `location=${flow.location}`);
    assert.equal(flow.sessionCookie, null);

    const directReset = await post('/recovery/otp-reset', { email, otp: 'not-an-otp', newPassword: NEW_PASSWORD });
    assert.equal(directReset.statusCode, 401, 'an OTP-less claim must never reset the password');
    const stillWorks = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(stillWorks.statusCode, 200, 'the local password must be untouched');
  });
});

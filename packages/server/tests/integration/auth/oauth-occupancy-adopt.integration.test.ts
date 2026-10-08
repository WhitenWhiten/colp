/**
 * S-01: verified-OAuth adopt of unverified occupancy must strip the squatter
 * password, revoke existing sessions, and bump security_epoch. Hits real
 * PostgreSQL + production `composeBetterAuthComposition` with a NODE_ENV=test
 * genericOAuth hook (same style as oauth-linking.integration.test.ts) — not
 * only decide(), and not a hand-copied occupancy holder.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { genericOAuth } from 'better-auth/plugins';
import { loadConfig } from '../../support/test-config.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { type BetterAuthRuntimeConfig } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { signBetterAuthSessionCookieValue } from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createAuthEmailAdapter, createInProcessMailboxSink } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  deriveBrowserSessionCsrfTokenRaw,
  type BrowserSessionAuthority,
} from '../../../src/modules/auth/index.js';
import {
  createSessionBackedExtensionCredentialVerifier,
  ExtensionAuthError,
  parseExtensionAuthConfig,
} from '../../../src/modules/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const MOCK_GOOGLE_CLIENT_ID = 'test-google-client-id';
const MOCK_GOOGLE_CLIENT_SECRET = 'test-google-client-secret'; // secret-scan: allow 'test-google-client-secret'

function testEnv(): Record<string, string> {
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
    AUTH_RATE_LIMIT_MAX: '1000000',
  };
}

interface IssuedCode {
  readonly codeChallenge: string;
  readonly state: string;
  readonly clientId: string;
  used: boolean;
}

interface MockProviderState {
  userinfo: {
    readonly id: string;
    readonly email: string;
    readonly email_verified: boolean;
    readonly name: string;
    readonly picture?: string;
  } | null;
  readonly codes: Map<string, IssuedCode>;
  readonly tokens: Set<string>;
}

function startMockOAuthProvider(): Promise<{
  readonly state: MockProviderState;
  readonly origin: string;
  readonly close: () => Promise<void>;
}> {
  const state: MockProviderState = { userinfo: null, codes: new Map(), tokens: new Set() };
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
      const issued = state.codes.get(code);
      if (!issued || issued.used || params.get('grant_type') !== 'authorization_code') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
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
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/u, '');
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

describeWithPostgres('S-01 OAuth occupancy adopt (real PostgreSQL + real BA callback)', () => {
  let isolated: IsolatedPostgresRuntime;
  let mock: { readonly state: MockProviderState; readonly origin: string; readonly close: () => Promise<void> };
  let authority: BrowserSessionAuthority;
  let app: ReturnType<typeof buildApiApp>;
  let built: BetterAuthRuntimeConfig;
  let colpVerifier: ReturnType<typeof createSessionBackedExtensionCredentialVerifier>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('s01_oauth_occupancy_adopt', {
      maxConnections: 12,
      applicationName: 'known-s01-oauth-occupancy-adopt-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    mock = await startMockOAuthProvider();

    const config = loadConfig(testEnv());
    built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');

    const sink = createInProcessMailboxSink();
    const sender = createAuthEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    const composition = composeBetterAuthComposition({
      config,
      db: isolated.runtime.db,
      authEmail: sender,
      logger: createLogger('silent'),
      testGenericOAuth: genericOAuth({
        config: [{
          providerId: 'google',
          clientId: MOCK_GOOGLE_CLIENT_ID,
          clientSecret: MOCK_GOOGLE_CLIENT_SECRET,
          authorizationUrl: `${mock.origin}/authorize`,
          tokenUrl: `${mock.origin}/token`,
          userInfoUrl: `${mock.origin}/userinfo`,
          scopes: ['email'],
          pkce: true,
        }],
      }),
    });
    assert.ok(composition.browserSessionAuthority, 'compose must wire the production session authority');
    assert.ok(composition.betterAuthRuntime, 'compose must wire the production Better Auth runtime');
    authority = composition.browserSessionAuthority;
    colpVerifier = createSessionBackedExtensionCredentialVerifier({
      config: parseExtensionAuthConfig({
        issuer: 'https://issuer.example.test/',
        clientId: 'known-chromium-extension',
        audience: 'known-sync-api',
        authorizationEndpoint: 'https://issuer.example.test/oauth2/authorize',
        tokenEndpoint: 'https://issuer.example.test/oauth2/token',
        jwksUri: 'https://issuer.example.test/.well-known/jwks.json',
        redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/oauth2',
        extensionIds: ['abcdefghijklmnopabcdefghijklmnop'],
        redirectOrigins: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org'],
        scopes: ['openid', 'known.sync'],
        algorithms: ['RS256'],
        clockSkewSeconds: 30,
        evidenceTtlSeconds: 60,
      }),
      identityIssuer: TRUSTED_ORIGIN,
      sessions: {
        async authenticate(cookieHeader) {
          const actor = await authority.authenticate({ cookie: cookieHeader });
          if (actor === null) return null;
          return {
            accountId: actor.account.id,
            subjectId: actor.account.subjectId,
            sessionId: actor.session.id,
            issuedAt: actor.session.createdAt,
            expiresAt: actor.session.idleExpiresAt,
          };
        },
      },
      identities: {
        async ensure(input) {
          return { issuer: input.issuer, subject: input.subjectId };
        },
      },
    });

    app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
      betterAuthRuntime: composition.betterAuthRuntime,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await mock?.close();
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolated.runtime.pool.query(`delete from known_auth_session_metadata`);
    await isolated.runtime.pool.query(`delete from "auth_sessions"`);
    await isolated.runtime.pool.query(`delete from "auth_accounts"`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);
    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    mock.state.userinfo = null;
    mock.state.codes.clear();
    mock.state.tokens.clear();
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

  async function accountRowsForUser(userId: string) {
    const result = await isolated.runtime.pool.query<{ providerId: string; accountId: string }>(
      `select "providerId", "accountId" from "auth_accounts" where "userId" = $1 order by "providerId"`,
      [userId],
    );
    return result.rows;
  }

  async function signUpUnverifiedLocal(email: string): Promise<string> {
    const res = await post('/sign-up/email', { name: 'Squatter Local', email, password: PASSWORD });
    assert.equal(res.statusCode, 200, 'local sign-up must succeed');
    const userId = await userIdForEmail(email);
    assert.ok(userId, 'sign-up must create the auth user');
    return userId;
  }

  async function oauthSignIn(input: {
    readonly email: string;
    readonly name: string;
    readonly errorCallbackURL?: string;
  }) {
    const jar = new Map<string, string>();
    const start = await post('/sign-in/social', {
      provider: 'google',
      callbackURL: '/dashboard',
      errorCallbackURL: input.errorCallbackURL ?? '/error',
    });
    absorbCookies(start, jar);
    const startBody = start.json() as { url?: string };
    assert.equal(typeof startBody.url, 'string', `oauth start must produce a url: ${JSON.stringify(startBody)}`);
    const authorize = await fetch(startBody.url!, { redirect: 'manual' });
    const callbackUrl = String(authorize.headers.get('location') ?? '');
    const cb = await app.inject({
      method: 'GET',
      url: stripOrigin(callbackUrl),
      headers: { cookie: jarHeader(jar), origin: TRUSTED_ORIGIN },
    });
    absorbCookies(cb, jar);
    return {
      cbStatus: cb.statusCode,
      location: String(cb.headers.location ?? ''),
      sessionCookie: jar.get('__Host-known_session') ?? null,
    };
  }

  async function seedSquatterBaSession(userId: string, accountId: string): Promise<{
    readonly cookie: string;
    readonly sessionId: string;
  }> {
    const sessionId = `ba-sess-${randomUUID().replaceAll('-', '')}`;
    const token = `tok-${randomUUID().replaceAll('-', '')}`;
    const now = new Date();
    await isolated.runtime.pool.query(
      `insert into "auth_sessions" ("id","token","expiresAt","createdAt","updatedAt","ipAddress","userAgent","userId")
       values ($1,$2,$3,$4,$4,'','',$5)`,
      [sessionId, token, new Date(now.getTime() + 86_400_000), now, userId],
    );
    await isolated.runtime.pool.query(
      `insert into known_auth_session_metadata (
        auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
        security_epoch, csrf_token_hash, predecessor_session_id, last_seen_at, revoked_at, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,NULL,$8,NULL,$9)`,
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
    return { cookie: signBetterAuthSessionCookieValue(built.secret, token), sessionId };
  }

  test('adopt strips the password, revokes prior sessions, bumps epoch, and overlays empty profile fields', async () => {
    const email = uniqueEmail('s01-adopt');
    const userId = await signUpUnverifiedLocal(email);
    const mapping = await isolated.runtime.pool.query<{ account_id: string; security_epoch: string }>(
      `select m.account_id, a.security_epoch::text as security_epoch
         from auth_user_account_map m join accounts a on a.id = m.account_id
        where m.auth_user_id = $1`,
      [userId],
    );
    assert.equal(mapping.rows.length, 1);
    const accountId = mapping.rows[0]!.account_id;
    const epochBefore = BigInt(mapping.rows[0]!.security_epoch);

    await isolated.runtime.pool.query(
      `update profiles set display_name = '', about = 'squatter about' where account_id = $1`,
      [accountId],
    );
    const squatter = await seedSquatterBaSession(userId, accountId);

    mock.state.userinfo = {
      id: 'google-sub-s01',
      email,
      email_verified: true,
      name: 'Victim Google',
      picture: 'https://cdn.example/victim.png',
    };
    const flow = await oauthSignIn({ email, name: 'Victim Google' });
    assert.equal(flow.cbStatus, 302);
    assert.equal(flow.location, '/dashboard');
    assert.ok(flow.sessionCookie, 'adopt must mint the new OAuth session after revokeAll');

    assert.deepEqual(await accountRowsForUser(userId), [
      { providerId: 'google', accountId: 'google-sub-s01' },
    ]);
    const signIn = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(signIn.statusCode, 401);
    assert.equal((signIn.json() as { error?: { code?: string } }).error?.code, 'invalid_credentials');

    const oldMe = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `__Host-known_session=${encodeURIComponent(squatter.cookie)}` },
    });
    assert.equal(oldMe.statusCode, 401, 'the squatter BA session must die');
    assert.equal(
      (oldMe.json() as { error?: { code?: string } }).error?.code,
      'authentication_required',
    );

    await assert.rejects(
      () => colpVerifier.verify({ authorization: `Bearer ${squatter.cookie}` }),
      (error: unknown) => error instanceof ExtensionAuthError && error.reason === 'invalid_token',
      'a COLP session cookie minted before adopt must fail closed after the epoch bump',
    );

    const newCookie = `__Host-known_session=${flow.sessionCookie}`;
    const newMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: newCookie } });
    assert.equal(newMe.statusCode, 200, 'the new OAuth session must survive revokeAll');
    assert.equal((newMe.json() as { account?: { id?: string } }).account?.id, accountId);

    const epochAfter = await isolated.runtime.pool.query<{ security_epoch: string }>(
      `select security_epoch::text as security_epoch from accounts where id = $1`,
      [accountId],
    );
    assert.ok(BigInt(epochAfter.rows[0]!.security_epoch) > epochBefore, 'security_epoch must increase');
    const leftoverSquatter = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int as n from "auth_sessions" where id = $1`,
      [squatter.sessionId],
    );
    assert.equal(
      leftoverSquatter.rows[0]!.n,
      0,
      'adopt must revoke prior sessions through production compose occupancy wiring',
    );

    await colpVerifier.verify({ authorization: `Bearer ${flow.sessionCookie}` });

    const profile = await isolated.runtime.pool.query<{ display_name: string; about: string; avatar_url: string | null }>(
      `select display_name, about, avatar_url from profiles where account_id = $1`,
      [accountId],
    );
    assert.equal(profile.rows[0]?.display_name, 'Victim Google');
    assert.equal(profile.rows[0]?.about, '');
    assert.equal(profile.rows[0]?.avatar_url, 'https://cdn.example/victim.png');
  });

  test('provider email_verified !== true still refuses unverified occupancy', async () => {
    const email = uniqueEmail('s01-unverified-idp');
    const userId = await signUpUnverifiedLocal(email);
    const epochBefore = await isolated.runtime.pool.query<{ security_epoch: string }>(
      `select a.security_epoch::text as security_epoch
         from auth_user_account_map m join accounts a on a.id = m.account_id
        where m.auth_user_id = $1`,
      [userId],
    );
    mock.state.userinfo = { id: 'google-sub-unverified', email, email_verified: false, name: 'Unverified Google' };
    const flow = await oauthSignIn({ email, name: 'Unverified Google' });
    assert.ok(flow.location.includes('error=SOCIAL_ACCOUNT_ALREADY_LINKED'), `location=${flow.location}`);
    assert.equal(flow.sessionCookie, null);
    assert.deepEqual(await accountRowsForUser(userId), [
      { providerId: 'credential', accountId: userId },
    ]);
    const verified = await isolated.runtime.pool.query<{ emailVerified: boolean }>(
      `select "emailVerified" from "auth_users" where id = $1`, [userId],
    );
    assert.equal(verified.rows[0]?.emailVerified, false);
    const epochAfter = await isolated.runtime.pool.query<{ security_epoch: string }>(
      `select a.security_epoch::text as security_epoch
         from auth_user_account_map m join accounts a on a.id = m.account_id
        where m.auth_user_id = $1`,
      [userId],
    );
    assert.equal(
      epochAfter.rows[0]?.security_epoch,
      epochBefore.rows[0]?.security_epoch,
      'refused occupancy must not bump security_epoch',
    );
  });
});

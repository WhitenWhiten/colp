/**
 * S-03: Google first login (created already verified) fills accounts.email
 * after the first product session. Unverified occupancy must still leave it null.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { betterAuth } from 'better-auth';
import { genericOAuth } from 'better-auth/plugins';
import { loadConfig } from '../../support/test-config.js';
import {
  buildBetterAuthOptions,
  mountBetterAuthAllowlist,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createAuthEmailAdapter, createInProcessMailboxSink } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const CLIENT_ID = 'test-google-client-id';
const CLIENT_SECRET = 'test-google-client-secret'; // secret-scan: allow 'test-google-client-secret'

function testEnv(): Record<string, string> {
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
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    BETTER_AUTH_BODY_LIMIT_BYTES: '1024',
    AUTH_RATE_LIMIT_MAX: '1000000',
  };
}

interface IssuedCode {
  readonly codeChallenge: string;
  readonly state: string;
  used: boolean;
}

interface MockProviderState {
  userinfo: { readonly id: string; readonly email: string; readonly email_verified: boolean; readonly name: string } | null;
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
      if (!redirectUri) {
        res.writeHead(400); res.end(); return;
      }
      const code = `mock-code-${randomUUID().replaceAll('-', '')}`;
      state.codes.set(code, { codeChallenge: codeChallenge ?? '', state: stateParam ?? '', used: false });
      res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(stateParam ?? '')}` });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const issued = state.codes.get(params.get('code') ?? '');
      if (!issued || issued.used || params.get('grant_type') !== 'authorization_code') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      if (issued.codeChallenge !== '') {
        const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
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
        res.writeHead(401); res.end(); return;
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
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

describeWithPostgres('OAuth first login fills verified product email (S-03)', () => {
  let isolated: IsolatedPostgresRuntime;
  let mock: Awaited<ReturnType<typeof startMockOAuthProvider>>;
  let app: ReturnType<typeof buildApiApp>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('s03_oauth_email_fill', {
      maxConnections: 8,
      applicationName: 'known-s03-oauth-email-fill',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    mock = await startMockOAuthProvider();
    const config = loadConfig(testEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built);
    const sink = createInProcessMailboxSink();
    const sender = createAuthEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    const makeOptions = () => {
      const options = buildBetterAuthOptions({
        enabled: true,
        config: built,
        database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
        authEmail: sender,
        businessAccount: { unitOfWork: createPostgresBusinessAccountUnitOfWork(isolated.runtime.db) },
        logger: createLogger('silent'),
        onOAuthOccupancyAdopted: async () => {},
      });
      options.plugins = [...(options.plugins ?? []), genericOAuth({
        config: [{
          providerId: 'google',
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          authorizationUrl: `${mock.origin}/authorize`,
          tokenUrl: `${mock.origin}/token`,
          userInfoUrl: `${mock.origin}/userinfo`,
          scopes: ['email'],
          pkce: true,
        }],
      })];
      return options;
    };
    const auth = betterAuth(makeOptions());
    app = buildApiApp({
      config,
      betterAuthRuntime: { mount: (fastifyApp) => mountBetterAuthAllowlist(fastifyApp, auth, built) },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await mock?.close();
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolated.runtime.pool.query(`delete from known_auth_session_metadata`);
    await isolated.runtime.pool.query(`delete from "auth_sessions"`);
    await isolated.runtime.pool.query(`delete from "auth_accounts"`);
    await isolated.runtime.pool.query(`delete from auth_user_account_map`);
    await isolated.runtime.pool.query(`delete from "auth_users"`);
    await isolated.runtime.pool.query(`delete from profile_handles`);
    await isolated.runtime.pool.query(`delete from profiles`);
    await isolated.runtime.pool.query(`delete from accounts`);
    mock.state.userinfo = null;
    mock.state.codes.clear();
    mock.state.tokens.clear();
  });

  test('verified Google first login fills accounts.email after the first session', async () => {
    const email = uniqueEmail('g-fill');
    mock.state.userinfo = { id: 'google-sub-fill', email, email_verified: true, name: 'Google Fill' };
    const start = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/social`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ provider: 'google', callbackURL: '/dashboard', errorCallbackURL: '/error' }),
    });
    assert.equal(start.statusCode, 200, start.payload);
    const authorizeUrl = (start.json() as { url?: string }).url;
    assert.ok(authorizeUrl);
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    const callbackUrl = String(authorize.headers.get('location') ?? '');
    const cookies = start.cookies as Array<{ name: string; value: string }>;
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const cb = await app.inject({
      method: 'GET',
      url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
      headers: { cookie: cookieHeader, origin: TRUSTED_ORIGIN },
    });
    assert.equal(cb.statusCode, 302, cb.payload);
    const session = (cb.cookies as Array<{ name: string; value: string }>)
      .find((cookie) => cookie.name === '__Host-known_session');
    assert.ok(session, 'verified OAuth first login must set a session cookie');
    const user = await isolated.runtime.pool.query<{ id: string; emailVerified: boolean }>(
      `select id, "emailVerified" as "emailVerified" from "auth_users" where email = $1`, [email],
    );
    assert.equal(user.rows[0]?.emailVerified, true);
    const product = await isolated.runtime.pool.query<{ email: string | null }>(
      `select a.email from accounts a
         join auth_user_account_map m on m.account_id = a.id
        where m.auth_user_id = $1`,
      [user.rows[0]!.id],
    );
    assert.equal(product.rows[0]?.email, email, 'first verified OAuth session must fill accounts.email');
  });

  test('unverified Google first login does not write accounts.email', async () => {
    const email = uniqueEmail('g-unverified');
    mock.state.userinfo = { id: 'google-sub-unverified', email, email_verified: false, name: 'Google Unverified' };
    const start = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/social`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ provider: 'google', callbackURL: '/dashboard', errorCallbackURL: '/error' }),
    });
    assert.equal(start.statusCode, 200, start.payload);
    const authorizeUrl = (start.json() as { url?: string }).url;
    assert.ok(authorizeUrl);
    const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
    const callbackUrl = String(authorize.headers.get('location') ?? '');
    assert.ok(callbackUrl.length > 0);
    const cookies = start.cookies as Array<{ name: string; value: string }>;
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    const callback = await app.inject({
      method: 'GET',
      url: new URL(callbackUrl).pathname + new URL(callbackUrl).search,
      headers: { cookie: cookieHeader, origin: TRUSTED_ORIGIN },
    });
    assert.notEqual(callback.statusCode, 500, callback.payload);
    const claimed = await isolated.runtime.pool.query<{ id: string }>(
      `select id from accounts where email = $1`,
      [email],
    );
    assert.equal(claimed.rows.length, 0, 'unverified OAuth must not claim accounts.email');
    const user = await isolated.runtime.pool.query<{ id: string; emailVerified: boolean }>(
      `select id, "emailVerified" as "emailVerified" from "auth_users" where email = $1`, [email],
    );
    const product = user.rows[0] === undefined
      ? { rows: [] as Array<{ email: string | null }> }
      : await isolated.runtime.pool.query<{ email: string | null }>(
        `select a.email from accounts a
           join auth_user_account_map m on m.account_id = a.id
          where m.auth_user_id = $1`,
        [user.rows[0].id],
      );
    assert.equal(user.rows.length === 0 || user.rows[0]!.emailVerified === false, true);
    if (user.rows.length > 0) {
      assert.equal(product.rows.length, 1);
      assert.equal(product.rows[0]!.email, null, 'unproved OAuth occupancy must not store accounts.email');
    } else {
      assert.equal(product.rows.length, 0);
    }
  });
});

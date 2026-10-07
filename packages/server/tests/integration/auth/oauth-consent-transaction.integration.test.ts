/**
 * Consent-transaction lookup: real authorize→consent signed query, then
 * GET /oauth2/consent-transaction. Fail-closed on tamper / expiry / missing
 * sig / no session. Never trusts query `client_name`.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { makeSignature } from 'better-auth/crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildBetterAuthOptions,
  createBetterAuthRuntime,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { canonicalizeOAuthQueryParams } from '../../../src/infrastructure/auth/oauth-consent-transaction.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { applyBetterAuth17LibrarySchemaExpand } from '../../support/better-auth-postgres.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { createBuiltinIssuerPkce } from '../../support/builtin-issuer-test-helpers.js';
import {
  T09_CIMD_CLIENT_ID,
  T09_CIMD_CLIENT_NAME,
  T09_CIMD_REDIRECT,
  T09_PASSWORD,
  T09_SESSION_COOKIE,
  T09_TRUSTED_ORIGIN,
  t09Authorize,
  t09CookieHeader,
  t09IssuerMcpEnv,
  t09SessionCookieOf,
  t09TestFetchClientMetadataResource,
  t09UniqueEmail,
} from '../../support/mcp-oauth-builtin-issuer-helpers.js';

const BASE_PATH = '/api/v1/auth';
const EVIL_REDIRECT = 'https://evil.example/callback';
const BA_SECRET = 'test-better-auth-secret-0123456789abcdef';

describeWithPostgres('OAuth consent-transaction signed redirect lookup', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: FastifyInstance;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  let sessionCookie: string;
  let oauthQuery: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('oauth_consent_tx', {
      maxConnections: 8,
      applicationName: 'known-oauth-consent-tx',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    mailbox = createAuthTestMailbox();
    const config = loadConfig(t09IssuerMcpEnv({ KNOWN_FEATURE_MCP_READ: 'false' }));
    const built = buildBetterAuthConfig({ ...config.betterAuth });
    assert.ok(built?.oauthIssuer, 'issuer-on config must produce oauthIssuer');
    await applyBetterAuth17LibrarySchemaExpand(buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
    }));
    const runtime = createBetterAuthRuntime({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
      authEmail: createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') }),
      businessAccount: { unitOfWork: createPostgresBusinessAccountUnitOfWork(isolated.runtime.db) },
      logger: createLogger('silent'),
      testFetchClientMetadataResource: t09TestFetchClientMetadataResource,
    });
    assert.ok(runtime, 'issuer-on runtime must construct');
    app = buildApiApp({
      config,
      betterAuthRuntime: runtime,
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
    });
    const email = t09UniqueEmail('consent-tx');
    const signup = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-up/email`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Consent Tx User', email, password: T09_PASSWORD }),
    });
    assert.equal(signup.statusCode, 200, signup.body);
    const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
    assert.ok(mail, 'verification email must be delivered');
    const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'verification email must carry the token');
    const verify = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/verify-email?token=${token}`,
      headers: { origin: T09_TRUSTED_ORIGIN },
    });
    assert.equal(verify.statusCode, 200, verify.body);
    const signin = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/email`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, password: T09_PASSWORD }),
    });
    assert.equal(signin.statusCode, 200, signin.body);
    const cookie = t09SessionCookieOf(signin);
    assert.ok(cookie, 'verified sign-in must set the session cookie');
    sessionCookie = cookie;
    const pkce = createBuiltinIssuerPkce();
    const authorize = await t09Authorize(app, {
      clientId: T09_CIMD_CLIENT_ID,
      cookie: sessionCookie,
      challenge: pkce.challenge,
      redirectUri: T09_CIMD_REDIRECT,
    });
    assert.ok(authorize.location, `authorize must redirect (${authorize.statusCode}): ${authorize.body}`);
    const redirected = new URL(authorize.location, T09_TRUSTED_ORIGIN);
    assert.equal(redirected.pathname.endsWith('/consent'), true, `expected consent redirect, got ${authorize.location}`);
    oauthQuery = redirected.search.startsWith('?') ? redirected.search.slice(1) : redirected.search;
    assert.match(oauthQuery, /sig=/u);
    assert.equal(new URLSearchParams(oauthQuery).get('redirect_uri'), T09_CIMD_REDIRECT);
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await isolated?.close();
  });

  function lookup(query: string, cookie?: string) {
    const url = `${BASE_PATH}/oauth2/consent-transaction?oauth_query=${encodeURIComponent(query)}&client_name=${encodeURIComponent('Evil App')}`;
    return app.inject({
      method: 'GET',
      url,
      headers: cookie === undefined ? {} : { cookie: t09CookieHeader(T09_SESSION_COOKIE, cookie) },
    });
  }

  test('happy path returns the signed redirect_uri and issuer client_name, never query client_name', async () => {
    const response = await lookup(oauthQuery, sessionCookie);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      client_id?: unknown;
      client_name?: unknown;
      redirect_uri?: unknown;
    };
    assert.equal(body.client_id, T09_CIMD_CLIENT_ID);
    assert.equal(body.redirect_uri, T09_CIMD_REDIRECT);
    assert.equal(body.client_name, T09_CIMD_CLIENT_NAME);
    assert.equal(response.body.includes('Evil App'), false);
  });

  test('tampering redirect_uri without a new sig fails closed with no URI in the body', async () => {
    const tampered = new URLSearchParams(oauthQuery);
    tampered.set('redirect_uri', EVIL_REDIRECT);
    const response = await lookup(tampered.toString(), sessionCookie);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.body.includes(EVIL_REDIRECT), false);
    assert.equal(response.body.includes(T09_CIMD_REDIRECT), false);
    assert.equal(response.body.includes('redirect_uri'), false);
    const body = response.json() as { error?: { code?: unknown } };
    assert.equal(body.error?.code, 'invalid_request');
  });

  test('stripping sig fails closed with no URI in the body', async () => {
    const stripped = new URLSearchParams(oauthQuery);
    stripped.delete('sig');
    const response = await lookup(stripped.toString(), sessionCookie);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.body.includes(T09_CIMD_REDIRECT), false);
    assert.equal(response.body.includes('redirect_uri'), false);
  });

  test('an expired but re-signed query fails closed with no URI in the body', async () => {
    const expired = new URLSearchParams(oauthQuery);
    expired.delete('sig');
    expired.set('exp', String(Math.floor(Date.now() / 1_000) - 30));
    const signature = await makeSignature(canonicalizeOAuthQueryParams(expired).toString(), BA_SECRET);
    expired.set('sig', signature);
    const response = await lookup(expired.toString(), sessionCookie);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.body.includes(T09_CIMD_REDIRECT), false);
    assert.equal(response.body.includes('redirect_uri'), false);
  });

  test('unauthenticated lookup is 401 and does not leak the redirect URI', async () => {
    const response = await lookup(oauthQuery);
    assert.equal(response.statusCode, 401, response.body);
    const body = response.json() as { error?: { code?: unknown } };
    assert.equal(body.error?.code, 'authentication_required');
    assert.equal(response.body.includes(T09_CIMD_REDIRECT), false);
    assert.equal(response.body.includes('redirect_uri'), false);
  });
});

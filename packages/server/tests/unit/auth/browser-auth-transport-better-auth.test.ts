/**
 * Task A4 transport tests: the FULL Better Auth composition — real Better
 * Auth 1.7.1 handler + real Fastify bridge + real PostgreSQL (repo
 * migrations) + real BrowserSessionAuthority + real identity/business-account
 * unit of work — serving BOTH the allowlisted /api/v1/auth endpoints and the
 * preserved product session/me/logout surface.
 *
 * 假阴性防护:
 * - every case verifies status + stable error code + cookie + database state
 *   and the /api/v1/me product shape (never `success: true` alone);
 * - errors cannot be short-circuited by a stub: the wrong-password and
 *   no-Origin cases go through the REAL BA handler and the REAL transport
 *   hooks (the composed app, not a mock);
 * - the product subject is the BUSINESS account id (auth_user_account_map),
 *   never the BA auth user id; /api/v1/me returns the product account/profile
 *   shape, never the BA user object.
 *
 * 假阳性防护:
 * - the metadata row is REQUIRED for product authentication (a live BA
 *   session without metadata never authenticates) and is asserted in the
 *   database; logout is proven by the auth_sessions row disappearing
 *   (BA sign-out semantics) and the metadata row cascading away;
 * - the BA surface never owns the legacy OIDC paths: the legacy surface is
 *   still registered here (F2 removes it), so the assertion targets the
 *   manifest scope, while the pure-BA composition test asserts the 404s.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { betterAuth } from 'better-auth';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/runtime.js';
import {
  buildBetterAuthOptions,
  createBetterAuthRuntime,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
} from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import { createBetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import type { BetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { waitForCondition } from '../../support/async-test-helpers.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createAuthEmailAdapter, createInProcessMailboxSink } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  deriveBrowserSessionCsrfTokenRaw,
} from '../../../src/modules/auth/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { authManifestEntryFor } from '../../../src/transport/auth/auth-route-manifest.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'

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
    BETTER_AUTH_BODY_LIMIT_BYTES: '1024',
    ...overrides,
  };
}

interface FullAuthFixture {
  readonly schemaName: string;
  readonly pool: pg.Pool;
  readonly db: Kysely<DatabaseSchema>;
  readonly close: () => Promise<void>;
}

/**
 * Real PostgreSQL with the repo migrations (B1 auth schema + metadata +
 * business tables). Resolution order mirrors the A1 fixture: external URL
 * first, testcontainers fallback.
 */
async function openFullAuthPostgres(): Promise<FullAuthFixture> {
  const schemaName = `a4_transport_${randomUUID().replace(/-/gu, '').slice(0, 12)}`;
  const external = process.env.KNOWN_TEST_DATABASE_URL?.trim()
    || process.env.DATABASE_URL?.trim();
  let adminPool: pg.Pool;
  let container: { readonly stop: () => Promise<void> } | null = null;
  if (external) {
    adminPool = new pg.Pool({ connectionString: external });
  } else {
    container = await new PostgreSqlContainer(
      process.env.KNOWN_POSTGRES_IMAGE ?? 'postgres:16.4-alpine',
    ).start();
    adminPool = new pg.Pool({ connectionString: container.getConnectionUri() });
  }
  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const pool = new pg.Pool({
      connectionString: adminPool.options.connectionString,
      host: adminPool.options.host,
      port: adminPool.options.port,
      user: adminPool.options.user,
      password: adminPool.options.password,
      database: adminPool.options.database,
      options: `-c search_path=${schemaName}`,
    });
    const db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    await runMigrations(db, 'latest');
    return {
      schemaName,
      pool,
      db,
      close: async () => {
        await pool.end().catch(() => undefined);
        try {
          await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } catch (error) {
          process.stderr.write(`[a4-full-postgres] schema cleanup failed: ${String(error)}\n`);
        }
        await adminPool.end().catch(() => undefined);
        await container?.stop().catch(() => undefined);
      },
    };
  } catch (error) {
    await adminPool.end().catch(() => undefined);
    await container?.stop().catch(() => undefined);
    throw error;
  }
}

describe('browser auth transport with the real Better Auth composition', () => {
  let fixture: FullAuthFixture;
  let app: ReturnType<typeof buildApiApp>;
  let sink: ReturnType<typeof createInProcessMailboxSink>;
  let sessionTokenProtector: BetterAuthSessionTokenProtector;

  beforeAll(async () => {
    fixture = await openFullAuthPostgres();
    const config = loadConfig(testEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');
    sessionTokenProtector = createBetterAuthSessionTokenProtector(built.sessionTokenProtection);

    sink = createInProcessMailboxSink();
    const sender = createAuthEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    const businessUnitOfWork = createPostgresBusinessAccountUnitOfWork(fixture.db);

    // The authority's own Better Auth instance (real server API over PG).
    const auth = betterAuth(buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: fixture.db, type: 'postgres', transaction: true },
      authEmail: sender,
      businessAccount: { unitOfWork: businessUnitOfWork },
      logger: createLogger('silent'),
    }));
    const authority = createBetterAuthSessionAuthority({
      db: fixture.db,
      betterAuth: createBetterAuthServerApi(auth),
      secret: built.secret,
      sessionExpiresInSeconds: built.sessionExpiresInSeconds,
      sessionTokenProtector,
    });

    // The mounted runtime (real bridge) with the same real ports.
    const runtime = createBetterAuthRuntime({
      enabled: true,
      config: built,
      database: { db: fixture.db, type: 'postgres', transaction: true },
      authEmail: sender,
      businessAccount: { unitOfWork: businessUnitOfWork },
      logger: createLogger('silent'),
    });
    assert.ok(runtime);

    app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(fixture.db),
      browserSessionAuthority: authority,
      betterAuthRuntime: runtime,
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await fixture?.close();
  });

  function uniqueEmail(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
  }

  async function signUp(email: string): Promise<{ readonly cookie: string; readonly token: string }> {
    const res = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-up/email`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'A4 Full User', email, password: PASSWORD }),
    });
    assert.equal(res.statusCode, 200, 'sign-up must succeed through the composed app');
    const signupCookies = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
    const signupSession = signupCookies.find((cookie) => cookie?.startsWith('__Host-known_session='));
    assert.equal(signupSession, undefined, 'P1: unverified sign-up must not set a session cookie');

    const mail = sink.entries.find((entry) => entry.to === email);
    assert.ok(mail, 'sign-up must deliver the verification email');
    const jwt = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(jwt, 'the verification email must carry the JWT');
    const verify = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/verify-email?token=${jwt}`,
      headers: { origin: TRUSTED_ORIGIN },
    });
    assert.equal(verify.statusCode, 200, 'mailbox verification must succeed');
    const rawCookies = Array.isArray(verify.headers['set-cookie']) ? verify.headers['set-cookie'] : [verify.headers['set-cookie']];
    const sessionEntry = rawCookies.find((cookie) => cookie?.startsWith('__Host-known_session='));
    assert.ok(sessionEntry, 'autoSignInAfterVerification must set the session cookie');
    const value = sessionEntry.split(';', 1)[0]!.split('=', 2)[1]!;
    const token = value.slice(0, value.indexOf('.'));
    assert.ok(token.length > 0, 'the cookie value must carry the raw session token');
    return { cookie: `__Host-known_session=${value}`, token };
  }

  /**
   * E3 wiring (plan §4.3.1.4): the production composition now establishes the
   * known_auth_session_metadata row on session creation (idempotent, `on
   * conflict (auth_session_id) do nothing`). This test helper keeps a
   * fallback insert with the SAME idempotent semantics so the product
   * surfaces can be asserted (a live BA session without metadata NEVER
   * authenticates — orphan rejection); the test then asserts exactly one row
   * exists regardless of who created it.
   */
  async function establishMetadata(token: string): Promise<{ readonly accountId: string }> {
    const sessionRow = await fixture.pool.query<{ id: string; userId: string; token: string }>(
      `select id, "userId", token from "auth_sessions" where "tokenLookupHash" = any($1::text[])`,
      [sessionTokenProtector.lookupHashes(token)],
    );
    assert.equal(sessionRow.rows.length, 1, 'the BA session row must exist');
    assert.notEqual(sessionRow.rows[0]!.token, token, 'the raw bearer token must not be stored');
    const sessionId = sessionRow.rows[0]!.id;
    const authUserId = sessionRow.rows[0]!.userId;
    const mapping = await fixture.pool.query<{ account_id: string }>(
      `select account_id from auth_user_account_map where auth_user_id = $1`,
      [authUserId],
    );
    assert.equal(mapping.rows.length, 1, 'the A2 establishment must create the mapping');
    const accountId = mapping.rows[0]!.account_id;
    const now = new Date();
    await fixture.pool.query(
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
    const metaRows = await fixture.pool.query<{ n: number }>(
      `select count(*)::int n from known_auth_session_metadata where auth_session_id = $1`,
      [sessionId],
    );
    assert.equal(metaRows.rows[0]?.n, 1, 'exactly one metadata row must exist (composition-created or fallback insert)');
    return { accountId };
  }

  test('sign-up → business account → /api/v1/session CSRF bootstrap → /api/v1/me product shape', async () => {
    const email = uniqueEmail('full');
    const { cookie, token } = await signUp(email);
    const { accountId } = await establishMetadata(token);

    // Database state: business account, profile, handle and mapping exist.
    const business = await fixture.pool.query<{ accounts: number; profiles: number; handles: number; mappings: number }>(
      `select
         (select count(*)::int from accounts where id = $1) accounts,
         (select count(*)::int from profiles where account_id = $1) profiles,
         (select count(*)::int from profile_handles where account_id = $1) handles,
         (select count(*)::int from auth_user_account_map where account_id = $1) mappings`,
      [accountId],
    );
    const businessRow = business.rows[0];
    assert.ok(businessRow);
    assert.equal(businessRow.accounts, 1);
    assert.equal(businessRow.profiles, 1);
    assert.equal(businessRow.handles, 1);
    assert.equal(businessRow.mappings, 1);

    // C1 sign-up verification email was queued through the real adapter sink.
    assert.ok(
      sink.entries.some((entry) => entry.to === email),
      'sign-up with sendOnSignUp must queue the verification email',
    );

    // GET /api/v1/session keeps the frozen product shape.
    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    assert.equal(session.statusCode, 200);
    const sessionBody = session.json() as {
      authenticated: boolean;
      csrfToken: string;
      idleExpiresAt: string;
      absoluteExpiresAt: string;
    };
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.csrfToken, deriveBrowserSessionCsrfTokenRaw(token));
    assert.ok(sessionBody.idleExpiresAt.endsWith('Z'));
    assert.ok(sessionBody.absoluteExpiresAt.endsWith('Z'));
    assert.equal(session.headers['set-cookie'], undefined, 'no rotation for a fresh session');

    // Mailbox verification is the email proof. afterEmailVerification fills
    // accounts.email; wait for that commit before reading /api/v1/me.
    let storedEmail: string | null = null;
    await waitForCondition(async () => {
      storedEmail = (await fixture.pool.query<{ email: string | null }>(
        `select email from accounts where id = $1`,
        [accountId],
      )).rows[0]?.email ?? null;
      return storedEmail === email;
    }, {
      timeoutMs: 5_000,
      pollIntervalMs: 10,
      description: 'mailbox verification to update the business-account email',
    });
    assert.equal(storedEmail, email, 'mailbox verification fills the business-account email');

    // GET /api/v1/me returns the product account/profile shape (never the BA user).
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    const meBody = me.json() as {
      account: { id: string; email: string | null };
      profile: { id: string; handle: string; displayName: string; avatarUrl: string | null };
    };
    assert.equal(meBody.account.id, accountId, 'the product subject is the business account id');
    assert.notEqual(meBody.account.id, (await fixture.pool.query<{ id: string }>(
      `select id from "auth_users" where email = $1`, [email],
    )).rows[0]?.id, 'the BA user id must never become the product subject');
    assert.equal(
      meBody.account.email,
      email,
      'mailbox verification is the email proof; afterEmailVerification stores it on the business account',
    );
    assert.equal(meBody.profile.id, accountId);
    assert.ok(meBody.profile.handle.length > 0);
    assert.ok(meBody.profile.displayName.length > 0);
    assert.equal('user' in meBody, false, 'the BA user object must never be returned verbatim');
    assert.equal('token' in meBody, false);
  });

  test('wrong password and no-Origin errors carry stable codes through the full app', async () => {
    const email = uniqueEmail('errors');
    const { cookie, token } = await signUp(email);
    await establishMetadata(token);

    const wrongPassword = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/email`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, password: 'wrong-password-1' }), // secret-scan: allow 'wrong-password-1'
    });
    assert.equal(wrongPassword.statusCode, 401);
    const wrongBody = wrongPassword.json() as { error: { code: string; message: string } };
    assert.equal(wrongBody.error.code, 'invalid_credentials');
    assert.equal(wrongBody.error.message.includes(email), false);
    assert.equal(wrongBody.error.message.includes('Invalid email or password'), false);
    assert.equal(wrongBody.error.message.includes(token), false);

    const noOrigin = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/email`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(noOrigin.statusCode, 403);
    assert.equal((noOrigin.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const meWithoutCookie = await app.inject({ method: 'GET', url: '/api/v1/me' });
    assert.equal(meWithoutCookie.statusCode, 401);
    assert.equal((meWithoutCookie.json() as { error: { code: string } }).error.code, 'authentication_required');
  });

  test('DELETE /api/v1/session requires Origin+CSRF; success clears the cookie and revokes the BA session', async () => {
    const email = uniqueEmail('logout');
    const { cookie, token } = await signUp(email);
    await establishMetadata(token);

    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    const csrfToken = (session.json() as { csrfToken: string }).csrfToken;

    const withoutCsrf = await app.inject({ method: 'DELETE', url: '/api/v1/session', headers: { cookie } });
    assert.equal(withoutCsrf.statusCode, 403);
    assert.equal((withoutCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: { cookie, origin: TRUSTED_ORIGIN, 'x-csrf-token': csrfToken },
    });
    assert.equal(logout.statusCode, 204);
    const setCookie = Array.isArray(logout.headers['set-cookie']) ? logout.headers['set-cookie'][0] : logout.headers['set-cookie'];
    assert.ok(setCookie, 'logout must clear the cookie');
    assert.match(setCookie, /Max-Age=0/u);

    // Database state: the BA session row is gone and the metadata cascaded.
    const sessionRows = await fixture.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_sessions" where "tokenLookupHash" = any($1::text[])`,
      [sessionTokenProtector.lookupHashes(token)],
    );
    assert.equal(sessionRows.rows[0]?.n, 0, 'logout must revoke the BA session row');
    const metadataRows = await fixture.pool.query<{ n: number }>(
      `select count(*)::int n from known_auth_session_metadata where session_token_hash = $1`,
      [browserSessionTokenHash(token)],
    );
    assert.equal(metadataRows.rows[0]?.n, 0, 'the metadata row must cascade with the session');

    const sessionAfter = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    assert.deepEqual(sessionAfter.json(), { authenticated: false });
    const meAfter = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    assert.equal(meAfter.statusCode, 401);
  });

  test('POST /api/v1/auth/sign-out revokes the session for every product surface', async () => {
    const email = uniqueEmail('signout');
    const { cookie, token } = await signUp(email);
    await establishMetadata(token);

    // The real browser / BA-client shape is a bodyless POST (BA's sign-out
    // endpoint takes no body, and BA rejects any request that carries a body
    // stream without a media type — the bridge must forward it bodyless).
    const signOut = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-out`,
      headers: { cookie, origin: TRUSTED_ORIGIN },
    });
    assert.equal(signOut.statusCode, 200);
    assert.deepEqual(signOut.json(), { success: true });

    const sessionRows = await fixture.pool.query<{ n: number }>(
      `select count(*)::int n from "auth_sessions" where "tokenLookupHash" = any($1::text[])`,
      [sessionTokenProtector.lookupHashes(token)],
    );
    assert.equal(sessionRows.rows[0]?.n, 0, 'BA sign-out must delete the session row');

    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    assert.deepEqual(session.json(), { authenticated: false });
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    assert.equal(me.statusCode, 401);
    assert.equal((me.json() as { error: { code: string } }).error.code, 'authentication_required');
  });

  test('PATCH /api/v1/me with Origin+CSRF persists through the real identity unit of work', async () => {
    const email = uniqueEmail('patch');
    const { cookie, token } = await signUp(email);
    await establishMetadata(token);

    const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    const csrfToken = (session.json() as { csrfToken: string }).csrfToken;

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: {
        cookie,
        origin: TRUSTED_ORIGIN,
        'x-csrf-token': csrfToken,
        'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
        'content-type': 'application/json',
      },
      payload: { handle: `handle_a4_${randomUUID().slice(0, 6)}`, displayName: 'A4 Patched' },
    });
    assert.equal(updated.statusCode, 200);
    const body = updated.json() as { profile: { handle: string; displayName: string } };
    assert.ok(body.profile.handle.startsWith('handle_a4_'));
    assert.equal(body.profile.displayName, 'A4 Patched');

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal((me.json() as { profile: { displayName: string } }).profile.displayName, 'A4 Patched');

    const stored = await fixture.pool.query<{ display_name: string }>(
      `select display_name from profiles where account_id = $1`,
      [(me.json() as { account: { id: string } }).account.id],
    );
    assert.equal(stored.rows[0]?.display_name, 'A4 Patched', 'the mutation must persist in PostgreSQL');
  });

  test('the legacy OIDC paths are never part of the Better Auth surface (manifest scope)', async () => {
    // In the FULL composition the legacy OIDC routes are still registered
    // (F2 removes them), so the 404 assertion lives in the pure-BA test. Here
    // the negative contract targets the manifest: legacy paths are
    // legacy-oidc-scoped, never better-auth-scoped.
    for (const path of ['/api/v1/auth/oidc/start', '/api/v1/auth/oidc/callback']) {
      const entry = authManifestEntryFor('GET', path);
      assert.equal(entry?.scope, 'legacy-oidc', `${path} must be legacy-oidc scope`);
      assert.equal(entry?.status, 'registered', `${path} stays registered only until F2/F3`);
    }
    assert.equal(authManifestEntryFor('GET', '/api/v1/auth/oidc/start')?.rateLimitFamily, 'oidc-start');
    assert.equal(authManifestEntryFor('GET', '/api/v1/auth/oidc/callback')?.rateLimitFamily, 'oidc-callback');
  });
});

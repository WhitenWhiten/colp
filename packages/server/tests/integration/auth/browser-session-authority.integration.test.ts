/**
 * Task A3 integration tests: BrowserSessionAuthority over REAL PostgreSQL +
 * the REAL Better Auth 1.7.1 server API (A1 runtime seam — never mocked).
 *
 * 假阴性防护:
 * - every cookie is a REAL signed BA cookie (`<token>.<HMAC>` with the BA
 *   secret) resolved by the REAL `auth.api.getSession` against the real
 *   `auth_sessions` rows (not a mock getSession);
 * - the rotation tests read the REAL database: the predecessor partial unique
 *   index must hold exactly ONE successor row, the predecessor metadata must
 *   be revoked, and concurrent bootstraps must return the SAME successor
 *   cookie (single winner);
 * - the CSRF flow ends in a REAL product mutation (PATCH /api/v1/me) through
 *   buildApiApp with the returned CSRF.
 *
 * 假阳性防护:
 * - revoking the Better Auth session (row deletion, BA sign-out semantics)
 *   must make the REAL product route 401 — no stub can satisfy it;
 * - deleting the legacy `sessions` rows must NOT break the new authority, and
 *   legacy rows present must NOT let an unauthorized request succeed;
 * - the actor's account id is the PRODUCT business account id, never the BA
 *   auth user id.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { betterAuth } from 'better-auth';
import type { McpStoredPlan } from '@know-n/colp/mcp';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildBetterAuthOptions,
  type BetterAuthRuntimeConfig,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
  createPostgresBrowserSessionUnitOfWork,
  signBetterAuthSessionCookieValue,
} from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  BROWSER_SESSION_LIVE_CAP,
  browserSessionCsrfTokenHash,
  browserSessionTokenHash,
  createBrowserSessionAuthority,
  deriveBrowserSessionCsrfTokenRaw,
  type BrowserSessionAuthority,
} from '../../../src/modules/auth/index.js';
import { createPhase4bMcpWriteApprovalApi } from '../../../src/modules/mcp/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { TEST_SESSION_TOKEN_PROTECTION, createTestSessionTokenProtector } from '../../support/better-auth-session-token-protection.js';

const BA_SECRET = 'integration-test-better-auth-secret-0123456789';
const BETTER_AUTH_EMAIL = 'integration@example.test';
const SESSION_TOKEN_PROTECTOR = createTestSessionTokenProtector();

function baRuntimeConfig(): BetterAuthRuntimeConfig {
  return {
    baseURL: 'http://localhost',
    basePath: '/api/v1/auth',
    secret: BA_SECRET,
    sessionTokenProtection: TEST_SESSION_TOKEN_PROTECTION,
    trustedOrigins: ['http://localhost'],
    cookieName: '__Host-known_session',
    sessionExpiresInSeconds: 86_400,
    sessionUpdateAgeSeconds: 60,
    bodyLimitBytes: 1024 * 1024,
    emailOtp: null,
    social: null,
    passwordHash: {
      hash: async (password: string) => `dummy:${password}`,
      verify: async () => false,
    },
  };
}

describeWithPostgres('A3 browser session authority PostgreSQL + real Better Auth', () => {
  let isolated: IsolatedPostgresRuntime;
  let auth: ReturnType<typeof betterAuth>;
  let authority: BrowserSessionAuthority;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('a3_browser_session_authority', {
      maxConnections: 10,
      applicationName: 'known-a3-browser-session-authority-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    auth = betterAuth(buildBetterAuthOptions({
      enabled: true,
      config: baRuntimeConfig(),
      database: {
        db: isolated.runtime.db,
        type: 'postgres',
        transaction: true,
      },
    }));
    authority = createBetterAuthSessionAuthority({
      db: isolated.runtime.db,
      betterAuth: createBetterAuthServerApi(auth),
      secret: BA_SECRET,
      sessionExpiresInSeconds: 86_400,
      sessionTokenProtector: SESSION_TOKEN_PROTECTOR,
    });
  }, 120_000);

  /** Every case starts from an empty auth surface (per-case database cleanup). */
  beforeEach(async () => {
    // Sync-chain children first (FK RESTRICT chains into accounts), then the
    // auth surface; resource_id_ledger rows are immutable by trigger and stay.
    await isolated.runtime.pool.query(`delete from sync_sessions`);
    await isolated.runtime.pool.query(`delete from sync_extension_credentials`);
    await isolated.runtime.pool.query(`delete from sync_replicas`);
    await isolated.runtime.pool.query(`delete from sync_replica_generations`);
    await isolated.runtime.pool.query(`delete from sync_replica_id_ledger`);
    // nodes/collections reference each other (deferred root FK), so both must
    // be emptied in ONE transaction.
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
  });

  afterAll(async () => {
    await isolated?.close();
  });

  async function seedAuthUser(userId: string, email: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into "auth_users" ("id","name","email","emailVerified") values ($1,$2,$3,true)`,
      [userId, `name-${userId}`, email],
    );
  }

  async function seedBusinessAccount(accountId: string, email: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into accounts(id, subject_id, status, email) values ($1,$2,'active',$3)`,
      [accountId, `subj-${accountId}`, email],
    );
    await isolated.runtime.pool.query(
      `insert into profiles(account_id, display_name) values ($1,$2)`,
      [accountId, `Profile ${accountId}`],
    );
    await isolated.runtime.pool.query(
      `insert into profile_handles(handle, account_id) values ($1,$2)`,
      [`handle_${accountId}`, accountId],
    );
  }

  async function seedMapping(authUserId: string, accountId: string): Promise<void> {
    await isolated.runtime.pool.query(
      `insert into auth_user_account_map(auth_user_id, account_id) values ($1,$2)`,
      [authUserId, accountId],
    );
  }

  /**
   * Creates a REAL Better Auth session row and returns the signed cookie the
   * browser would hold (the same signature scheme BA uses; verified by BA's
   * own getSignedCookie on the next request).
   */
  async function seedBaSession(
    input: {
      readonly userId: string;
      readonly sessionId?: string;
      readonly token?: string;
      readonly expiresAt?: Date;
      readonly createdAt?: Date;
    },
  ): Promise<{ readonly token: string; readonly cookie: string; readonly sessionId: string }> {
    const sessionId = input.sessionId ?? `ba-sess-${randomUUID().replaceAll('-', '')}`;
    const token = input.token ?? `tok-${randomUUID().replaceAll('-', '')}`;
    const createdAt = input.createdAt ?? new Date();
    const expiresAt = input.expiresAt ?? new Date(createdAt.getTime() + 86_400_000);
    await isolated.runtime.pool.query(
      `insert into "auth_sessions" ("id","token","expiresAt","createdAt","updatedAt","ipAddress","userAgent","userId")
       values ($1,$2,$3,$4,$4,'','',$5)`,
      [sessionId, token, expiresAt, createdAt, input.userId],
    );
    return { token, sessionId, cookie: signBetterAuthSessionCookieValue(BA_SECRET, token) };
  }

  async function seedMetadata(
    input: {
      readonly authSessionId: string;
      readonly token: string;
      readonly accountId: string;
      readonly idleExpiresAt?: Date;
      readonly absoluteExpiresAt?: Date;
      readonly securityEpoch?: bigint;
      readonly revoked?: boolean;
      readonly createdAt?: Date;
      readonly lastSeenAt?: Date;
      readonly csrfTokenHash?: string;
    },
  ): Promise<void> {
    const createdAt = input.createdAt ?? new Date();
    await isolated.runtime.pool.query(
      `insert into known_auth_session_metadata (
        auth_session_id, session_token_hash, account_id, idle_expires_at, absolute_expires_at,
        security_epoch, csrf_token_hash, predecessor_session_id, last_seen_at, revoked_at, created_at
       ) values ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10)`,
      [
        input.authSessionId,
        browserSessionTokenHash(input.token),
        input.accountId,
        input.idleExpiresAt ?? new Date(createdAt.getTime() + 86_400_000),
        input.absoluteExpiresAt ?? new Date(createdAt.getTime() + 30 * 86_400_000),
        (input.securityEpoch ?? 0n).toString(),
        input.csrfTokenHash ?? browserSessionCsrfTokenHash(deriveBrowserSessionCsrfTokenRaw(input.token)),
        input.lastSeenAt ?? createdAt,
        input.revoked === true ? createdAt : null,
        createdAt,
      ],
    );
  }

  /** Seeds a fully usable session: auth user + account + mapping + BA row + metadata. */
  async function seedUsableSession(
    input: {
      readonly userId?: string;
      readonly accountId?: string;
      readonly email?: string;
      readonly createdAtAgoMs?: number;
      readonly idleExpiresAt?: Date;
      readonly absoluteExpiresAt?: Date;
      readonly securityEpoch?: bigint;
      readonly revoked?: boolean;
    } = {},
  ): Promise<{ readonly token: string; readonly cookie: string; readonly sessionId: string; readonly userId: string; readonly accountId: string }> {
    const userId = input.userId ?? 'ba-user-1';
    const accountId = input.accountId ?? 'acct-1';
    const createdAt = new Date(Date.now() - (input.createdAtAgoMs ?? 0));
    await seedAuthUser(userId, input.email ?? `${BETTER_AUTH_EMAIL}`);
    await seedBusinessAccount(accountId, input.email ?? `${BETTER_AUTH_EMAIL}`);
    await seedMapping(userId, accountId);
    const session = await seedBaSession({ userId, createdAt });
    await seedMetadata({
      authSessionId: session.sessionId,
      token: session.token,
      accountId,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      securityEpoch: input.securityEpoch,
      revoked: input.revoked,
      createdAt,
    });
    return { ...session, userId, accountId };
  }

  function cookieHeader(cookie: string): string {
    return `__Host-known_session=${encodeURIComponent(cookie)}`;
  }

  async function rowCount(sqlText: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(`select count(*)::int n ${sqlText}`);
    return result.rows[0]?.n ?? 0;
  }

  test('authenticate resolves a real BA session to the product actor; subject is the business account id', async () => {
    const { cookie, sessionId, userId, accountId } = await seedUsableSession({ createdAtAgoMs: 60_000 });

    const actor = await authority.authenticate({ cookie: cookieHeader(cookie) });
    assert.ok(actor, 'expected the real BA session to authenticate');
    assert.equal(actor.account.id, accountId);
    assert.notEqual(actor.account.id, userId, 'the BA auth user id must never become the product subject');
    assert.equal(actor.session.id, sessionId);
    assert.equal(actor.session.accountId, accountId);
    // The session view tokenHash is the sha256 digest of the BA token.
    const meta = await isolated.runtime.pool.query<{ session_token_hash: string }>(
      `select session_token_hash from known_auth_session_metadata where auth_session_id = $1`,
      [sessionId],
    );
    assert.equal(actor.session.tokenHash, meta.rows[0]?.session_token_hash);
  });

  test('revoking the BA session makes the real product route 401 (no mock of getSession)', async () => {
    const { cookie } = await seedUsableSession({ createdAtAgoMs: 60_000 });
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
    });
    try {
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookieHeader(cookie) },
      });
      assert.equal(before.statusCode, 200);

      // BA sign-out semantics: the session row is deleted (spike §3.4); the
      // metadata row cascades away with it (real FK).
      await isolated.runtime.pool.query(`delete from "auth_sessions" where "token" = $1`, [
        cookie.slice(0, cookie.lastIndexOf('.')),
      ]);
      assert.equal(
        await rowCount(`from known_auth_session_metadata`),
        0,
        'the metadata row must cascade-delete with its BA session row',
      );

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookieHeader(cookie) },
      });
      assert.equal(after.statusCode, 401);
      assert.equal((after.json() as { error: { code: string } }).error.code, 'authentication_required');
      const session = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: cookieHeader(cookie) },
      });
      assert.deepEqual(session.json(), { authenticated: false });
    } finally {
      await app.close();
    }
  });

  test('legacy sessions rows neither help nor break the new authority', async () => {
    // 1) A legacy sessions row for the same account does NOT authenticate a
    //    BA session without metadata (orphan).
    const { cookie, sessionId } = await seedUsableSession({ createdAtAgoMs: 60_000 });
    await isolated.runtime.pool.query(`delete from known_auth_session_metadata where auth_session_id = $1`, [sessionId]);
    const token = cookie.slice(0, cookie.lastIndexOf('.'));
    await isolated.runtime.pool.query(
      `insert into sessions (id, account_id, idle_expires_at, absolute_expires_at, csrf_token_hash, token_hash, security_epoch, rotated_from_session_id, last_seen_at, revoked_at, created_at)
       values ('legacy-sess-1','acct-1', now() + interval '1 day', now() + interval '30 days', 'x', $1, 0, NULL, now(), NULL, now())`,
      [browserSessionTokenHash(token)],
    );
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);

    // 2) Deleting every legacy sessions row does NOT break the new authority.
    await isolated.runtime.pool.query(`delete from sessions`);
    // Distinct auth surface rows (the part-1 seed is still present).
    const restored = await seedUsableSession({ userId: 'ba-user-2', accountId: 'acct-2', email: 'acct-2@example.test', createdAtAgoMs: 60_000 });
    const actor = await authority.authenticate({ cookie: cookieHeader(restored.cookie) });
    assert.ok(actor, 'the new authority must work after the legacy sessions rows are gone');
    assert.equal(actor.account.id, 'acct-2');
  });

  test('idle expiry, absolute expiry, epoch mismatch and disabled account fail closed over the real DB', async () => {
    // Idle expired.
    const idle = await seedUsableSession({
      createdAtAgoMs: 60_000,
      idleExpiresAt: new Date(Date.now() - 1000),
    });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(idle.cookie) }), null);

    // Absolute expired. The DB CHECK (idle_expires_at <= absolute_expires_at)
    // forces idle to be expired too; the authority's expiry gate treats both
    // deadlines the same (never authenticatable). Each seed needs its own auth
    // user/account rows (earlier seeds stay in the database).
    const absolute = await seedUsableSession({
      userId: 'ba-user-2',
      accountId: 'acct-2',
      email: 'acct-2@example.test',
      createdAtAgoMs: 60_000,
      idleExpiresAt: new Date(Date.now() - 1000),
      absoluteExpiresAt: new Date(Date.now() - 1000),
    });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(absolute.cookie) }), null);

    // Revoked metadata.
    const revoked = await seedUsableSession({ userId: 'ba-user-3', accountId: 'acct-3', email: 'acct-3@example.test', createdAtAgoMs: 60_000, revoked: true });
    assert.equal(await authority.authenticate({ cookie: cookieHeader(revoked.cookie) }), null);

    // Epoch mismatch: bump the account epoch like revokeAll does.
    const epoch = await seedUsableSession({ userId: 'ba-user-4', accountId: 'acct-4', email: 'acct-4@example.test', createdAtAgoMs: 60_000 });
    await isolated.runtime.pool.query(
      `update accounts set security_epoch = security_epoch + 1 where id = $1`,
      [epoch.accountId],
    );
    assert.equal(await authority.authenticate({ cookie: cookieHeader(epoch.cookie) }), null);

    // Disabled account.
    const disabled = await seedUsableSession({ userId: 'ba-user-5', accountId: 'acct-5', email: 'acct-5@example.test', createdAtAgoMs: 60_000 });
    await isolated.runtime.pool.query(
      `update accounts set status = 'disabled' where id = $1`,
      [disabled.accountId],
    );
    assert.equal(await authority.authenticate({ cookie: cookieHeader(disabled.cookie) }), null);
  });

  test('CSRF round trip: GET /api/v1/session CSRF drives a real product mutation', async () => {
    const { cookie } = await seedUsableSession({ createdAtAgoMs: 60_000 });
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
    });
    try {
      const sessionResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: cookieHeader(cookie) },
      });
      assert.equal(sessionResponse.statusCode, 200);
      const sessionBody = sessionResponse.json() as {
        authenticated: boolean;
        csrfToken: string;
        idleExpiresAt: string;
        absoluteExpiresAt: string;
      };
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.idleExpiresAt.endsWith('Z'), true);
      assert.equal(sessionBody.absoluteExpiresAt.endsWith('Z'), true);
      const token = cookie.slice(0, cookie.lastIndexOf('.'));
      assert.equal(sessionBody.csrfToken, deriveBrowserSessionCsrfTokenRaw(token));

      const mutation = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: {
          cookie: cookieHeader(cookie),
          origin: 'https://app.example.test',
          'x-csrf-token': sessionBody.csrfToken,
          'known-command-id': '123e4567-e89b-42d3-a456-426614174000',
          'content-type': 'application/json',
        },
        payload: { handle: 'handle_acct_1', displayName: 'Integration User' },
      });
      assert.equal(mutation.statusCode, 200);
      assert.equal(
        (mutation.json() as { profile: { displayName: string } }).profile.displayName,
        'Integration User',
      );

      const badCsrf = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: {
          cookie: cookieHeader(cookie),
          origin: 'https://app.example.test',
          'x-csrf-token': 'wrong-token',
          'known-command-id': '123e4567-e89b-42d3-a456-426614174001',
          'content-type': 'application/json',
        },
        payload: { handle: 'handle_acct_1', displayName: 'Not Applied' },
      });
      assert.equal(badCsrf.statusCode, 403);
      assert.equal((badCsrf.json() as { error: { code: string } }).error.code, 'csrf_failed');
    } finally {
      await app.close();
    }
  });

  test('rotation is CAS single-winner over the real predecessor partial unique index', async () => {
    const { cookie, sessionId } = await seedUsableSession({ createdAtAgoMs: 16 * 60_000 });

    // Barrier: both bootstraps enter their transaction write phase together,
    // so both attempt the successor mint + predecessor claim concurrently.
    let arrived = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const uow = createPostgresBrowserSessionUnitOfWork(isolated.runtime.db, {
      secret: BA_SECRET,
      sessionExpiresInSeconds: 86_400,
      sessionTokenProtector: SESSION_TOKEN_PROTECTOR,
      faultInjector: {
        beforeCallback: async () => {
          arrived += 1;
          if (arrived === 2) release?.();
          await gate;
        },
      },
    });
    const concurrentAuthority = createBrowserSessionAuthority({
      unitOfWork: uow,
      betterAuth: createBetterAuthServerApi(auth),
    });

    const [first, second] = await Promise.allSettled([
      concurrentAuthority.bootstrap({ cookie: cookieHeader(cookie) }),
      concurrentAuthority.bootstrap({ cookie: cookieHeader(cookie) }),
    ]);
    assert.equal(first.status, 'fulfilled', String(first.status === 'rejected' ? first.reason : ''));
    assert.equal(second.status, 'fulfilled', String(second.status === 'rejected' ? second.reason : ''));
    const results = [first, second].map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<BrowserSessionAuthority['bootstrap']>>>).value);
    for (const result of results) {
      assert.equal(result.authenticated, true, 'both concurrent bootstraps must succeed');
      assert.equal(result.rotated, true);
    }
    const winnerCookie = results[0]!.rotatedCookieValue;
    assert.ok(winnerCookie);
    assert.equal(
      results[1]!.rotatedCookieValue,
      winnerCookie,
      'exactly one winner mints; the loser converges to the SAME successor cookie',
    );

    // Real database evidence: exactly ONE successor for the predecessor.
    const successorCount = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from known_auth_session_metadata where predecessor_session_id = $1`,
      [sessionId],
    );
    assert.equal(
      successorCount.rows[0]?.n,
      1,
      'the predecessor partial unique index must admit exactly one successor',
    );
    const predecessor = await isolated.runtime.pool.query<{ revoked_at: Date | null }>(
      `select revoked_at from known_auth_session_metadata where auth_session_id = $1`,
      [sessionId],
    );
    assert.notEqual(predecessor.rows[0]?.revoked_at, null, 'the predecessor metadata must be retired');

    // The successor cookie authenticates through the real BA API.
    const successorActor = await authority.authenticate({ cookie: cookieHeader(winnerCookie) });
    assert.ok(successorActor);
    assert.equal(successorActor.account.id, 'acct-1');

    // A later bootstrap with the OLD cookie converges to the winner cookie.
    const converged = await authority.bootstrap({ cookie: cookieHeader(cookie) });
    assert.ok(converged.authenticated);
    assert.equal(converged.rotatedCookieValue, winnerCookie);
  });

  test('logout is idempotent and revokes the BA session + metadata over the real DB', async () => {
    const { cookie, token } = await seedUsableSession({ createdAtAgoMs: 60_000 });
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
    });
    try {
      const sessionResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: cookieHeader(cookie) },
      });
      const csrfToken = (sessionResponse.json() as { csrfToken: string }).csrfToken;

      const logout = await app.inject({
        method: 'DELETE',
        url: '/api/v1/session',
        headers: { cookie: cookieHeader(cookie), origin: 'https://app.example.test', 'x-csrf-token': csrfToken },
      });
      assert.equal(logout.statusCode, 204);
      assert.equal(
        await rowCount(`from "auth_sessions" where "token" = '${token}'`),
        0,
        'the BA session row must be deleted by signOut',
      );
      assert.equal(await rowCount(`from known_auth_session_metadata`), 0, 'metadata cascades with the BA row');

      const logout2 = await app.inject({
        method: 'DELETE',
        url: '/api/v1/session',
        headers: { cookie: cookieHeader(cookie), origin: 'https://app.example.test', 'x-csrf-token': csrfToken },
      });
      assert.equal(logout2.statusCode, 204, 'logout must be idempotent');

      const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: cookieHeader(cookie) } });
      assert.equal(me.statusCode, 401);
    } finally {
      await app.close();
    }
  });

  test('P4: two cookies, revoke B by id, A still authenticates, B get-session is null', async () => {
    const first = await seedUsableSession({ createdAtAgoMs: 60_000 });
    const second = await seedBaSession({ userId: first.userId });
    await seedMetadata({
      authSessionId: second.sessionId,
      token: second.token,
      accountId: first.accountId,
      lastSeenAt: new Date(Date.now() - 5_000),
      createdAt: new Date(Date.now() - 5_000),
    });
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
    });
    const ba = createBetterAuthServerApi(auth);
    try {
      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/sessions',
        headers: { cookie: cookieHeader(first.cookie) },
      });
      assert.equal(listed.statusCode, 200, listed.body);
      const listedBody = listed.json() as {
        sessions: Array<{ id: string; createdAt: string; updatedAt: string; current: boolean }>;
      };
      assert.equal(listedBody.sessions.length, 2);
      assert.equal(listedBody.sessions.find((item) => item.id === first.sessionId)?.current, true);
      assert.equal(listedBody.sessions.find((item) => item.id === second.sessionId)?.current, false);
      assert.equal(JSON.stringify(listedBody).includes('token'), false, 'R9: list JSON must not include token');

      const sessionResponse = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie: cookieHeader(first.cookie) },
      });
      const csrfToken = (sessionResponse.json() as { csrfToken: string }).csrfToken;

      const revoked = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions/revoke',
        headers: {
          cookie: cookieHeader(first.cookie),
          origin: 'https://app.example.test',
          'x-csrf-token': csrfToken,
          'content-type': 'application/json',
        },
        payload: { sessionId: second.sessionId },
      });
      assert.equal(revoked.statusCode, 200, revoked.body);

      const epoch = await isolated.runtime.pool.query<{ security_epoch: string }>(
        `select security_epoch from accounts where id = $1`,
        [first.accountId],
      );
      assert.equal(epoch.rows[0]?.security_epoch, '0', 'revoke-one must not bump security_epoch');

      assert.ok(await authority.authenticate({ cookie: cookieHeader(first.cookie) }), 'A must still authenticate');
      assert.equal(await authority.authenticate({ cookie: cookieHeader(second.cookie) }), null);
      assert.ok(await ba.getSession({ cookie: cookieHeader(first.cookie) }), 'A get-session must still work');
      assert.equal(await ba.getSession({ cookie: cookieHeader(second.cookie) }), null, 'B get-session must be null');
    } finally {
      await app.close();
    }
  });

  test('P-07: listLiveForAccount LIMIT 50; evictOldestLiveForAccount kicks oldest', async () => {
    const first = await seedUsableSession();
    const extras = await seedExtraLiveSessions({
      userId: first.userId,
      accountId: first.accountId,
      count: 50,
    });
    assert.equal(await countLiveMetadata(first.accountId), 51);

    const listed = await authority.listLiveSessions({
      accountId: first.accountId,
      currentAuthSessionId: first.sessionId,
    });
    assert.equal(listed.length, BROWSER_SESSION_LIVE_CAP);
    assert.equal(listed[0]?.id, first.sessionId);
    assert.equal(listed[0]?.current, true);
    const oldestId = extras[extras.length - 1]!;
    assert.equal(listed.some((item) => item.id === oldestId), false);

    const uow = createPostgresBrowserSessionUnitOfWork(isolated.runtime.db, {
      secret: BA_SECRET,
      sessionExpiresInSeconds: 86_400,
      sessionTokenProtector: SESSION_TOKEN_PROTECTOR,
    });
    const evicted = await uow.execute((ports) => ports.store.evictOldestLiveForAccount({
      accountId: first.accountId,
      keepAuthSessionId: first.sessionId,
      now: new Date(),
      cap: BROWSER_SESSION_LIVE_CAP,
    }));
    assert.equal(evicted, 1);
    assert.equal(await countLiveMetadata(first.accountId), BROWSER_SESSION_LIVE_CAP);

    const oldest = await isolated.runtime.pool.query<{ revoked_at: Date | null }>(
      `select revoked_at from known_auth_session_metadata where auth_session_id = $1`,
      [oldestId],
    );
    // deleteAuthSessionById matches revokeSessionById: the BA row dies and
    // metadata cascades with it. If the row remains, it must be revoked.
    assert.equal(
      oldest.rows.length === 0 || oldest.rows[0]?.revoked_at != null,
      true,
      'oldest live session must be revoked or cascade-deleted with the BA row',
    );
    assert.equal(await rowCount(`from "auth_sessions" where id = '${oldestId}'`), 0);

    const epoch = await isolated.runtime.pool.query<{ security_epoch: string }>(
      `select security_epoch from accounts where id = $1`,
      [first.accountId],
    );
    assert.equal(epoch.rows[0]?.security_epoch, '0');
    assert.ok(await authority.authenticate({ cookie: cookieHeader(first.cookie) }));
  });

  test('P-07: GET /api/v1/auth/sessions does not write last_seen_at', async () => {
    const first = await seedUsableSession({ createdAtAgoMs: 60_000 });
    const rewound = new Date(Date.now() - 120_000);
    await isolated.runtime.pool.query(
      `update known_auth_session_metadata set last_seen_at = $1 where auth_session_id = $2`,
      [rewound, first.sessionId],
    );
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: 'https://app.example.test',
      ALLOWED_ORIGINS: 'https://app.example.test',
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
    });
    try {
      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/sessions',
        headers: { cookie: cookieHeader(first.cookie) },
      });
      assert.equal(listed.statusCode, 200, listed.body);
      const afterList = await isolated.runtime.pool.query<{ last_seen_at: Date }>(
        `select last_seen_at from known_auth_session_metadata where auth_session_id = $1`,
        [first.sessionId],
      );
      assert.equal(afterList.rows[0]?.last_seen_at.getTime(), rewound.getTime());

      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: cookieHeader(first.cookie) },
      });
      assert.equal(me.statusCode, 200, me.body);
      const afterMe = await isolated.runtime.pool.query<{ last_seen_at: Date }>(
        `select last_seen_at from known_auth_session_metadata where auth_session_id = $1`,
        [first.sessionId],
      );
      assert.ok(
        (afterMe.rows[0]?.last_seen_at.getTime() ?? 0) > rewound.getTime(),
        'GET /me (touch:true) must slide last_seen after the 60s throttle',
      );
    } finally {
      await app.close();
    }
  });

  test('revokeAll kills account-epoch sessions and sync facts without treating MCP OAuth epoch as account state', async () => {
    const { accountId, userId, token, cookie } = await seedUsableSession({ createdAtAgoMs: 60_000 });
    // A second BA session for the same auth user.
    const second = await seedBaSession({ userId, token: `tok-${randomUUID().replaceAll('-', '')}` });
    await seedMetadata({ authSessionId: second.sessionId, token: second.token, accountId });
    // A legacy product session for the same account.
    await isolated.runtime.pool.query(
      `insert into sessions (id, account_id, idle_expires_at, absolute_expires_at, csrf_token_hash, token_hash, security_epoch, rotated_from_session_id, last_seen_at, revoked_at, created_at)
       values ('legacy-revoke-all','acct-1', now() + interval '1 day', now() + interval '30 days', 'x', 'legacy-hash', 0, NULL, now(), NULL, now())`,
    );

    // A REAL sync session fact bound to the pre-revoke epoch (the sync
    // transport validates `BigInt(account.security_epoch) = BigInt(session.account_security_epoch)`
    // on every pull/ack/retire — sync-session-postgres.ts / sync-ack-postgres.ts).
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `insert into resource_id_ledger(resource_id, resource_type) values
         ('col-1','collection'),('node-1','node'),('dev-1','device'),('rep-1','replica'),('sync-sess-1','sync-session')`,
      );
      await client.query(
        `insert into sync_devices(device_id, account_id, device_name) values ('dev-1',$1,'test device')`,
        [accountId],
      );
      await client.query(
        `insert into collections (id, owner_subject_id, title, kind, root_node_id, resource_revision, content_revision, policy_revision)
         values ('col-1',$1,'Sync Col','bookmarks','node-1','r1','c1','p1')`,
        [`subj-${accountId}`],
      );
      // collections.root_node_id is a deferred FK; nodes.collection_id is not,
      // so the collection row must exist before the node row (as in
      // annotation-migration-postgres.integration.test.ts).
      await client.query(
        `insert into nodes (id, collection_id, parent_id, kind, is_root, title, resource_revision, children_revision)
         values ('node-1','col-1',NULL,'folder',true,'Root','r1','c1')`,
      );
      await client.query(
        `insert into sync_replica_id_ledger (replica_id, account_id, device_id, collection_id, initial_lease_generation, binding_mode, browser_profile_id, browser_generation)
         values ('rep-1',$1,'dev-1','col-1',1,'whole-profile','bp-1','bg-1')`,
        [accountId],
      );
      await client.query(
        `insert into sync_replica_generations (replica_id, lease_generation, lease_id) values ('rep-1',1,'lease-1')`,
      );
      await client.query(
        `insert into sync_replicas (replica_id, account_id, device_id, collection_id, replica_name, kind, lease_generation, lease_id, binding_mode, browser_profile_id, browser_generation, adapter_profile, adapter_version, capabilities_json, status, lease_expires_at, wire_json)
         values ('rep-1',$1,'dev-1','col-1','Test Replica','browser_extension',1,'lease-1','whole-profile','bp-1','bg-1','profile','1.0.0',
           '{"read":true,"write":true,"events":true,"separator":true,"alias":true,"annotations":"native","maxBatchOperations":100}',
           'active', now() + interval '1 day', '{}')`,
        [accountId],
      );
      await client.query(
        `insert into account_identities(id, account_id, issuer, subject) values ('cred-identity-1',$1,'https://issuer.example',$2)`,
        [accountId, `subj-${accountId}`],
      );
      await client.query(
        `insert into sync_extension_credentials (issuer, credential_id, credential_digest, subject, account_id, client_id, audience, scopes_json, credential_issued_at, credential_expires_at, evidence_expires_at, security_epoch, revoked_at, last_verified_at)
         values ('https://issuer.example','cred-1','0123456789abcdef',$1,$2,'client-1','audience-1','["known.sync"]'::jsonb, now(), now() + interval '30 days', now() + interval '30 days', 0, NULL, now())`,
        [`subj-${accountId}`, accountId],
      );
      await client.query(
        `insert into sync_sessions (session_id, account_id, principal_subject_id, credential_issuer, credential_id, oauth_client_id, origin, session_scope, protocol_version, collection_id, replica_id, lease_generation, lease_id, lifecycle_revision, policy_revision, account_security_epoch, issued_at, expires_at, status, termination_reason, terminated_at, secret_digest, capability_digest, binding_json)
         values ('sync-sess-1',$1,$2,'https://issuer.example','cred-1','client-1','https://app.example.test','collection','0.1','col-1','rep-1',1,'lease-1',0,'p1',0, now(), now() + interval '1 day', 'active', NULL, NULL, '0123456789abcdef0123456789abcdef','0123456789abcdef0123456789abcdef','{"known.sync":true}')`,
        [accountId, `subj-${accountId}`],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    // The sync session is LIVE before revokeAll (the exact transport predicate:
    // sync-session-postgres.ts / sync-retire-postgres.ts compare
    // BigInt(session.account_security_epoch) === BigInt(account.security_epoch)
    // after row fetch; in SQL the bigint columns compare directly).
    const liveBefore = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from sync_sessions s join accounts a on a.id = s.account_id
       where s.session_id = 'sync-sess-1' and s.status = 'active'
         and s.account_security_epoch = a.security_epoch`,
    );
    assert.equal(liveBefore.rows[0]?.n, 1);

    // A real MCP approval plan uses the independent MCP OAuth epoch. Product
    // approval visibility is account-id scoped; browser account epoch validity
    // is enforced before this API by the session authority.
    const accountRow = await isolated.runtime.pool.query<{ id: string }>(
      `select id from accounts where id = $1`,
      [accountId],
    );
    const plan: McpStoredPlan = {
      planId: 'plan-revoke-all-1',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      risk: 'low',
      requiresApproval: false,
      summary: 'revoke-all fact plan',
      impact: { collections: 0, nodes: 0, annotations: 0, attachments: 0, relations: 0, privateFieldsExcluded: [] },
      requiredScopes: [],
      baseRevisions: {},
      operations: [],
      operationsDigest: 'plan-digest-1',
      binding: {
        kind: 'authenticated',
        principalId: accountId,
        clientId: 'client-1',
        credentialBindingId: 'cred-binding-1',
        resourceAudience: 'audience-1',
        securityEpoch: 'known.mcp.oauth.v1',
      },
      untrustedNote: '',
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    const approvalApi = createPhase4bMcpWriteApprovalApi({
      execute: async (work) => work({}),
      lockPlan: () => undefined,
      updatePlan: () => undefined,
      markApproved: () => undefined,
      createReceiptPort: () => {
        throw new Error('not used in this test');
      },
      appendAuditDecision: () => undefined,
      listPlans: async () => [plan],
      getPlan: async () => plan,
    });
    const accountView = { id: accountRow.rows[0]!.id };
    const visibleBefore = await approvalApi.list(accountView);
    assert.equal(visibleBefore.items.length, 1, 'the plan is visible to its account principal');

    // revokeAll: BA sessions + metadata + legacy sessions die; epoch bumps.
    const result = await authority.revokeAll(accountId);
    assert.equal(result.securityEpoch, 1n);
    assert.equal(result.revokedAuthSessions, 2);
    assert.equal(result.revokedLegacySessions, 1);
    assert.equal(await rowCount(`from "auth_sessions" where "userId" = '${userId}'`), 0);
    assert.equal(await rowCount(`from known_auth_session_metadata where account_id = '${accountId}'`), 0);
    assert.equal(await rowCount(`from sessions where account_id = '${accountId}' and revoked_at is null`), 0);

    // The sync fact is DEAD: the exact transport predicate no longer matches.
    const liveAfter = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n from sync_sessions s join accounts a on a.id = s.account_id
       where s.session_id = 'sync-sess-1' and s.status = 'active'
         and s.account_security_epoch = a.security_epoch`,
    );
    assert.equal(liveAfter.rows[0]?.n, 0, 'the sync session fact must be invalidated by the epoch bump');

    // Approval visibility does not compare the independent epoch types. A
    // future valid session for this same account may still review the Plan.
    const visibleAfter = await approvalApi.list(accountView);
    assert.equal(visibleAfter.items.length, 1, 'the MCP plan remains scoped to the account principal');

    // The old cookie is dead at every level.
    assert.equal(await authority.authenticate({ cookie: cookieHeader(cookie) }), null);
    assert.equal(
      await authority.authenticate({ cookie: cookieHeader(signBetterAuthSessionCookieValue(BA_SECRET, token)) }),
      null,
    );
  });

  async function seedExtraLiveSessions(
    input: { readonly userId: string; readonly accountId: string; readonly count: number },
  ): Promise<string[]> {
    const ids: string[] = [];
    const now = Date.now();
    for (let offset = 0; offset < input.count; offset += 1) {
      const lastSeenAt = new Date(now - (offset + 1) * 60_000);
      const extra = await seedBaSession({ userId: input.userId, createdAt: lastSeenAt });
      await seedMetadata({
        authSessionId: extra.sessionId,
        token: extra.token,
        accountId: input.accountId,
        lastSeenAt,
        createdAt: lastSeenAt,
      });
      ids.push(extra.sessionId);
    }
    return ids;
  }

  async function countLiveMetadata(accountId: string): Promise<number> {
    const result = await isolated.runtime.pool.query<{ n: number }>(
      `select count(*)::int n
         from known_auth_session_metadata m
         join "auth_sessions" s on s.id = m.auth_session_id
        where m.account_id = $1 and m.revoked_at is null`,
      [accountId],
    );
    return result.rows[0]?.n ?? 0;
  }
});

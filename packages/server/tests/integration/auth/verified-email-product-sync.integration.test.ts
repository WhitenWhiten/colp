/**
 * S-03 / C-01: verified Better Auth email lands on accounts.email; P9 syncs
 * both tables; a verified session can invite (not 400 invalid_request).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { betterAuth } from 'better-auth';
import { loadConfig } from '../../support/test-config.js';
import { createTestCollaborationListCursors } from '../../support/collaboration-list-cursors.js';
import {
  buildBetterAuthOptions,
  mountBetterAuthAllowlist,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import {
  createBetterAuthServerApi,
  createBetterAuthSessionAuthority,
} from '../../../src/infrastructure/auth/better-auth-session-authority.js';
import { createBetterAuthSessionTokenProtector } from '../../../src/infrastructure/auth/better-auth-session-token-protection.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import { createPostgresCollaborationUnitOfWork } from '../../../src/infrastructure/collaboration/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createAuthEmailAdapter, createInProcessMailboxSink } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createMemoryCollaborationInviteRateLimiter } from '../../../src/infrastructure/rate-limit/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { authEmailIdempotencyKey, ensureBusinessAccountForVerifiedEmail } from '../../../src/modules/auth/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const JSON_POST = { 'content-type': 'application/json', origin: ORIGIN };

function testEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://localhost/known_test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PRODUCT_ORIGIN: ORIGIN,
    ALLOWED_ORIGINS: ORIGIN,
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    BETTER_AUTH_ENABLED: 'true',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_EMAIL_OTP_ENABLED: 'true',
    AUTH_RATE_LIMIT_MAX: '1000000',
  };
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

describeWithPostgres('verified email product sync (S-03 / C-01 / P9)', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: ReturnType<typeof buildApiApp>;
  let sink: ReturnType<typeof createInProcessMailboxSink>;
  const providerLinkRaises: string[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('s03_verified_email_product', {
      maxConnections: 10,
      applicationName: 'known-s03-verified-email-product',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    const config = loadConfig(testEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built);
    sink = createInProcessMailboxSink();
    const sender = createAuthEmailAdapter({ provider: sink.provider, logger: createLogger('silent') });
    const unitOfWork = createPostgresBusinessAccountUnitOfWork(isolated.runtime.db);
    const auth = betterAuth(buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
      authEmail: sender,
      businessAccount: { unitOfWork },
      logger: createLogger('silent'),
      onProviderLinked: async ({ authUserId }) => {
        providerLinkRaises.push(authUserId);
      },
    }));
    const authority = createBetterAuthSessionAuthority({
      db: isolated.runtime.db,
      betterAuth: createBetterAuthServerApi(auth),
      secret: built.secret,
      sessionExpiresInSeconds: built.sessionExpiresInSeconds,
      sessionTokenProtector: createBetterAuthSessionTokenProtector(built.sessionTokenProtection),
    });
    app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: authority,
      betterAuthRuntime: { mount: (fastifyApp) => mountBetterAuthAllowlist(fastifyApp, auth, built) },
      productCollaboration: {
        identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
        allowedOrigins: [ORIGIN],
        unitOfWork: createPostgresCollaborationUnitOfWork(isolated.runtime.db, { inviteEmailEnabled: false }),
        rateLimiter: createMemoryCollaborationInviteRateLimiter({
          keySecret: Buffer.alloc(32, 19),
          environment: 'test',
        }),
        cursors: createTestCollaborationListCursors(),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await isolated?.close();
  });

  function postAuth(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `${BASE_PATH}${path}`,
      headers: { ...JSON_POST, ...headers },
      payload: JSON.stringify(body),
    });
  }

  function sessionCookie(res: { cookies?: unknown }): string | null {
    const cookies = (res.cookies ?? []) as Array<{ name: string; value: string }>;
    return cookies.find((cookie) => cookie.name === '__Host-known_session')?.value ?? null;
  }

  async function userIdForEmail(email: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ id: string }>(
      `select id from "auth_users" where email = $1`, [email],
    );
    return result.rows[0]?.id ?? null;
  }

  async function securityEpochForUser(userId: string): Promise<bigint> {
    const result = await isolated.runtime.pool.query<{ security_epoch: string }>(
      `select a.security_epoch::text as security_epoch from accounts a
        join auth_user_account_map m on m.account_id = a.id where m.auth_user_id = $1`,
      [userId],
    );
    return BigInt(result.rows[0]!.security_epoch);
  }

  async function productEmailForUser(userId: string): Promise<string | null> {
    const result = await isolated.runtime.pool.query<{ email: string | null }>(
      `select a.email from accounts a join auth_user_account_map m on m.account_id = a.id where m.auth_user_id = $1`,
      [userId],
    );
    return result.rows[0]?.email ?? null;
  }

  async function verifyMailbox(email: string): Promise<void> {
    const entry = sink.entries.find((item) => item.to === email && item.subject.includes('Verify'))
      ?? sink.entries.find((item) => item.to === email);
    assert.ok(entry, `no verification email was delivered to ${email}`);
    const token = entry.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token);
    const verify = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/verify-email?token=${token}`,
      headers: { origin: ORIGIN },
    });
    assert.equal(verify.statusCode, 200, verify.payload);
    const auto = sessionCookie(verify);
    if (auto !== null) {
      await postAuth('/sign-out', {}, { cookie: `__Host-known_session=${auto}` });
    }
  }

  async function signUpVerified(email: string): Promise<{ cookie: string; userId: string }> {
    const signup = await postAuth('/sign-up/email', { name: 'S03 User', email, password: PASSWORD });
    assert.equal(signup.statusCode, 200, signup.payload);
    await verifyMailbox(email);
    const signin = await postAuth('/sign-in/email', { email, password: PASSWORD });
    assert.equal(signin.statusCode, 200, signin.payload);
    const cookie = sessionCookie(signin);
    assert.ok(cookie);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    return { cookie, userId };
  }

  test('password sign-up then verify writes accounts.email', async () => {
    const email = uniqueEmail('verify-fill');
    const signup = await postAuth('/sign-up/email', { name: 'S03 User', email, password: PASSWORD });
    assert.equal(signup.statusCode, 200);
    const userId = await userIdForEmail(email);
    assert.ok(userId);
    assert.equal(await productEmailForUser(userId), null, 'unproved occupancy must not store accounts.email');
    const epochBefore = await securityEpochForUser(userId);
    await verifyMailbox(email);
    assert.equal(await productEmailForUser(userId), email);
    assert.equal(await securityEpochForUser(userId), epochBefore, 'verifying the signup email must not bump security_epoch');
    const again = await ensureBusinessAccountForVerifiedEmail(
      { authUserId: userId, email, emailProofVerified: true, allowEmailChange: true },
      { unitOfWork: createPostgresBusinessAccountUnitOfWork(isolated.runtime.db) },
    );
    assert.equal(again.account.email, email);
    assert.equal(again.account.securityEpoch, epochBefore, 'verifying the same email must not bump security_epoch');
  });

  test('AUTH-01: missing, wrong, exhausted and expired OTP never change either identity', async () => {
    const current = uniqueEmail('proof-from');
    const next = uniqueEmail('proof-to');
    const { cookie, userId } = await signUpVerified(current);
    const headers = { cookie: `__Host-known_session=${cookie}` };
    async function reject(otp: string) {
      const response = await postAuth('/email-otp/change-email', { newEmail: next, otp }, headers);
      assert.ok(response.statusCode >= 400, response.payload);
      assert.equal(await userIdForEmail(current), userId);
      assert.equal(await productEmailForUser(userId), current);
    }
    await reject('000000');
    assert.equal((await postAuth('/email-otp/request-email-change', { newEmail: next }, headers)).statusCode, 200);
    const entry = sink.entries.filter((item) => item.idempotencyKey === authEmailIdempotencyKey('otp:change-email', next)).at(-1);
    const otp = entry?.textBody.match(/\b\d{6}\b/u)?.[0];
    assert.ok(otp);
    const wrong = otp === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 6; attempt += 1) await reject(wrong);
    await reject(otp);
    assert.equal((await postAuth('/email-otp/request-email-change', { newEmail: next }, headers)).statusCode, 200);
    await isolated.runtime.db.updateTable('auth_verifications')
      .set({ expiresAt: new Date(0) }).execute();
    await reject(otp);
  });

  test('P9 success syncs accounts.email and frees the old mailbox for a new user', async () => {
    const current = uniqueEmail('p9-from');
    const next = uniqueEmail('p9-to');
    const { cookie, userId } = await signUpVerified(current);
    const epochBefore = await securityEpochForUser(userId);
    const cookieHeader = { cookie: `__Host-known_session=${cookie}` };
    const request = await postAuth('/email-otp/request-email-change', { newEmail: next }, cookieHeader);
    assert.equal(request.statusCode, 200, request.payload);
    const changeKey = authEmailIdempotencyKey('otp:change-email', next);
    const otpEntry = sink.entries.filter((entry) => entry.idempotencyKey === changeKey).at(-1);
    assert.ok(otpEntry);
    const otp = otpEntry.textBody.match(/\b\d{6}\b/u)?.[0];
    assert.ok(otp);
    const confirm = await postAuth('/email-otp/change-email', { newEmail: next, otp }, cookieHeader);
    assert.equal(confirm.statusCode, 200, confirm.payload);
    const authRow = await isolated.runtime.pool.query<{ email: string }>(
      `select email from "auth_users" where id = $1`, [userId],
    );
    assert.equal(authRow.rows[0]?.email, next);
    assert.equal(await productEmailForUser(userId), next);
    assert.equal(await securityEpochForUser(userId), epochBefore + 1n, 'a successful email change bumps security_epoch once');
    assert.equal(await userIdForEmail(current), null);

    const reused = await postAuth('/sign-up/email', { name: 'Reuse', email: current, password: PASSWORD });
    assert.equal(reused.statusCode, 200, reused.payload);
    const newUserId = await userIdForEmail(current);
    assert.ok(newUserId);
    assert.notEqual(newUserId, userId);
  });

  test('AUTH-04: password change and reset commit revocation atomically without callback delivery', async () => {
    const email = uniqueEmail('password-security');
    const { cookie, userId } = await signUpVerified(email);
    const headers = { cookie: `__Host-known_session=${cookie}` };
    const db = isolated.runtime.db;
    const pool = isolated.runtime.pool;
    const before = await db.selectFrom('auth_accounts').select('password').where('userId', '=', userId).executeTakeFirstOrThrow();
    const epoch = async () => {
      const result = await pool.query('select a.security_epoch from accounts a join auth_user_account_map m on m.account_id=a.id where m.auth_user_id=$1',[userId]);
      return BigInt(result.rows[0].security_epoch);
    };
    const originalEpoch = await epoch();
    const globalFloor = await pool.query<{ epoch: string; effective_at: Date }>(
      'select epoch, effective_at from mcp_oauth_security_epoch where id = 1',
    );
    const providerLinksBefore = providerLinkRaises.length;
    await pool.query(`create function reject_epoch_write() returns trigger language plpgsql as $$ begin raise exception 'epoch unavailable'; end $$`);
    await pool.query('create trigger reject_epoch before update of security_epoch on accounts for each row execute function reject_epoch_write()');
    const failed = await postAuth('/change-password', { currentPassword: PASSWORD, newPassword: 'replacement-password-456' }, headers);
    assert.ok(failed.statusCode >= 400, failed.payload);
    assert.equal((await db.selectFrom('auth_accounts').select('password').where('userId', '=', userId).executeTakeFirstOrThrow()).password, before.password);
    assert.equal(await epoch(), originalEpoch);
    assert.equal((await pool.query('select count(*) from auth_password_security_events where auth_user_id=$1',[userId])).rows[0].count,'0');
    await pool.query('drop trigger reject_epoch on accounts');
    const changed = await postAuth('/change-password', { currentPassword: PASSWORD, newPassword: 'replacement-password-456' }, headers);
    assert.equal(changed.statusCode, 200, changed.payload);
    assert.equal(await epoch(), originalEpoch + 1n);
    const successor = sessionCookie(changed);
    assert.ok(successor);
    const bootstrap = await app.inject({method:'GET',url:'/api/v1/session',headers:{cookie:`__Host-known_session=${successor}`}});
    assert.equal(bootstrap.statusCode,200,bootstrap.payload);
    assert.equal(bootstrap.json().authenticated,true);
    const old = await app.inject({method:'GET',url:'/api/v1/session',headers});
    assert.equal(old.json().authenticated,false);
    // Rewriting the same hash creates neither a second event nor another epoch.
    await pool.query('update auth_accounts set password=password where "userId"=$1',[userId]);
    assert.equal(await epoch(), originalEpoch + 1n);
    const send = await postAuth('/email-otp/send-verification-otp', {email,type:'forget-password'});
    assert.equal(send.statusCode,200,send.payload);
    const entry = sink.entries.filter(item => item.idempotencyKey === authEmailIdempotencyKey('otp:forget-password',email)).at(-1);
    const otp = entry?.textBody.match(/\b\d{6}\b/u)?.[0];
    assert.ok(otp);
    const reset = await postAuth('/email-otp/reset-password',{email,otp,password:'reset-password-789'});
    assert.equal(reset.statusCode,200,reset.payload);
    assert.equal(await epoch(),originalEpoch + 2n);
    assert.equal((await pool.query('select count(*) from auth_password_security_events where auth_user_id=$1',[userId])).rows[0].count,'2');
    assert.equal((await db.selectFrom('auth_sessions').select('id').where('userId','=',userId).execute()).length,0);
    const mcp = await pool.query<{ epoch: string; effective_at: Date }>(
      'select epoch, effective_at from mcp_oauth_security_epoch where id = 1',
    );
    assert.equal(mcp.rows[0]!.epoch, globalFloor.rows[0]!.epoch);
    assert.equal(mcp.rows[0]!.effective_at.getTime(), globalFloor.rows[0]!.effective_at.getTime());
    // OAuth-only recovery inserts a new password credential; it must revoke too.
    await db.deleteFrom('auth_accounts').where('userId','=',userId).where('providerId','=','credential').execute();
    assert.equal((await postAuth('/email-otp/send-verification-otp',{email,type:'forget-password'})).statusCode,200);
    const recovery = sink.entries.filter(item => item.idempotencyKey === authEmailIdempotencyKey('otp:forget-password',email)).at(-1);
    const recoveryOtp = recovery?.textBody.match(/\b\d{6}\b/u)?.[0];
    assert.ok(recoveryOtp);
    const established = await postAuth('/email-otp/reset-password',{email,otp:recoveryOtp,password:'first-password-456'});
    assert.equal(established.statusCode,200,established.payload);
    assert.equal(await epoch(),originalEpoch + 3n);
    const mcpAfterRecovery = await pool.query<{ epoch: string; effective_at: Date }>(
      'select epoch, effective_at from mcp_oauth_security_epoch where id = 1',
    );
    assert.equal(mcpAfterRecovery.rows[0]!.epoch, globalFloor.rows[0]!.epoch);
    assert.equal(
      mcpAfterRecovery.rows[0]!.effective_at.getTime(),
      globalFloor.rows[0]!.effective_at.getTime(),
    );
    assert.equal(providerLinkRaises.length, providerLinksBefore, 'password change and reset must not raise provider_link');

  });

  test('verified session POST invite is not 400 invalid_request', async () => {
    const ownerEmail = uniqueEmail('invite-owner');
    const inviteeEmail = uniqueEmail('invite-target');
    const { cookie } = await signUpVerified(ownerEmail);
    const session = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: `__Host-known_session=${cookie}` },
    });
    assert.equal(session.statusCode, 200, session.payload);
    const csrfToken = (session.json() as { csrfToken?: string }).csrfToken;
    assert.ok(csrfToken);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: {
        cookie: `__Host-known_session=${cookie}`,
        origin: ORIGIN,
        'x-csrf-token': csrfToken,
        'known-command-id': '10000000-0000-4000-8000-00000000c701',
        'content-type': 'application/json',
      },
      payload: { kind: 'bookmarks', title: 'S03 collab', summary: null },
    });
    assert.equal(created.statusCode, 201, created.payload);
    const collectionId = created.json().collection.id as string;
    const members = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}/members`,
      headers: { cookie: `__Host-known_session=${cookie}` },
    });
    assert.equal(members.statusCode, 200, members.payload);
    const invited = await app.inject({
      method: 'POST',
      url: `/api/v1/collections/${collectionId}/members/invites`,
      headers: {
        cookie: `__Host-known_session=${cookie}`,
        origin: ORIGIN,
        'x-csrf-token': csrfToken,
        'known-command-id': '10000000-0000-4000-8000-00000000c702',
        'content-type': 'application/json',
        'if-match': members.json().policyEtag as string,
      },
      payload: { email: inviteeEmail, role: 'editor' },
    });
    assert.equal(invited.statusCode, 201, invited.payload);
    assert.equal(typeof invited.json().inviteId, 'string');
    assert.equal(invited.json().error, undefined);
  });
});

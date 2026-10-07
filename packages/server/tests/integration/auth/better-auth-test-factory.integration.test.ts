/**
 * Task E1 contract tests for the PostgreSQL Better Auth test factory (plan
 * §11 E1 steps 1/5): REAL betterAuth + REAL PostgreSQL rows, the REAL
 * `auth.api.getSession` validates every cookie (never mocked), and the REAL
 * A3 authority resolves the product actor.
 *
 * 假阴性防护: every assertion reads the REAL database (auth_users /
 * auth_sessions / known_auth_session_metadata / auth_user_account_map /
 * accounts) and the REAL product route (buildApiApp + browserSessionAuthority);
 * the legacy `sessions` table must stay empty and no `known_test.` material
 * may appear anywhere.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  createPostgresBetterAuthTestFactory,
  issueTestSession,
} from '../../support/better-auth-test-factory.js';

const ORIGIN = 'https://app.example.test';

describeWithPostgres('E1 Better Auth test factory over real PostgreSQL + real Better Auth', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('e1_better_auth_test_factory', {
      maxConnections: 10,
      applicationName: 'known-e1-better-auth-test-factory',
    });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  async function factory() {
    return createPostgresBetterAuthTestFactory({ db: isolated!.runtime.db });
  }

  async function rowCount(sqlText: string): Promise<number> {
    const result = await isolated!.runtime.pool.query<{ n: number }>(`select count(*)::int n ${sqlText}`);
    return result.rows[0]?.n ?? 0;
  }

  test('issue mints REAL BA rows and the REAL authority authenticates the cookie', async () => {
    const f = await factory();
    const client = await issueTestSession({ factory: f, subject: 'e1-pg-user', handle: 'e1_pg_user' });

    assert.match(client.accountId, /^[A-Za-z0-9_-]{21}[AQgw]$/u);
    assert.equal(await rowCount(`from accounts where id = '${client.accountId}'`), 1);
    assert.equal(await rowCount(`from profiles where account_id = '${client.accountId}'`), 1);
    assert.equal(await rowCount(`from profile_handles where account_id = '${client.accountId}'`), 1);
    assert.equal(await rowCount(`from auth_user_account_map where account_id = '${client.accountId}'`), 1);
    assert.equal(await rowCount(`from auth_users`), 1);
    assert.equal(await rowCount(`from auth_sessions`), 1);
    assert.equal(await rowCount(`from known_auth_session_metadata where account_id = '${client.accountId}'`), 1);
    // 假阳性防护: the legacy sessions table is never written.
    assert.equal(await rowCount(`from sessions`), 0, 'no legacy sessions row may be written');
    // The business account carries no account_identities row (A2 semantics).
    assert.equal(await rowCount(`from account_identities where account_id = '${client.accountId}'`), 0);

    const actor = await f.authority.authenticate({ cookie: client.cookie });
    assert.ok(actor, 'the REAL authority must authenticate the factory cookie');
    assert.equal(actor.account.id, client.accountId);
    assert.equal(actor.account.subjectId, client.subjectId);
    assert.notEqual(actor.account.id, (await isolated!.runtime.pool.query<{ id: string }>(`select id from auth_users`)).rows[0]!.id,
      'the BA auth user id must never become the product account id');
  });

  test('the REAL product route accepts the factory CSRF and rejects a foreign CSRF', async () => {
    const f = await factory();
    const client = await issueTestSession({ factory: f, subject: 'e1-pg-csrf', handle: 'e1_pg_csrf' });
    const other = await issueTestSession({ factory: f, subject: 'e1-pg-csrf-other', handle: 'e1_pg_csrf_other' });
    const config = loadConfig({
      DATABASE_URL: 'postgres://localhost/known_test',
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known',
      OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated!.runtime.db),
      browserSessionAuthority: f.authority,
    });
    try {
      const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: client.cookie } });
      assert.equal(session.statusCode, 200);
      assert.equal((session.json() as { csrfToken: string }).csrfToken, client.csrfToken);

      const headers = (csrf: string, commandId: string) => ({
        cookie: client.cookie, origin: ORIGIN, 'x-csrf-token': csrf,
        'known-command-id': commandId, 'content-type': 'application/json',
      });
      const foreign = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: headers(other.csrfToken, '123e4567-e89b-42d3-a456-426614174001'), payload: { handle: 'e1_pg_csrf', displayName: 'X' } });
      assert.equal(foreign.statusCode, 403);
      assert.equal((foreign.json() as { error: { code: string } }).error.code, 'csrf_failed');
      const own = await app.inject({ method: 'PATCH', url: '/api/v1/me', headers: headers(client.csrfToken, '123e4567-e89b-42d3-a456-426614174002'), payload: { handle: 'e1_pg_csrf', displayName: 'Updated' } });
      assert.equal(own.statusCode, 200);
      assert.equal((own.json() as { profile: { displayName: string } }).profile.displayName, 'Updated');
    } finally {
      await app.close();
    }
  });

  test('signOut revokes the REAL BA session and the product route refuses the cookie', async () => {
    const f = await factory();
    const client = await issueTestSession({ factory: f, subject: 'e1-pg-revoke', handle: 'e1_pg_revoke' });
    assert.ok(await f.authority.authenticate({ cookie: client.cookie }));

    await f.authority.signOut({ cookie: client.cookie });
    assert.equal(await f.authority.authenticate({ cookie: client.cookie }), null);
    // The schema is shared across the file's tests, so scope the row checks to
    // THIS account's auth users (1:1 mapping contract): sign-out must delete
    // the session row and cascade the metadata.
    assert.equal(await rowCount(`from auth_sessions where "userId" in (select auth_user_id from auth_user_account_map where account_id = '${client.accountId}')`), 0, 'BA sign-out must delete the session row');
    assert.equal(await rowCount(`from known_auth_session_metadata where account_id = '${client.accountId}'`), 0, 'metadata cascades with the BA session row');
  });

  test('re-issuing the same subject reuses the business account and mints a second BA session', async () => {
    const f = await factory();
    const first = await issueTestSession({ factory: f, subject: 'e1-pg-reuse', handle: 'e1_pg_reuse' });
    const second = await issueTestSession({ factory: f, subject: 'e1-pg-reuse', handle: 'e1_pg_reuse' });

    assert.equal(second.accountId, first.accountId);
    assert.equal(second.subjectId, first.subjectId);
    assert.equal(await rowCount(`from accounts where id = '${first.accountId}'`), 1);
    // The schema is shared across the file's tests, so scope session/user
    // counts to THIS account's 1:1 mapped auth user.
    assert.equal(await rowCount(`from auth_sessions where "userId" in (select auth_user_id from auth_user_account_map where account_id = '${first.accountId}')`), 2, 'each issue must mint a fresh session');
    // Real schema contract (auth_users.email UNIQUE + auth_user_account_map 1:1):
    // a re-issued subject reuses the SAME auth user (a user owns many
    // sessions); the account never gains a second auth user or mapping.
    assert.equal(await rowCount(`from auth_users where id in (select auth_user_id from auth_user_account_map where account_id = '${first.accountId}')`), 1, 'the auth user is reused across re-issues');
    assert.equal(await rowCount(`from auth_user_account_map where account_id = '${first.accountId}'`), 1, 'the account keeps its single 1:1 mapping');
    assert.ok(await f.authority.authenticate({ cookie: first.cookie }));
    assert.ok(await f.authority.authenticate({ cookie: second.cookie }));
  });

  test('the minted cookie never carries known_test.* material and storage is protected', async () => {
    const f = await factory();
    const client = await issueTestSession({ factory: f, subject: 'e1-pg-no-legacy', handle: 'e1_pg_no_legacy' });
    assert.equal(client.cookie.includes('known_test.'), false);
    const raw = await isolated!.runtime.pool.query<{ token: string }>(`select token from auth_sessions`);
    assert.equal(raw.rows[0]!.token.startsWith('known_test.'), false);
    assert.match(raw.rows[0]!.token, /^knst1\.1\./u);
  });
});

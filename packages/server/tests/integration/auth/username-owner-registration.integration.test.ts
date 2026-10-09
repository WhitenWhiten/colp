/**
 * G2 owner sign-in: first sign-up, closed registration, username cookie,
 * email sign-in when an email was stored, and registration-state.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { createBetterAuthRuntime } from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { buildApiApp } from '../../../src/transport/app.js';
import {
  openBetterAuthPostgres,
  type BetterAuthPostgresFixture,
} from '../../support/better-auth-postgres.js';
import { up as applySingleOwnerGuard } from '../../../migrations/202610230400_colp_single_owner_guard.js';

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'
const SETUP_TOKEN = 'g2-first-run-setup-token-0123456789abcdefghij';
const SETUP = { 'colp-setup-token': SETUP_TOKEN };

const previousMultiUser = process.env.COLP_MULTI_USER;
const previousEdition = process.env.KNOWN_EDITION;
const previousSetupToken = process.env.COLP_SETUP_TOKEN;

function enabledEnv(): Record<string, string> {
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
    BETTER_AUTH_BODY_LIMIT_BYTES: '2048',
  };
}

describe('G2 username sign-in and single owner', () => {
  let fixture: BetterAuthPostgresFixture;
  let app: ReturnType<typeof buildApiApp>;

  beforeAll(async () => {
    delete process.env.COLP_MULTI_USER;
    process.env.KNOWN_EDITION = 'self-hosted';
    process.env.COLP_SETUP_TOKEN = SETUP_TOKEN;
    const config = loadConfig(enabledEnv());
    const built = buildBetterAuthConfig(config.betterAuth);
    assert.ok(built, 'enabled config must produce Better Auth settings');
    fixture = await openBetterAuthPostgres(built);
    const runtime = createBetterAuthRuntime({
      enabled: true,
      config: built,
      database: { db: fixture.db, type: 'postgres', transaction: true },
    });
    assert.ok(runtime, 'self-hosted runtime must construct');
    app = buildApiApp({ config, betterAuthRuntime: runtime });
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await fixture?.close();
    if (previousMultiUser === undefined) delete process.env.COLP_MULTI_USER;
    else process.env.COLP_MULTI_USER = previousMultiUser;
    if (previousEdition === undefined) delete process.env.KNOWN_EDITION;
    else process.env.KNOWN_EDITION = previousEdition;
    if (previousSetupToken === undefined) delete process.env.COLP_SETUP_TOKEN;
    else process.env.COLP_SETUP_TOKEN = previousSetupToken;
  });

  function post(path: string, body: unknown, extra: Record<string, string> = {}) {
    return app.inject({
      method: 'POST',
      url: `${BASE_PATH}${path}`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, ...extra },
      payload: JSON.stringify(body),
    });
  }

  async function registrationState(): Promise<{ open: boolean; reason: string }> {
    const res = await app.inject({ method: 'GET', url: `${BASE_PATH}/registration-state` });
    assert.equal(res.statusCode, 200);
    return res.json();
  }

  function sessionCookie(res: { headers: { 'set-cookie'?: string | string[] } }): string | undefined {
    const raw = res.headers['set-cookie'];
    const cookies = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
    return cookies.find((cookie) => cookie.startsWith('__Host-known_session='))?.split(';', 1)[0];
  }

  test('first sign-up works, the next is closed, and both identifiers sign in', async () => {
    delete process.env.COLP_MULTI_USER;
    await fixture.pool.query('delete from "auth_users"');
    assert.deepEqual(await registrationState(), { open: true, reason: 'first-run' });

    const email = 'owner@example.test';
    const signUp = await post('/sign-up/email', {
      name: 'Owner',
      email,
      username: 'owner',
      password: PASSWORD,
    }, SETUP);
    assert.equal(signUp.statusCode, 200, signUp.body);

    assert.deepEqual(await registrationState(), { open: false, reason: 'closed' });

    const second = await post('/sign-up/email', {
      name: 'Other',
      email: 'other@example.test',
      username: 'other',
      password: PASSWORD,
    });
    assert.equal(second.statusCode, 403);
    assert.equal((second.json() as { code?: string }).code, 'registration_closed');

    const byUsername = await post('/sign-in/username', { username: 'owner', password: PASSWORD });
    assert.equal(byUsername.statusCode, 200, byUsername.body);
    const usernameCookie = sessionCookie(byUsername);
    assert.ok(usernameCookie, 'username sign-in must set __Host-known_session');
    const session = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/get-session`,
      headers: { cookie: usernameCookie },
    });
    assert.equal(session.statusCode, 200);
    assert.equal((session.json() as { user?: { username?: string } }).user?.username, 'owner');

    const byEmail = await post('/sign-in/email', { email, password: PASSWORD });
    assert.equal(byEmail.statusCode, 200, byEmail.body);
    assert.ok(sessionCookie(byEmail), 'email sign-in must still set the session cookie');

    process.env.COLP_MULTI_USER = 'true';
    assert.deepEqual(await registrationState(), { open: false, reason: 'closed' });
    const whileMultiUser = await post('/sign-up/email', {
      name: 'Other',
      email: 'other@example.test',
      username: 'other',
      password: PASSWORD,
    });
    assert.equal(whileMultiUser.statusCode, 200, whileMultiUser.body);
    assert.deepEqual(await registrationState(), { open: false, reason: 'closed' });
    delete process.env.COLP_MULTI_USER;
  });

  test('sign-up may omit email and still signs in by username', async () => {
    delete process.env.COLP_MULTI_USER;
    await fixture.pool.query('delete from "auth_users"');
    assert.deepEqual(await registrationState(), { open: true, reason: 'first-run' });

    const signUp = await post('/sign-up/email', { username: 'solo', password: PASSWORD }, SETUP);
    assert.equal(signUp.statusCode, 200, signUp.body);
    const stored = await fixture.pool.query<{ email: string; username: string }>(
      'select email, username from "auth_users" where username = $1',
      ['solo'],
    );
    assert.equal(stored.rows[0]?.email, 'solo@users.invalid');
    assert.equal(stored.rows[0]?.username, 'solo');

    const byUsername = await post('/sign-in/username', { username: 'solo', password: PASSWORD });
    assert.equal(byUsername.statusCode, 200, byUsername.body);
    assert.ok(sessionCookie(byUsername), 'username sign-in must set __Host-known_session');

    const second = await post('/sign-up/email', { username: 'solo2', password: PASSWORD });
    assert.equal(second.statusCode, 403);
    assert.equal((second.json() as { code?: string }).code, 'registration_closed');
    assert.deepEqual(await registrationState(), { open: false, reason: 'closed' });
  });

  test('the first sign-up needs the setup token (D27)', async () => {
    delete process.env.COLP_MULTI_USER;
    await fixture.pool.query('delete from "auth_users"');
    const missing = await post('/sign-up/email', { username: 'early', password: PASSWORD });
    assert.equal(missing.statusCode, 403, missing.body);
    assert.equal((missing.json() as { code?: string }).code, 'setup_token_required');
    const wrong = await post('/sign-up/email', { username: 'early', password: PASSWORD },
      { 'colp-setup-token': `${SETUP_TOKEN}x` });
    assert.equal(wrong.statusCode, 403);
    assert.equal((wrong.json() as { code?: string }).code, 'setup_token_required');
    assert.equal((await fixture.pool.query('select count(*)::int as n from "auth_users"')).rows[0].n, 0);
    assert.deepEqual(await registrationState(), { open: true, reason: 'first-run' });
    const right = await post('/sign-up/email', { username: 'early', password: PASSWORD }, SETUP);
    assert.equal(right.statusCode, 200, right.body);
  });

  test('first-run federated sign-in cannot claim the owner slot', async () => {
    delete process.env.COLP_MULTI_USER;
    await fixture.pool.query('delete from "auth_users"');
    const response = await post('/sign-in/social', {
      provider: 'google', callbackURL: '/dashboard',
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal((response.json() as { code?: string }).code, 'setup_token_required');
    const callback = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/callback/google?code=untrusted&state=untrusted`,
      headers: { origin: TRUSTED_ORIGIN },
    });
    assert.equal(callback.statusCode, 403, callback.body);
    assert.equal((callback.json() as { code?: string }).code, 'setup_token_required');
    assert.equal((await fixture.pool.query('select count(*)::int as n from "auth_users"')).rows[0].n, 0);
  });

  test('concurrent first sign-ups create exactly one owner (D27)', async () => {
    delete process.env.COLP_MULTI_USER;
    await applySingleOwnerGuard(fixture.db as never);
    try {
      await fixture.pool.query(
        'insert into colp_instance_settings (singleton, single_owner) values (true, true)',
      );
      for (let round = 0; round < 3; round += 1) {
        await fixture.pool.query('delete from "auth_users"');
        const results = await Promise.all(['racer_a', 'racer_b', 'racer_c'].map((name) =>
          post('/sign-up/email', { username: `${name}_${round}`, password: PASSWORD }, SETUP)));
        assert.equal(results.filter((res) => res.statusCode === 200).length, 1,
          results.map((res) => `${res.statusCode} ${res.body}`).join(' | '));
        assert.equal((await fixture.pool.query('select count(*)::int as n from "auth_users"')).rows[0].n, 1);
      }
    } finally {
      await fixture.pool.query('drop trigger if exists auth_users_single_owner_guard on "auth_users"');
      await fixture.pool.query('drop function if exists colp_single_owner_guard()');
      await fixture.pool.query('drop table if exists colp_instance_settings');
    }
  });
});

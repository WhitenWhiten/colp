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

const TRUSTED_ORIGIN = 'https://app.example.test';
const BASE_PATH = '/api/v1/auth';
const PASSWORD = 'password-123'; // secret-scan: allow 'password-123'

const previousMultiUser = process.env.COLP_MULTI_USER;
const previousEdition = process.env.KNOWN_EDITION;

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
  });

  function post(path: string, body: unknown) {
    return app.inject({
      method: 'POST',
      url: `${BASE_PATH}${path}`,
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
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
    });
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

    const signUp = await post('/sign-up/email', { username: 'solo', password: PASSWORD });
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
});

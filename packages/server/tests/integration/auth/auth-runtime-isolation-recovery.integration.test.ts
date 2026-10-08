/**
 * AUTH-P1-a: recovery reset and HTTP change-password share the account
 * epoch-revoke path. The global MCP incident epoch stays put. Split from
 * auth-runtime-isolation.integration.test.ts so each file stays at or below
 * the 600-line granularity ceiling.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import {
  createAccountRecoveryService,
  type RecoveryServerPort,
} from '../../../src/modules/auth/index.js';
import { createPostgresMcpOauthRevocationStore } from '../../../src/infrastructure/database/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import {
  F3_PASSWORD,
  F3_SESSION_COOKIE_NAME,
  F3_TRUSTED_ORIGIN,
  f3CookieHeader,
  f3SessionCookieOf,
  f3TestEnv,
} from '../../support/auth-runtime-isolation-helpers.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('AUTH-P1-a: recovery reset and HTTP change-password share the epoch-revoke path', () => {
  const NEW_PASSWORD = 'new-password-456';
  let isolated: IsolatedPostgresRuntime;
  let app: ReturnType<typeof buildApiApp>;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  let mcpStore: ReturnType<typeof createPostgresMcpOauthRevocationStore>;
  let composition: ReturnType<typeof composeBetterAuthComposition>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('auth_p1a_shared_instance');
    await runMigrations(isolated.runtime.db, 'latest');
    const config = loadConfig({
      ...f3TestEnv(),
    });
    mailbox = createAuthTestMailbox();
    const sender = createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') });
    mcpStore = createPostgresMcpOauthRevocationStore({ db: isolated.runtime.db });
    composition = composeBetterAuthComposition({
      config,
      db: isolated.runtime.db,
      authEmail: sender,
      logger: createLogger('silent'),
      mcpOauthRevocationStore: mcpStore,
    });
    assert.ok(composition.betterAuth, 'composition must expose the shared instance');
    assert.equal(composition.betterAuth, composition.betterAuthRuntime?.auth);
    const sharedAuth = composition.betterAuth as unknown as {
      readonly api: {
        requestPasswordReset(input: { readonly body: { readonly email: string } }): Promise<unknown>;
        resetPasswordEmailOTP(input: {
          readonly body: { readonly email: string; readonly otp: string; readonly password: string };
        }): Promise<unknown>;
        sendVerificationOTP(input: {
          readonly body: { readonly email: string; readonly type: string };
        }): Promise<unknown>;
      };
    };
    const recoveryServer: RecoveryServerPort = {
      async requestPasswordReset({ email }) {
        await sharedAuth.api.requestPasswordReset({ body: { email } });
      },
      async resetPasswordWithEmailOtp({ email, otp, newPassword }) {
        await sharedAuth.api.resetPasswordEmailOTP({ body: { email, otp, password: newPassword } });
      },
    };
    app = buildApiApp({
      config,
      identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: composition.browserSessionAuthority,
      betterAuthRuntime: composition.betterAuthRuntime,
      accountRecovery: createAccountRecoveryService(recoveryServer),
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await isolated?.close();
  });

  async function signUpVerified(email: string): Promise<{ cookie: string; accountId: string }> {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: F3_TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'P1a User', email, password: F3_PASSWORD }),
    });
    assert.equal(signup.statusCode, 200, 'sign-up must succeed');
    const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
    assert.ok(mail, 'sign-up must deliver verification email');
    const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'verification email must carry the JWT');
    const verify = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/verify-email?token=${token}`,
      headers: { origin: F3_TRUSTED_ORIGIN },
    });
    assert.equal(verify.statusCode, 200, 'mailbox verification must succeed');
    const cookieValue = f3SessionCookieOf(verify);
    assert.ok(cookieValue, 'autoSignInAfterVerification must set the session cookie');
    const decoded = decodeURIComponent(cookieValue);
    const mapping = await isolated.runtime.pool.query<{ account_id: string }>(
      `select m.account_id from auth_user_account_map m
         join auth_users u on u.id = m.auth_user_id
        where u.email = $1`,
      [email],
    );
    assert.ok(mapping.rows[0], 'A2 must map the verified user');
    return { cookie: f3CookieHeader(F3_SESSION_COOKIE_NAME, decoded), accountId: mapping.rows[0].account_id };
  }

  async function securityEpoch(accountId: string): Promise<bigint> {
    const row = await isolated.runtime.pool.query<{ security_epoch: string }>(
      'select security_epoch from accounts where id = $1',
      [accountId],
    );
    assert.ok(row.rows[0], 'account must exist');
    return BigInt(row.rows[0].security_epoch);
  }

  test('HTTP change-password and recovery OTP reset bump the account boundary without moving the global MCP epoch', async () => {
    const changeEmail = `p1a-change-${randomUUID().slice(0, 8)}@example.test`;
    const { cookie: changeCookie, accountId: changeAccountId } = await signUpVerified(changeEmail);
    const epochBeforeChange = await securityEpoch(changeAccountId);
    const mcpBeforeChange = await mcpStore.securityEpoch();

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: {
        'content-type': 'application/json',
        origin: F3_TRUSTED_ORIGIN,
        cookie: changeCookie,
      },
      payload: JSON.stringify({ currentPassword: F3_PASSWORD, newPassword: NEW_PASSWORD }),
    });
    assert.equal(changed.statusCode, 200, `change-password must succeed: ${changed.body}`);
    const epochAfterChange = await securityEpoch(changeAccountId);
    assert.ok(epochAfterChange > epochBeforeChange, 'HTTP change-password must bump accounts.security_epoch');
    const changeBoundary = await mcpStore.readAccountSecurityBoundary(changeAccountId);
    assert.equal(changeBoundary?.securityEpoch, epochAfterChange.toString(10));
    assert.ok(changeBoundary?.bumpedAt, 'HTTP change-password stamps the account MCP boundary');
    assert.equal(await mcpStore.securityEpoch(), mcpBeforeChange, 'HTTP change-password must not move the global MCP incident epoch');

    const resetEmail = `p1a-reset-${randomUUID().slice(0, 8)}@example.test`;
    const { accountId: resetAccountId } = await signUpVerified(resetEmail);
    const epochBeforeReset = await securityEpoch(resetAccountId);
    const mcpBeforeReset = await mcpStore.securityEpoch();

    const sharedAuth = composition.betterAuth as unknown as {
      readonly api: {
        sendVerificationOTP(input: {
          readonly body: { readonly email: string; readonly type: string };
        }): Promise<unknown>;
      };
    };
    await sharedAuth.api.sendVerificationOTP({ body: { email: resetEmail, type: 'forget-password' } });
    const otp = mailbox.otpFor({ email: resetEmail, purpose: 'otp:forget-password' });
    assert.ok(otp, 'forget-password OTP must be delivered');

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recovery/otp-reset',
      headers: { 'content-type': 'application/json', origin: F3_TRUSTED_ORIGIN },
      payload: JSON.stringify({ email: resetEmail, otp, newPassword: NEW_PASSWORD }),
    });
    assert.equal(reset.statusCode, 200, `recovery otp-reset must succeed: ${reset.body}`);
    const epochAfterReset = await securityEpoch(resetAccountId);
    assert.ok(epochAfterReset > epochBeforeReset, 'recovery OTP reset must bump accounts.security_epoch');
    const resetBoundary = await mcpStore.readAccountSecurityBoundary(resetAccountId);
    assert.equal(resetBoundary?.securityEpoch, epochAfterReset.toString(10));
    assert.ok(resetBoundary?.bumpedAt, 'recovery OTP reset stamps the account MCP boundary');
    assert.equal(await mcpStore.securityEpoch(), mcpBeforeReset, 'recovery OTP reset must not move the global MCP incident epoch');
  });
});

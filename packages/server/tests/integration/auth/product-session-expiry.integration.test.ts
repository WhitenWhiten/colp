import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import { F3_PASSWORD, F3_TRUSTED_ORIGIN, f3CookieHeader, f3SessionCookieOf, F3_SESSION_COOKIE_NAME } from '../../support/auth-runtime-isolation-helpers.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { T09_CIMD_CLIENT_ID, t09Authorize, t09IssuerMcpEnv, t09TestFetchClientMetadataResource } from '../../support/mcp-oauth-builtin-issuer-helpers.js';

describeWithPostgres('product expiry gates Better Auth identity mutations and OAuth authorization', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresRuntime>>;
  let app: ReturnType<typeof buildApiApp>;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('product_session_expiry');
    await runMigrations(isolated.runtime.db, 'latest');
    const config = loadConfig(t09IssuerMcpEnv({ KNOWN_FEATURE_MCP_READ: 'false' }));
    mailbox = createAuthTestMailbox();
    const composition = composeBetterAuthComposition({ config, db: isolated.runtime.db,
      authEmail: createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') }),
      logger: createLogger('silent'), testFetchClientMetadataResource: t09TestFetchClientMetadataResource });
    app = buildApiApp({ config, identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: composition.browserSessionAuthority, betterAuthRuntime: composition.betterAuthRuntime,
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }) });
  }, 120_000);
  afterAll(async () => { await app?.close(); await isolated?.close(); });

  const headers = { 'content-type': 'application/json', origin: F3_TRUSTED_ORIGIN };
  async function signIn() {
    const email = `expiry-${randomUUID()}@example.test`;
    const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-up/email', headers,
      payload: { name: 'Expiry', email, password: F3_PASSWORD } });
    expect(signup.statusCode, signup.body).toBe(200);
    const token = mailbox.lastMailFor({ email, purpose: 'email-verification' })?.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    expect(token).toBeTruthy();
    const verified = await app.inject({ url: `/api/v1/auth/verify-email?token=${token}`, headers });
    expect(verified.statusCode, verified.body).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email', headers,
      payload: { email, password: F3_PASSWORD } });
    expect(login.statusCode, login.body).toBe(200);
    const value = decodeURIComponent(f3SessionCookieOf(login)!);
    return { value, cookie: f3CookieHeader(F3_SESSION_COOKIE_NAME, value), email };
  }

  test.each(['idle', 'absolute'] as const)('%s expiry refuses email-change OTP, confirmation and OAuth without a preceding product read', async mode => {
    const { cookie, value, email } = await signIn(), newEmail = `new-${randomUUID()}@example.test`;
    const change = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1/auth/email-otp/${path}`,
      headers: { ...headers, cookie }, payload });
    const valid = await change('request-email-change', { newEmail });
    expect(valid.statusCode, valid.body).toBe(200);
    const otp = mailbox.otpFor({ email: newEmail, purpose: 'otp:change-email' });
    expect(otp).toBeTruthy();
    const authorize = () => t09Authorize(app, { clientId: T09_CIMD_CLIENT_ID, cookie: value,
      challenge: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
    expect((await authorize()).location).toContain('/consent');
    const before = await isolated.runtime.pool.query(`SELECT s.id,s."expiresAt" FROM auth_sessions s
      JOIN auth_users u ON u.id=s."userId" WHERE u.email=$1`, [email]);
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
    const sessionId = before.rows[0].id;
    await isolated.runtime.pool.query(`UPDATE known_auth_session_metadata SET idle_expires_at=clock_timestamp()-interval '1 second',
      absolute_expires_at=CASE WHEN $2 THEN clock_timestamp()-interval '1 second' ELSE absolute_expires_at END
      WHERE auth_session_id=$1`, [sessionId, mode === 'absolute']);
    const sent = mailbox.sentCount;
    // Do not call product authenticate/get-session here: it marks expired metadata
    // revoked and would hide the original before-hook bypass.
    for (const response of [await change('request-email-change', { newEmail }), await change('change-email', { newEmail, otp })]) {
      expect(response.statusCode, response.body).toBe(401);
      expect(response.json().error).toMatchObject({ code: 'authentication_required', recovery: 'user_action' });
    }
    expect(mailbox.sentCount).toBe(sent);
    const denied = await authorize();
    expect(denied.statusCode, denied.body).toBe(401);
    expect(denied.location).toBeNull();
    const unchanged = await isolated.runtime.pool.query('SELECT email FROM auth_users WHERE id=(SELECT "userId" FROM auth_sessions WHERE id=$1)', [sessionId]);
    expect(unchanged.rows).toEqual([{ email }]);
  });
});

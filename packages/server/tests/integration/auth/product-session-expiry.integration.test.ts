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
import { BUILTIN_ISSUER_TEST_SCOPE_LIST, submitBuiltinIssuerConsent } from '../../support/builtin-issuer-test-helpers.js';
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

  test('product expiry refuses password change without a preceding product read', async () => {
    const { cookie, email } = await signIn();
    const sessionRow = await isolated.runtime.pool.query<{ id: string }>(
      `SELECT s.id FROM auth_sessions s JOIN auth_users u ON u.id=s."userId" WHERE u.email=$1`, [email]);
    expect(sessionRow.rows).toHaveLength(1);
    const passwordBefore = await isolated.runtime.pool.query<{ password: string }>(
      `SELECT a.password FROM auth_accounts a JOIN auth_users u ON u.id=a."userId" WHERE u.email=$1`, [email]);
    await isolated.runtime.pool.query(`UPDATE known_auth_session_metadata
      SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE auth_session_id=$1`,
    [sessionRow.rows[0]!.id]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { ...headers, cookie },
      payload: { currentPassword: F3_PASSWORD, newPassword: 'replacement-password-456' },
    });
    expect(response.statusCode, response.body).toBe(401);
    const passwordAfter = await isolated.runtime.pool.query<{ password: string }>(
      `SELECT a.password FROM auth_accounts a JOIN auth_users u ON u.id=a."userId" WHERE u.email=$1`, [email]);
    expect(passwordAfter.rows[0]?.password).toBe(passwordBefore.rows[0]?.password);
  });

  test('product expiry refuses OAuth consent approval (code minting)', async () => {
    const { cookie, value, email } = await signIn();
    const authorize = await t09Authorize(app, {
      clientId: T09_CIMD_CLIENT_ID,
      cookie: value,
      challenge: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(authorize.location, authorize.body).toContain('/consent');
    const oauthQuery = new URL(authorize.location!, F3_TRUSTED_ORIGIN).search.slice(1);
    const sessionRow = await isolated.runtime.pool.query<{ id: string }>(
      `SELECT s.id FROM auth_sessions s JOIN auth_users u ON u.id=s."userId" WHERE u.email=$1`, [email]);
    expect(sessionRow.rows).toHaveLength(1);
    await isolated.runtime.pool.query(`UPDATE known_auth_session_metadata
      SET idle_expires_at=clock_timestamp()-interval '1 second' WHERE auth_session_id=$1`,
    [sessionRow.rows[0]!.id]);

    const response = await submitBuiltinIssuerConsent(app, {
      accept: true,
      scope: BUILTIN_ISSUER_TEST_SCOPE_LIST,
      oauth_query: oauthQuery,
    }, { cookie, origin: F3_TRUSTED_ORIGIN });
    expect(response.statusCode, response.body).toBe(401);
  });

  test('authorize with a stale session cookie falls through to the login redirect', async () => {
    // The cookie name is present but the BA session behind it does not
    // resolve: Better Auth must own the request and redirect to login.
    const stale = `stale-session-token.${'A'.repeat(43)}=`;
    const response = await t09Authorize(app, {
      clientId: T09_CIMD_CLIENT_ID,
      cookie: stale,
      challenge: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(response.statusCode, response.body).not.toBe(401);
    expect(response.location).toBeTruthy();
    expect(new URL(response.location!, 'https://login.invalid').pathname).toBe('/login');
  });

  test('sign-in with a paused oauth_query resumes authorize on the fresh session', async () => {
    // The standard MCP login resumption: Better Auth pauses `/oauth2/authorize`
    // with a signed query, the login form posts it back with the credential,
    // and the provider re-dispatches authorize with the brand-new session on
    // the context (its cookie is not in the request yet). The product gate must
    // keep that session and admit it, so the browser lands on consent instead
    // of looping back to /login.
    const email = `resume-${randomUUID()}@example.test`;
    const signup = await app.inject({
      method: 'POST', url: '/api/v1/auth/sign-up/email', headers,
      payload: { name: 'Resume', email, password: F3_PASSWORD },
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const token = mailbox.lastMailFor({ email, purpose: 'email-verification' })?.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    expect(token).toBeTruthy();
    const verified = await app.inject({ url: `/api/v1/auth/verify-email?token=${token}`, headers });
    expect(verified.statusCode, verified.body).toBe(200);

    const challenge = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const paused = await t09Authorize(app, { clientId: T09_CIMD_CLIENT_ID, challenge });
    expect(paused.statusCode, paused.body).not.toBe(401);
    expect(paused.location, paused.body).toContain('/login');
    const oauthQuery = new URL(paused.location!, F3_TRUSTED_ORIGIN).search.slice(1);
    expect(new URLSearchParams(oauthQuery).get('sig')).toBeTruthy();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers: { ...headers, accept: 'application/json' },
      payload: { email, password: F3_PASSWORD, oauth_query: oauthQuery },
    });
    expect(login.statusCode, login.body).toBe(200);
    const continuation = login.headers.location
      ?? (login.json() as { readonly url?: string }).url;
    expect(continuation, login.body).toBeTruthy();
    expect(new URL(continuation!, F3_TRUSTED_ORIGIN).pathname).toBe('/consent');
  });

  test('email change revokes the other browser session and keeps the requesting one', async () => {
    const { cookie, value, email } = await signIn();
    const secondLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in/email',
      headers,
      payload: { email, password: F3_PASSWORD },
    });
    expect(secondLogin.statusCode, secondLogin.body).toBe(200);
    const secondValue = decodeURIComponent(f3SessionCookieOf(secondLogin)!);
    expect(secondValue).not.toBe(value);
    const sessionFor = (sessionCookieValue: string) => app.inject({
      url: '/api/v1/session',
      headers: { ...headers, cookie: f3CookieHeader(F3_SESSION_COOKIE_NAME, sessionCookieValue) },
    });
    expect((await sessionFor(secondValue)).json()).toMatchObject({ authenticated: true });

    const newEmail = `changed-${randomUUID()}@example.test`;
    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-otp/request-email-change',
      headers: { ...headers, cookie },
      payload: { newEmail },
    });
    expect(request.statusCode, request.body).toBe(200);
    const otp = mailbox.otpFor({ email: newEmail, purpose: 'otp:change-email' });
    expect(otp).toBeTruthy();
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email-otp/change-email',
      headers: { ...headers, cookie },
      payload: { newEmail, otp },
    });
    expect(confirm.statusCode, confirm.body).toBe(200);

    // Every other browser session is revoked; only the requesting session
    // keeps a live BA carrier and a metadata epoch realigned to the committed
    // email-change bump.
    expect((await sessionFor(secondValue)).json()).toEqual({ authenticated: false });
    const current = await sessionFor(value);
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({ authenticated: true });
    const remaining = await isolated.runtime.pool.query<{ id: string }>(
      `SELECT s.id FROM auth_sessions s JOIN auth_users u ON u.id=s."userId" WHERE u.email=$1`, [newEmail]);
    expect(remaining.rows).toHaveLength(1);
  });
});

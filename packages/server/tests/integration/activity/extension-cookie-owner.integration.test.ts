import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import { composeBetterAuthComposition } from '../../../src/bootstrap/composition.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createActivityStore } from '../../../src/infrastructure/activity/store.js';
import { createAutomationUnitOfWork } from '../../../src/infrastructure/automation/unit-of-work.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import { f3TestEnv, F3_PASSWORD, F3_TRUSTED_ORIGIN, f3SessionCookieOf, f3CookieHeader, F3_SESSION_COOKIE_NAME } from '../../support/auth-runtime-isolation-helpers.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';
import { readActivitySummary } from '../../../../extension/src/automation/activity-status.js';
import { readPauseStatus } from '../../../../extension/src/automation/pause-status.js';
import { readServerStatus } from '../../../../extension/src/automation/server-status.js';

describeWithPostgres('extension cookie reads use auth user identity rather than business account identity', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedPostgresRuntime>>;
  let app: ReturnType<typeof buildApiApp>;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('extension_cookie_owner');
    await runMigrations(isolated.runtime.db, 'latest');
    const config = loadConfig({ ...f3TestEnv(), KNOWN_FEATURE_AGENT_ACTIVITY: 'true' });
    mailbox = createAuthTestMailbox();
    const composition = composeBetterAuthComposition({ config, db: isolated.runtime.db,
      authEmail: createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') }), logger: createLogger('silent') });
    app = buildApiApp({ config, identityUnitOfWork: createPostgresIdentityUnitOfWork(isolated.runtime.db),
      browserSessionAuthority: composition.browserSessionAuthority, betterAuthRuntime: composition.betterAuthRuntime,
      activity: createActivityStore(isolated.runtime.db, config.productEditorCursor.current.key),
      automationUnitOfWork: createAutomationUnitOfWork(isolated.runtime.db, 'extension-owner-server'),
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }) });
  }, 120_000);
  afterAll(async () => { await app?.close(); await isolated?.close(); });

  const headers = { 'content-type': 'application/json', origin: F3_TRUSTED_ORIGIN };
  async function signIn() {
    const email = `owner-${randomUUID()}@example.test`;
    const signup = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-up/email', headers,
      payload: { name: 'Owner', email, password: F3_PASSWORD } });
    expect(signup.statusCode, signup.body).toBe(200);
    const token = mailbox.lastMailFor({ email, purpose: 'email-verification' })?.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    expect(token).toBeTruthy();
    const verified = await app.inject({ url: `/api/v1/auth/verify-email?token=${token}`, headers });
    expect(verified.statusCode, verified.body).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in/email', headers, payload: { email, password: F3_PASSWORD } });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = f3CookieHeader(F3_SESSION_COOKIE_NAME, decodeURIComponent(f3SessionCookieOf(login)!));
    const session = await app.inject({ url: '/api/v1/auth/get-session', headers: { cookie } });
    const authUserId = session.json().user.id as string;
    const mapping = await isolated.runtime.db.selectFrom('auth_user_account_map').select('account_id').where('auth_user_id', '=', authUserId).executeTakeFirstOrThrow();
    return { cookie, authUserId, accountId: mapping.account_id };
  }
  const transport = (cookie: string): typeof fetch => async input => {
    const url = new URL(String(input));
    const response = await app.inject({ url: `${url.pathname}${url.search}`, headers: { cookie } });
    return new Response(response.body, { status: response.statusCode, headers: response.headers as HeadersInit });
  };

  test.each([false, true])('same-user Activity, rules, runs and pause work (adopted legacy subject: %s)', async adopted => {
    const { cookie, authUserId, accountId } = await signIn();
    expect(accountId).not.toBe(authUserId);
    if (adopted) await isolated.runtime.db.updateTable('accounts').set({ subject_id: 'legacy-' + randomUUID() }).where('id', '=', accountId).execute();
    for (const path of ['/api/v1/me/activity/summary', '/api/v1/me/automations/rules', '/api/v1/me/automations/runs', '/api/v1/me/automations/pause']) {
      const response = await app.inject({ url: path, headers: { cookie } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['known-auth-user-id']).toBe(authUserId);
      expect(response.headers[path.includes('/activity/') ? 'known-activity-account-id' : 'known-automation-account-id']).toBe(accountId);
    }
    await isolated.runtime.db.insertInto('automation_settings').values({ owner_id: accountId, paused: true,
      paused_at: new Date(), paused_by: 'owner', revision: '1' }).execute();
    const fetcher = transport(cookie), owner = { serverOrigin: F3_TRUSTED_ORIGIN, accountId: authUserId };
    expect(await readActivitySummary(owner.serverOrigin, authUserId, fetcher)).toMatchObject({ ok: true, summary: { unreadCount: 0 } });
    expect(await readPauseStatus(owner, fetcher)).toMatchObject({ ok: true, pause: { paused: true } });
    expect(await readServerStatus(owner.serverOrigin, authUserId, fetcher)).toMatchObject({ ok: true, rules: [], runs: [] });
    const foreign = await signIn(), switched = transport(foreign.cookie);
    expect(await readActivitySummary(owner.serverOrigin, authUserId, switched)).toEqual({ ok: false, problem: 'signedOut' });
    expect(await readPauseStatus(owner, switched)).toEqual({ ok: false, problem: 'signedOut' });
    expect(await readServerStatus(owner.serverOrigin, authUserId, switched)).toEqual({ ok: false, problem: 'signedOut' });
  });
});

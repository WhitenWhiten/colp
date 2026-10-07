import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  buildBetterAuthOptions,
  createBetterAuthRuntime,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { applyBetterAuth17LibrarySchemaExpand } from '../../support/better-auth-postgres.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  T09_PASSWORD,
  T09_SESSION_COOKIE,
  T09_TRUSTED_ORIGIN,
  t09CookieHeader,
  t09IssuerMcpEnv,
  t09SessionCookieOf,
  t09UniqueEmail,
} from '../../support/mcp-oauth-builtin-issuer-helpers.js';

const BASE_PATH = '/api/v1/auth';
const REGISTER_PATH = `${BASE_PATH}/oauth2/register`;
const UNAVAILABLE = {
  error: 'temporarily_unavailable',
  error_description: 'Dynamic client registration capacity is temporarily unavailable.',
};

describeWithPostgres('session-owned DCR HTTP capacity', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: FastifyInstance;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('dcr_capacity_http_owned', {
      maxConnections: 8,
      applicationName: 'known-dcr-owned-http',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    mailbox = createAuthTestMailbox();
    const config = loadConfig(t09IssuerMcpEnv({
      KNOWN_FEATURE_MCP_READ: 'false',
      BETTER_AUTH_DCR_MAX_ANONYMOUS_CLIENTS: '1',
      BETTER_AUTH_DCR_MAX_OWNED_CLIENTS_PER_USER: '1',
      BETTER_AUTH_DCR_MAX_OWNED_CLIENTS: '100000',
      BETTER_AUTH_DCR_UNUSED_CLIENT_RETENTION_SECONDS: '60',
    }));
    const built = buildBetterAuthConfig({ ...config.betterAuth });
    assert.ok(built?.oauthIssuer, 'issuer-on config must produce oauthIssuer');
    await applyBetterAuth17LibrarySchemaExpand(buildBetterAuthOptions({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
    }));
    const runtime = createBetterAuthRuntime({
      enabled: true,
      config: built,
      database: { db: isolated.runtime.db, type: 'postgres', transaction: true },
      authEmail: createAuthEmailAdapter({ provider: mailbox.provider, logger: createLogger('silent') }),
      businessAccount: { unitOfWork: createPostgresBusinessAccountUnitOfWork(isolated.runtime.db) },
      logger: createLogger('silent'),
    });
    assert.ok(runtime, 'issuer-on runtime must construct');
    app = buildApiApp({
      config,
      betterAuthRuntime: runtime,
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await isolated?.close();
  });

  function registration(clientName: string, cookie?: string) {
    return app.inject({
      method: 'POST',
      url: REGISTER_PATH,
      headers: {
        'content-type': 'application/json',
        origin: T09_TRUSTED_ORIGIN,
        ...(cookie === undefined ? {} : { cookie: t09CookieHeader(T09_SESSION_COOKIE, cookie) }),
      },
      payload: JSON.stringify({
        client_name: clientName,
        redirect_uris: ['http://127.0.0.1:8943/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'native',
      }),
    });
  }

  test('a logged-in register still 201 after anonymous cap is full, then 503 at per-user cap', async () => {
    const anonymous = await registration('owned-http-anonymous');
    assert.equal(anonymous.statusCode, 201, anonymous.body);
    const anonymousBody = anonymous.json() as { client_id?: unknown };
    assert.equal(typeof anonymousBody.client_id, 'string');

    const email = t09UniqueEmail('dcr-owned-http');
    const signup = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-up/email`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'DCR Owned User', email, password: T09_PASSWORD }),
    });
    assert.equal(signup.statusCode, 200, signup.body);
    const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
    assert.ok(mail, 'verification email must be delivered');
    const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'verification email must carry the token');
    const verify = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/verify-email?token=${token}`,
      headers: { origin: T09_TRUSTED_ORIGIN },
    });
    assert.equal(verify.statusCode, 200, verify.body);
    const signin = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/email`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, password: T09_PASSWORD }),
    });
    assert.equal(signin.statusCode, 200, signin.body);
    const cookie = t09SessionCookieOf(signin);
    assert.ok(cookie, 'verified sign-in must set the session cookie');

    const owned = await registration('owned-http-first', cookie);
    assert.equal(owned.statusCode, 201, owned.body);
    const ownedBody = owned.json() as { client_id?: unknown };
    assert.equal(typeof ownedBody.client_id, 'string');
    const ownedRow = await isolated.runtime.pool.query(
      `SELECT "userId" FROM "auth_oauth_client" WHERE "clientId" = $1`,
      [ownedBody.client_id],
    );
    assert.equal(typeof ownedRow.rows[0]?.userId, 'string');
    assert.notEqual(ownedRow.rows[0]?.userId, null);

    const secondOwned = await registration('owned-http-second', cookie);
    assert.equal(secondOwned.statusCode, 503);
    assert.equal(secondOwned.headers['cache-control'], 'no-store');
    assert.equal(secondOwned.headers['retry-after'], '60');
    assert.deepEqual(secondOwned.json(), UNAVAILABLE);

    const stillAnonymous = await registration('owned-http-anonymous-again');
    assert.equal(stillAnonymous.statusCode, 503);
    assert.deepEqual(stillAnonymous.json(), UNAVAILABLE);
  });
});

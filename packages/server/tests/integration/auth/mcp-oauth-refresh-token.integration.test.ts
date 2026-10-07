/**
 * MCP OAuth refresh contract: Better Auth mints refresh_token only when
 * offline_access is granted; capability-only grants stay access-token only.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresMcpOauthRevocationStore } from '../../../src/infrastructure/database/index.js';
import {
  buildBetterAuthOptions,
  createBetterAuthRuntime,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { createLogger } from '../../../src/infrastructure/telemetry/index.js';
import {
  BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  buildBetterAuthConfig,
} from '../../../src/modules/auth/better-auth-config.js';
import {
  createMcpOauthVerifier,
  mcpOauthAcceptedAudiences,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpResourceIdentity,
  mcpReadFeatureConfigAssertOptions,
} from '../../../src/modules/mcp/index.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import { applyBetterAuth17LibrarySchemaExpand } from '../../support/better-auth-postgres.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  BUILTIN_ISSUER_TEST_AUDIENCE,
  createJwksProviderFromKeySet,
  exchangeBuiltinIssuerToken,
  fetchBetterAuthJwks,
} from '../../support/builtin-issuer-test-helpers.js';
import type { JSONWebKeySet } from 'jose';
import {
  T09_CIMD_CLIENT_ID,
  T09_CIMD_SCOPE_WITH_OFFLINE_ACCESS,
  T09_PASSWORD,
  T09_TRUSTED_ORIGIN,
  t09CimdCodeGrant,
  t09ExchangeCode,
  t09InspectAccessToken,
  t09IssuerMcpEnv,
  t09PostMcp,
  t09SessionCookieOf,
  t09StubMcpProjections,
  t09TestFetchClientMetadataResource,
  t09UniqueEmail,
} from '../../support/mcp-oauth-builtin-issuer-helpers.js';

const BASE_PATH = '/api/v1/auth';

describeWithPostgres('MCP OAuth refresh token grant (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: FastifyInstance;
  let origin: string;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  let sessionCookie: string;
  let subjectId: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('mcp_oauth_refresh', {
      maxConnections: 8,
      applicationName: 'known-mcp-oauth-refresh',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    mailbox = createAuthTestMailbox();
    const config = loadConfig(t09IssuerMcpEnv());
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
      testFetchClientMetadataResource: t09TestFetchClientMetadataResource,
    });
    assert.ok(runtime, 'issuer-on runtime must construct');
    const revocationStore = createPostgresMcpOauthRevocationStore({ db: isolated.runtime.db });
    await revocationStore.bumpSecurityEpoch(`known.mcp.oauth.v1:${Date.now()}`);
    const jwksHolder: { keys?: JSONWebKeySet } = {};
    const oauthVerifier = createMcpOauthVerifier({
      issuer: config.mcp!.oauth.issuer,
      audience: mcpOauthAcceptedAudiences(config.mcp!.oauth.audience),
      allowedScopes: config.mcp!.oauth.scopes,
      jwks: {
        async getKeySet() {
          if (jwksHolder.keys === undefined) {
            throw new Error('JWKS must be snapshotted before MCP verify');
          }
          return createJwksProviderFromKeySet(jwksHolder.keys).getKeySet();
        },
      },
      isRevoked: (query) => revocationStore.isRevoked(query),
      securityEpoch: () => revocationStore.securityEpoch(),
      resolveAccountBySubject: async (sub) => {
        const row = await isolated.runtime.pool.query<{ id: string; subject_id: string; status: string }>(
          `select id, subject_id, status from accounts where subject_id = $1`,
          [sub],
        );
        const account = row.rows[0];
        return account === undefined
          ? null
          : { id: account.id, subjectId: account.subject_id, status: account.status };
      },
    });
    const tools = emptyReadToolAdapterBundle();
    const projections = t09StubMcpProjections();
    app = buildApiApp({
      config,
      betterAuthRuntime: runtime,
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
      mcpReadTransport: {
        changeSignalSource: createPhase4bMcpChangeSignalSource(),
        readToolAdapter: tools.adapter,
        readToolParamDeclarations: tools.paramDeclarations,
        oauthVerifier,
      },
      mcpReadResourceProjection: projections.collection,
      mcpSnapshotResourceProjection: projections.snapshot,
      mcpNodeResourceProjection: projections.node,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('server is not listening');
    origin = `http://127.0.0.1:${address.port}`;
    createPhase4bMcpResourceIdentity(
      config.mcp!,
      mcpReadFeatureConfigAssertOptions({ nodeEnv: 'test', oauthIssuerEnabled: true }),
    );
    const email = t09UniqueEmail('mcp-refresh');
    const signup = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-up/email`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'Refresh User', email, password: T09_PASSWORD }),
    });
    assert.equal(signup.statusCode, 200);
    const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
    assert.ok(mail, 'verification email must be delivered');
    const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
    assert.ok(token, 'verification email must carry the token');
    const verify = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/verify-email?token=${token}`,
      headers: { origin: T09_TRUSTED_ORIGIN },
    });
    assert.equal(verify.statusCode, 200);
    const signin = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-in/email`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
      payload: JSON.stringify({ email, password: T09_PASSWORD }),
    });
    assert.equal(signin.statusCode, 200);
    const cookie = t09SessionCookieOf(signin);
    assert.ok(cookie, 'verified sign-in must set the session cookie');
    sessionCookie = cookie;
    const user = await isolated.runtime.pool.query<{ id: string }>(
      `select id from auth_users where email = $1`,
      [email],
    );
    subjectId = user.rows[0]!.id;
    jwksHolder.keys = await fetchBetterAuthJwks(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await isolated?.close();
  });

  test('PRM advertises offline_access while MCP_OAUTH_SCOPES stays capability-only', async () => {
    const prm = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
    });
    assert.equal(prm.statusCode, 200);
    const body = prm.json() as { scopes_supported?: unknown };
    assert.deepEqual(body.scopes_supported, [
      'mcp:read:public',
      'mcp:read:own',
      'product:read',
      'product:write',
      'offline_access',
    ]);
  });

  test('offline_access grant mints a 3600s access token and a usable refresh_token', async () => {
    const grant = await t09CimdCodeGrant(app, sessionCookie, {
      scope: T09_CIMD_SCOPE_WITH_OFFLINE_ACCESS,
    });
    const token = await t09ExchangeCode(app, {
      code: grant.code,
      verifier: grant.verifier,
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    });
    assert.equal(token.statusCode, 200, token.body);
    const minted = token.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    assert.equal(typeof minted.access_token, 'string');
    assert.equal(typeof minted.refresh_token, 'string');
    assert.ok((minted.refresh_token ?? '').length > 0);
    assert.equal(minted.expires_in, BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS);
    const inspected = t09InspectAccessToken(minted.access_token!);
    assert.equal(inspected.claims.sub, subjectId);
    assert.equal(inspected.claims.aud, BUILTIN_ISSUER_TEST_AUDIENCE);
    assert.match(String(inspected.claims.scope), /\boffline_access\b/u);
    assert.equal(
      (inspected.claims.exp as number) - (inspected.claims.iat as number),
      BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    );

    const first = await t09PostMcp(origin, 'tools/list', 1, {
      authorization: `Bearer ${minted.access_token}`,
    });
    assert.equal(first.status, 200);

    const refreshed = await exchangeBuiltinIssuerToken(app, {
      grant_type: 'refresh_token',
      refresh_token: minted.refresh_token!,
      client_id: T09_CIMD_CLIENT_ID,
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    });
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    const next = refreshed.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    assert.equal(typeof next.access_token, 'string');
    assert.notEqual(next.access_token, minted.access_token);
    assert.equal(next.expires_in, BETTER_AUTH_OAUTH_ACCESS_TOKEN_EXPIRES_IN_SECONDS);
    const second = await t09PostMcp(origin, 'tools/list', 2, {
      authorization: `Bearer ${next.access_token}`,
    });
    assert.equal(second.status, 200);
    assert.ok(next.refresh_token);
    const changed = await app.inject({
      method: 'POST', url: `${BASE_PATH}/change-password`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN, cookie: `__Host-known_session=${sessionCookie}` },
      payload: { currentPassword: T09_PASSWORD, newPassword: 'refresh-revocation-password-456' },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    const denied = await exchangeBuiltinIssuerToken(app, {
      grant_type: 'refresh_token', refresh_token: next.refresh_token,
      client_id: T09_CIMD_CLIENT_ID, resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    });
    assert.equal(denied.statusCode, 400, denied.body);
    assert.equal(denied.json().error, 'invalid_grant');
  });
});

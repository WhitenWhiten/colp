/**
 * T-09: CIMD real-client e2e through the composed Fastify app (issuer-on).
 * Happy path is CIMD URL client_id + official POST /oauth2/consent — never
 * adminCreateOAuthClient / skip_consent.
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
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import {
  createMcpOauthVerifier,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpResourceIdentity,
  mcpOauthAcceptedAudiences,
  mcpReadFeatureConfigAssertOptions,
  McpOauthVerificationError,
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
  BUILTIN_ISSUER_TEST_AS_METADATA_URL,
  BUILTIN_ISSUER_TEST_AUDIENCE,
  BUILTIN_ISSUER_TEST_ISSUER,
  createJwksProviderFromKeySet,
  fetchBetterAuthJwks,
} from '../../support/builtin-issuer-test-helpers.js';
import type { JSONWebKeySet } from 'jose';
import {
  T09_ALLOWED_ALGS,
  T09_CIMD_CLIENT_ID,
  T09_CIMD_CLIENT_NAME,
  T09_CIMD_PRIVATE_CLIENT_ID,
  T09_CLAUDE_CIMD_CLIENT_ID,
  T09_CLAUDE_CIMD_METADATA,
  T09_CLAUDE_EPHEMERAL_REDIRECT,
  T09_CLAUDE_POST_EPHEMERAL_REDIRECT,
  T09_CLAUDE_SECOND_EPHEMERAL_REDIRECT,
  T09_PASSWORD,
  T09_TRUSTED_ORIGIN,
  t09Authorize,
  t09CimdCodeGrant,
  t09CreateSseReader,
  t09DcrCodeGrant,
  t09ExchangeCode,
  t09InspectAccessToken,
  t09InvalidToken,
  t09IsRevokedError,
  t09IssuerMcpEnv,
  t09PostMcp,
  t09ReadClaudeCimdFetchCount,
  t09RegisterDcrClient,
  t09ResetClaudeCimdFetchCount,
  t09SessionCookieOf,
  t09SignWrongAudJwt,
  t09StubMcpProjections,
  t09TestFetchClientMetadataResource,
  t09UniqueEmail,
  t09WaitNextUnixSecond,
} from '../../support/mcp-oauth-builtin-issuer-helpers.js';

const BASE_PATH = '/api/v1/auth';

describeWithPostgres('T-09 MCP OAuth built-in issuer CIMD e2e (real PostgreSQL)', () => {
  let isolated: IsolatedPostgresRuntime;
  let app: FastifyInstance;
  let origin: string;
  let mailbox: ReturnType<typeof createAuthTestMailbox>;
  let baSecret: string;
  let oauthVerifier: ReturnType<typeof createMcpOauthVerifier>;
  let revocationStore: ReturnType<typeof createPostgresMcpOauthRevocationStore>;
  let changeSource: ReturnType<typeof createPhase4bMcpChangeSignalSource>;
  let resourceUri: string;
  let subjectId: string;
  let sessionCookie: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('t09_mcp_oauth_issuer', {
      maxConnections: 12,
      applicationName: 'known-t09-mcp-oauth-issuer',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    mailbox = createAuthTestMailbox();
    const config = loadConfig(t09IssuerMcpEnv());
    const built = buildBetterAuthConfig({ ...config.betterAuth });
    assert.ok(built?.oauthIssuer, 'issuer-on config must produce oauthIssuer');
    baSecret = built.secret;
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
    revocationStore = createPostgresMcpOauthRevocationStore({ db: isolated.runtime.db });
    await revocationStore.bumpSecurityEpoch(`known.mcp.oauth.v1:${Date.now()}`);
    const jwksHolder: { keys?: JSONWebKeySet } = {};
    oauthVerifier = createMcpOauthVerifier({
      issuer: config.mcp!.oauth.issuer,
      audience: mcpOauthAcceptedAudiences(config.mcp!.oauth.audience),
      allowedScopes: config.mcp!.oauth.scopes,
      jwks: {
        async getKeySet() {
          if (jwksHolder.keys === undefined) {
            throw new Error('T-09 JWKS must be snapshotted before MCP verify');
          }
          return createJwksProviderFromKeySet(jwksHolder.keys).getKeySet();
        },
      },
      isRevoked: (query) => revocationStore.isRevoked(query),
      securityEpoch: () => revocationStore.securityEpoch(),
      requireAccountEpoch: true,
      resolveAccountBySubject: async (sub) => {
        const row = await isolated.runtime.pool.query<{ id: string; subject_id: string; status: string; security_epoch: string }>(
          `select id, subject_id, status, security_epoch from accounts where subject_id = $1`,
          [sub],
        );
        const account = row.rows[0];
        return account === undefined
          ? null
          : { id: account.id, subjectId: account.subject_id, status: account.status, securityEpoch: String(account.security_epoch) };
      },
    });
    const tools = emptyReadToolAdapterBundle();
    const projections = t09StubMcpProjections();
    changeSource = createPhase4bMcpChangeSignalSource();
    app = buildApiApp({
      config,
      betterAuthRuntime: runtime,
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
      mcpReadTransport: {
        changeSignalSource: changeSource,
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
    resourceUri = createPhase4bMcpResourceIdentity(
      config.mcp!,
      mcpReadFeatureConfigAssertOptions({ nodeEnv: 'test', oauthIssuerEnabled: true }),
    ).collectionMetadata('t09-cimd');
    const email = t09UniqueEmail('t09-cimd');
    const signup = await app.inject({
      method: 'POST',
      url: `${BASE_PATH}/sign-up/email`,
      headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
      payload: JSON.stringify({ name: 'T09 User', email, password: T09_PASSWORD }),
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
    const account = await isolated.runtime.pool.query<{ subject_id: string }>(
      `select a.subject_id from accounts a
       join auth_user_account_map m on m.account_id = a.id
       where m.auth_user_id = $1`,
      [subjectId],
    );
    assert.equal(account.rows[0]?.subject_id, subjectId, 'T-03: subject_id must equal BA user id');
    const jwks = await app.inject({ method: 'GET', url: `${BASE_PATH}/jwks` });
    assert.equal(jwks.statusCode, 200);
    jwksHolder.keys = await fetchBetterAuthJwks(app);
  }, 180_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await changeSource?.close?.();
    await isolated?.close();
  });

  test('discovery serves same-origin AS metadata with CIMD support', async () => {
    const inserted = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server/api/v1/auth',
    });
    assert.equal(inserted.statusCode, 200);
    const body = inserted.json() as {
      issuer?: string;
      client_id_metadata_document_supported?: unknown;
      grant_types_supported?: unknown;
      registration_endpoint?: unknown;
      scopes_supported?: unknown;
    };
    assert.equal(body.issuer, BUILTIN_ISSUER_TEST_ISSUER);
    assert.equal(body.client_id_metadata_document_supported, true);
    assert.equal(
      body.registration_endpoint,
      `${BUILTIN_ISSUER_TEST_ISSUER}/oauth2/register`,
    );
    assert.deepEqual(body.grant_types_supported, ['authorization_code', 'refresh_token']);
    assert.ok(Array.isArray(body.scopes_supported));
    assert.equal((body.scopes_supported as string[]).includes('offline_access'), true);
    assert.equal(BUILTIN_ISSUER_TEST_AS_METADATA_URL.endsWith('/api/v1/auth'), true);
    const nested = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/.well-known/oauth-authorization-server`,
    });
    if (nested.statusCode === 200) {
      assert.equal((nested.json() as { issuer?: string }).issuer, BUILTIN_ISSUER_TEST_ISSUER);
    }
  });

  test('CIMD client completes authorize, official consent, token, MCP read, and listen re-verify', async () => {
    const grant = await t09CimdCodeGrant(app, sessionCookie);
    assert.equal(grant.usedConsent, true, 'first CIMD grant must use POST /oauth2/consent');
    const token = await t09ExchangeCode(app, {
      code: grant.code,
      verifier: grant.verifier,
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    });
    assert.equal(token.statusCode, 200, token.body);
    const minted = token.json() as { access_token?: string; refresh_token?: unknown };
    assert.ok(typeof minted.access_token === 'string' && minted.access_token.length > 0);
    assert.equal(minted.refresh_token, undefined, 'capability-only grant must not mint a refresh token');
    const inspected = t09InspectAccessToken(minted.access_token);
    assert.equal(inspected.segments, 3);
    assert.equal(T09_ALLOWED_ALGS.includes(inspected.alg), true, inspected.alg);
    assert.equal(inspected.claims.aud, BUILTIN_ISSUER_TEST_AUDIENCE);
    assert.equal(inspected.claims.sub, subjectId);
    assert.equal(inspected.claims.iss, BUILTIN_ISSUER_TEST_ISSUER);
    assert.equal(inspected.claims.client_id, T09_CIMD_CLIENT_ID);
    assert.ok(typeof inspected.claims.jti === 'string' && inspected.claims.jti.length > 0);
    assert.ok(typeof inspected.claims.scope === 'string' && inspected.claims.scope.length > 0);
    assert.equal(typeof inspected.claims.exp, 'number');
    assert.equal(typeof inspected.claims.iat, 'number');
    assert.equal(typeof inspected.claims.known_account_epoch, 'string');

    const authorization = `Bearer ${minted.access_token}`;
    const tools = await t09PostMcp(origin, 'tools/list', 1, { authorization });
    assert.equal(tools.status, 200);
    const toolsBody = await tools.json() as { result?: { tools?: unknown[] }; error?: unknown };
    assert.ok(Array.isArray(toolsBody.result?.tools), JSON.stringify(toolsBody));

    const read = await t09PostMcp(origin, 'resources/read', 2, {
      authorization,
      params: { uri: resourceUri },
      extraHeaders: { 'mcp-name': resourceUri },
    });
    const readText = await read.text();
    assert.equal(read.status, 200, readText);
    const readBody = JSON.parse(readText) as { result?: { contents?: unknown[] } };
    assert.ok(Array.isArray(readBody.result?.contents), JSON.stringify(readBody));

    const listen = await t09PostMcp(origin, 'subscriptions/listen', 3, {
      authorization,
      accept: 'text/event-stream;q=1, application/json;q=0.5',
      params: { notifications: { resourceSubscriptions: [resourceUri], resourcesListChanged: true } },
    });
    assert.equal(listen.status, 200);
    const reader = t09CreateSseReader(listen);
    try {
      const ack = await reader.next();
      assert.equal(ack?.method, 'notifications/subscriptions/acknowledged');
      await changeSource.publish({ type: 'resource-list-changed' });
      const hint = await reader.next();
      assert.equal(
        hint?.method,
        'notifications/resources/list_changed',
        'happy-path listen must re-verify and deliver while the token is still valid',
      );
    } finally {
      reader.close();
    }
    const publicClient = await app.inject({
      method: 'GET',
      url: `${BASE_PATH}/oauth2/public-client?client_id=${encodeURIComponent(T09_CIMD_CLIENT_ID)}`,
    });
    if (publicClient.statusCode === 200) {
      const client = publicClient.json() as { client_name?: string };
      assert.equal(client.client_name, T09_CIMD_CLIENT_NAME);
    }
  });

  test('CIMD grant for the mcp-compat resource mints aud equal to that resource', async () => {
    const compatResource = `${new URL(BUILTIN_ISSUER_TEST_AUDIENCE).origin}/collections/-/mcp-compat`;
    const grant = await t09CimdCodeGrant(app, sessionCookie, { resource: compatResource });
    assert.equal(grant.usedConsent, true);
    const token = await t09ExchangeCode(app, {
      code: grant.code,
      verifier: grant.verifier,
      resource: compatResource,
    });
    assert.equal(token.statusCode, 200, token.body);
    const minted = token.json() as { access_token?: string };
    assert.ok(typeof minted.access_token === 'string' && minted.access_token.length > 0);
    const inspected = t09InspectAccessToken(minted.access_token);
    assert.equal(inspected.claims.aud, compatResource);
    assert.equal(inspected.claims.sub, subjectId);
    const verified = await oauthVerifier.verify({
      authorization: `Bearer ${minted.access_token}`,
    });
    assert.equal(verified.evidence.resourceAudience, compatResource);
  });

  test('DCR client registers, consents, and mints a JWT with the registered client_id', async () => {
    const registered = await t09RegisterDcrClient(app);
    const grant = await t09DcrCodeGrant(app, sessionCookie, registered);
    assert.equal(grant.usedConsent, true, 'DCR grant must use POST /oauth2/consent');
    const token = await t09ExchangeCode(app, {
      code: grant.code,
      verifier: grant.verifier,
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
      clientId: registered.clientId,
      redirectUri: registered.redirectUri,
    });
    assert.equal(token.statusCode, 200, token.body);
    const minted = token.json() as { access_token?: string };
    assert.ok(typeof minted.access_token === 'string' && minted.access_token.length > 0);
    const inspected = t09InspectAccessToken(minted.access_token);
    assert.equal(inspected.claims.client_id, registered.clientId);
    assert.equal(inspected.claims.aud, BUILTIN_ISSUER_TEST_AUDIENCE);
    assert.equal(inspected.claims.sub, subjectId);
    const tools = await t09PostMcp(origin, 'tools/list', 21, {
      authorization: `Bearer ${minted.access_token}`,
    });
    assert.equal(tools.status, 200);
  });

  test('Claude Code-shaped CIMD accepts different ephemeral localhost ports across cached sessions', async () => {
    t09ResetClaudeCimdFetchCount();
    const redirects = [T09_CLAUDE_EPHEMERAL_REDIRECT, T09_CLAUDE_SECOND_EPHEMERAL_REDIRECT];
    for (const [index, redirectUri] of redirects.entries()) {
      const grant = await t09CimdCodeGrant(app, sessionCookie, {
        clientId: T09_CLAUDE_CIMD_CLIENT_ID,
        redirectUri,
      });
      if (index === 0) {
        assert.equal(grant.usedConsent, true, 'first Claude-shaped grant must use POST /oauth2/consent');
      }
      const token = await t09ExchangeCode(app, {
        code: grant.code,
        verifier: grant.verifier,
        resource: BUILTIN_ISSUER_TEST_AUDIENCE,
        clientId: T09_CLAUDE_CIMD_CLIENT_ID,
        redirectUri,
      });
      assert.equal(token.statusCode, 200, `port ${redirectUri}: ${token.body}`);
      const minted = token.json() as { access_token?: string };
      assert.ok(typeof minted.access_token === 'string' && minted.access_token.length > 0);
      const inspected = t09InspectAccessToken(minted.access_token);
      assert.equal(inspected.claims.client_id, T09_CLAUDE_CIMD_CLIENT_ID);
    }
    assert.equal(t09ReadClaudeCimdFetchCount(), 1, 'the second port must succeed from the CIMD metadata cache');

    const stored = await isolated.runtime.pool.query<{ redirectUris: string[] }>(
      `SELECT "redirectUris" FROM "auth_oauth_client" WHERE "clientId" = $1`,
      [T09_CLAUDE_CIMD_CLIENT_ID],
    );
    assert.deepEqual(
      stored.rows[0]?.redirectUris,
      [...T09_CLAUDE_CIMD_METADATA.redirect_uris],
      'ephemeral authorize ports must not pollute the persisted CIMD client',
    );
  });

  test('POST authorize reads the CIMD localhost redirect_uri from its form body', async () => {
    const grant = await t09CimdCodeGrant(app, sessionCookie, {
      clientId: T09_CLAUDE_CIMD_CLIENT_ID,
      redirectUri: T09_CLAUDE_POST_EPHEMERAL_REDIRECT,
      authorizeMethod: 'POST',
    });
    const token = await t09ExchangeCode(app, {
      code: grant.code,
      verifier: grant.verifier,
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
      clientId: T09_CLAUDE_CIMD_CLIENT_ID,
      redirectUri: T09_CLAUDE_POST_EPHEMERAL_REDIRECT,
    });
    assert.equal(token.statusCode, 200, token.body);
    const minted = token.json() as { access_token?: string };
    assert.ok(typeof minted.access_token === 'string' && minted.access_token.length > 0);
    assert.equal(t09InspectAccessToken(minted.access_token).claims.client_id, T09_CLAUDE_CIMD_CLIENT_ID);
  });

  test('opaque token minted without resource is invalid_token on MCP', async () => {
    const grant = await t09CimdCodeGrant(app, sessionCookie, { resource: null });
    const token = await t09ExchangeCode(app, { code: grant.code, verifier: grant.verifier });
    assert.ok(token.statusCode === 200, token.body);
    const minted = token.json() as { access_token?: string };
    assert.ok(typeof minted.access_token === 'string');
    assert.notEqual(minted.access_token.split('.').length, 3, 'no-resource grant must not be a JWT');
    const response = await t09PostMcp(origin, 'tools/list', 10, {
      authorization: `Bearer ${minted.access_token}`,
    });
    assert.equal(t09InvalidToken(response, await response.json() as { error?: { code?: string } }), true);
  });

  test('JWT with wrong aud signed by the live issuer key is invalid_token', async () => {
    const wrong = await t09SignWrongAudJwt({
      pool: isolated.runtime.pool,
      secret: baSecret,
      subject: subjectId,
      clientId: T09_CIMD_CLIENT_ID,
    });
    assert.equal(wrong.split('.').length, 3);
    await oauthVerifier.verify({
      authorization: `Bearer ${wrong}`,
    }).then(
      () => assert.fail('wrong aud must not verify'),
      (error: unknown) => {
        assert.ok(error instanceof McpOauthVerificationError, String(error));
        assert.equal(error.reason, 'wrong_audience');
      },
    );
    const response = await t09PostMcp(origin, 'tools/list', 11, { authorization: `Bearer ${wrong}` });
    assert.equal(t09InvalidToken(response, await response.json() as { error?: { code?: string } }), true);
  });

  test('epoch bump after mint rejects the JWT as revoked', async () => {
    const grant = await t09CimdCodeGrant(app, sessionCookie);
    const token = await t09ExchangeCode(app, {
      code: grant.code,
      verifier: grant.verifier,
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    });
    const minted = token.json() as { access_token?: string };
    assert.ok(typeof minted.access_token === 'string');
    const issuedAt = t09InspectAccessToken(minted.access_token).claims.iat;
    assert.equal(typeof issuedAt, 'number');
    const ok = await oauthVerifier.verify({ authorization: `Bearer ${minted.access_token}` });
    assert.equal(ok.accountSubjectId, subjectId);
    await t09WaitNextUnixSecond(issuedAt as number);
    await revocationStore.bumpSecurityEpoch(`known.mcp.oauth.v1:${Date.now()}`);
    await oauthVerifier.verify({ authorization: `Bearer ${minted.access_token}` }).then(
      () => assert.fail('bumped epoch must revoke'),
      (error: unknown) => assert.equal(t09IsRevokedError(error), true),
    );
    const response = await t09PostMcp(origin, 'tools/list', 12, {
      authorization: `Bearer ${minted.access_token}`,
    });
    assert.equal(t09InvalidToken(response, await response.json() as { error?: { code?: string } }), true);
  });

  test('CIMD client_id pointing at a private address is rejected at authorize', async () => {
    const authorize = await t09Authorize(app, {
      clientId: T09_CIMD_PRIVATE_CLIENT_ID,
      cookie: sessionCookie,
      challenge: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    });
    const location = authorize.location ?? '';
    const hasCode = location.includes('code=');
    const privateReject = authorize.statusCode >= 400
      || /invalid_client|invalid_request|access_denied/u.test(`${location} ${authorize.body}`);
    assert.equal(hasCode, false, `SSRF CIMD must not issue a code: ${authorize.body}`);
    assert.equal(privateReject, true, `expected authorize-time CIMD reject, got ${authorize.statusCode} ${authorize.body}`);
  });

  test('subscriptions/listen closes after epoch bump while the stream is open', async () => {
    const grant = await t09CimdCodeGrant(app, sessionCookie);
    const token = await t09ExchangeCode(app, {
      code: grant.code,
      verifier: grant.verifier,
      resource: BUILTIN_ISSUER_TEST_AUDIENCE,
    });
    const minted = token.json() as { access_token?: string };
    assert.ok(typeof minted.access_token === 'string');
    const issuedAt = t09InspectAccessToken(minted.access_token).claims.iat as number;
    const listen = await t09PostMcp(origin, 'subscriptions/listen', 20, {
      authorization: `Bearer ${minted.access_token}`,
      accept: 'text/event-stream;q=1, application/json;q=0.5',
      params: { notifications: { resourceSubscriptions: [resourceUri], resourcesListChanged: true } },
    });
    assert.equal(listen.status, 200);
    const reader = t09CreateSseReader(listen);
    try {
      assert.equal((await reader.next())?.method, 'notifications/subscriptions/acknowledged');
      await t09WaitNextUnixSecond(issuedAt);
      await revocationStore.bumpSecurityEpoch(`known.mcp.oauth.v1:${Date.now()}`);
      await changeSource.publish({ type: 'resource-list-changed' });
      const closed = await reader.next(4_000);
      assert.equal(closed, null, 'listen must close after revoke-while-alive, not stay open');
    } finally {
      reader.close();
    }
  });

  test('AUTH-04: real password endpoint revokes native JWT epoch and preserves fresh issuance', async () => {
    async function mint(cookie: string) {
      const grant = await t09CimdCodeGrant(app,cookie);
      const response = await t09ExchangeCode(app,{code:grant.code,verifier:grant.verifier,resource:BUILTIN_ISSUER_TEST_AUDIENCE});
      assert.equal(response.statusCode,200,response.body);
      return response.json().access_token as string;
    }
    const old = await mint(sessionCookie);
    const prior = t09InspectAccessToken(old).claims.known_account_epoch;
    await oauthVerifier.verify({authorization:`Bearer ${old}`});
    const changed = await app.inject({
      method:'POST',url:`${BASE_PATH}/change-password`,
      headers:{'content-type':'application/json',origin:T09_TRUSTED_ORIGIN,cookie:`__Host-known_session=${sessionCookie}`},
      payload:{currentPassword:T09_PASSWORD,newPassword:'epoch-proof-password-456'},
    });
    assert.equal(changed.statusCode,200,changed.body);
    const successor=t09SessionCookieOf(changed);
    assert.ok(successor);
    await assert.rejects(oauthVerifier.verify({authorization:`Bearer ${old}`}), (error: unknown) => error instanceof McpOauthVerificationError && error.reason==='revoked');
    const fresh = await mint(successor);
    assert.equal(BigInt(t09InspectAccessToken(fresh).claims.known_account_epoch as string),BigInt(prior as string)+1n);
    await oauthVerifier.verify({authorization:`Bearer ${fresh}`});
  });

});

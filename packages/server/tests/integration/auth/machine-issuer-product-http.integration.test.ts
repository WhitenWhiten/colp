import { insertTestParentCredential } from '../../support/account-credential-db-fixture.js';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import { loadConfig } from '../../support/test-config.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import { createPostgresAccessPolicyFactsPort } from '../../../src/infrastructure/access-policy/index.js';
import { createPostgresAccountCredentialUnitOfWork } from '../../../src/infrastructure/auth/account-credentials-postgres.js';
import {
  createAccountCredentialCursorCodec,
  loadCredentialAuthority,
  resolveMachineMcpBinding,
  supportedAccountKeyScopes,
} from '../../../src/modules/auth/index.js';
import {
  createMcpOauthVerifier,
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpReadToolAdapter,
  createPhase4bMcpResourceIdentity,
  mcpOauthAcceptedAudiences,
  mcpReadFeatureConfigAssertOptions,
} from '../../../src/modules/mcp/index.js';
import { createPhase4bMcpApplicationFacadeFromColpAdapters } from '../../../src/transport/mcp/mcp-strict-application-adapter.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionBookmarkCountReadPort,
  createPostgresCollectionsUnitOfWork,
  createPostgresOwnedCollectionsReadPort,
  createPostgresMcpOwnedCollectionReadPort,
} from '../../../src/infrastructure/collections/index.js';
import { createProductOwnedCollectionsCursorSigner } from '../../../src/modules/collections/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { t09StubMcpProjections } from '../../support/mcp-oauth-builtin-issuer-helpers.js';
import { withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const HMAC_KEY = Buffer.alloc(32, 13).toString('base64url');
const FUTURE = '2026-12-01T00:00:00.000Z';
const ORIGIN = 'https://app.example.test';
const MCP_AUDIENCE = `${ORIGIN}/collections/-/mcp`;
const ISSUER = `${ORIGIN}/api/v1/auth`;
const GRANT = 'urn:known:params:oauth:grant-type:account-key';
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHILD_SHAPE = /^kn_c_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/;

function es256Jwk(kid: string) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { json: JSON.stringify({ ...jwk, kid, kty: 'EC', crv: 'P-256' }), jwk: { ...jwk, kid, kty: 'EC', crv: 'P-256' } };
}

describeWithPostgres('machine issuer product HTTP', () => {
  let isolated: IsolatedPostgresRuntime;
  let config: ReturnType<typeof loadConfig>;
  let identity: ReturnType<typeof createPostgresIdentityUnitOfWork>;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let cursors: ReturnType<typeof createAccountCredentialCursorCodec>;
  let ownedCursors: ReturnType<typeof createProductOwnedCollectionsCursorSigner>;
  const signing = es256Jwk('ac02-es256');
  const previous = es256Jwk('ac02-previous');

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ac02_machine_issuer', {
      maxConnections: 12,
      applicationName: 'known-ac02-machine-issuer',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    config = loadConfig({
      ...process.env,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      PUBLICATION_ORIGIN: ORIGIN,
      PUBLICATION_SERVER_UUID: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: HMAC_KEY,
      AUTOMATION_ES256_PRIVATE_JWK: signing.json,
      AUTOMATION_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({
        keys: [{ kid: previous.jwk.kid, kty: 'EC', crv: 'P-256', x: previous.jwk.x, y: previous.jwk.y }],
      }),
      KNOWN_FEATURE_MCP_READ: 'true',
      MCP_SERVER_UUID: '019b3c67-a03c-7f02-9c7e-1ee8d50a77de',
      MCP_ALLOWED_ORIGINS: ORIGIN,
      MCP_OAUTH_ISSUER: ISSUER,
      MCP_OAUTH_AUDIENCE: MCP_AUDIENCE,
      MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
        `${ORIGIN}/.well-known/oauth-authorization-server/api/v1/auth`,
      MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
    });
    identity = createPostgresIdentityUnitOfWork(isolated.runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db });
    cursors = createAccountCredentialCursorCodec(HMAC_KEY);
    ownedCursors = createProductOwnedCollectionsCursorSigner({
      current: { id: 'ac02-owned-v1', key: 'ac02-owned-collections-cursor-secret-32b' },
    });
  }, 120_000);

  afterAll(async () => {
    cursors?.destroy();
    ownedCursors?.destroy();
    await isolated?.close();
  });

  function credentialUow() {
    return createPostgresAccountCredentialUnitOfWork(isolated.runtime.db, undefined, undefined,
      { secretHmacKey: HMAC_KEY });
  }

  async function compose(featureOn = true) {
    const cfg = featureOn ? config : loadConfig({
      ...process.env,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'false',
    });
    const jwksHolder: { keys?: JSONWebKeySet } = {};
    const projections = t09StubMcpProjections();
    const tools = cfg.mcp
      ? createPhase4bMcpReadToolAdapter({
          collectionProjection: projections.collection,
          snapshotProjection: projections.snapshot,
          nodeProjection: projections.node,
          serverUuid: cfg.mcp.serverUuid,
          ownedRead: createPostgresMcpOwnedCollectionReadPort({
            db: isolated.runtime.db,
            accessPolicy: createPostgresAccessPolicyFactsPort(isolated.runtime.db),
          }),
        })
      : null;
    const changeSource = createPhase4bMcpChangeSignalSource();
    const uow = credentialUow();
    const kids = new Set([signing.jwk.kid]);
    const oauthVerifier = featureOn && cfg.mcp
      ? createMcpOauthVerifier({
          issuer: ISSUER,
          audience: mcpOauthAcceptedAudiences(MCP_AUDIENCE),
          allowedScopes: supportedAccountKeyScopes(cfg.mcp.oauth.scopes),
          jwks: {
            async getKeySet() {
              if (!jwksHolder.keys) throw new Error('JWKS must be published before verify');
              return jwksHolder.keys;
            },
          },
          isRevoked: async () => false,
          securityEpoch: async () => 'known.mcp.oauth.v1',
          resolveAccountBySubject: async (sub) => {
            const account = await identity.execute((ports) => ports.accounts.findBySubjectId(sub));
            if (!account || account.status !== 'active') return null;
            return { id: account.id, subjectId: account.subjectId, status: account.status };
          },
          machine: {
            kids,
            bind: (input) => resolveMachineMcpBinding({
              ...input,
              load: (credentialId) => uow.execute((ports) => loadCredentialAuthority(ports, credentialId)),
            }),
          },
        })
      : undefined;
    const ownedCollectionsQuery = {
      reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db),
      cursors: ownedCursors,
      clock: { now: async () => new Date() },
    };
    const app = buildApiApp({
      config: cfg,
      identityUnitOfWork: identity,
      browserSessionAuthority: factory.authority,
      accountCredentialUnitOfWork: uow,
      accountCredentialCursors: featureOn ? cursors : null,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      ownedCollectionsQuery,
      bookmarkCounts: createPostgresCollectionBookmarkCountReadPort(isolated.runtime.db),
      ...(cfg.mcp && oauthVerifier && tools ? {
        mcpReadTransport: {
          changeSignalSource: changeSource,
          readToolAdapter: tools.adapter,
          readToolParamDeclarations: tools.paramDeclarations,
          oauthVerifier,
          applicationFacade: createPhase4bMcpApplicationFacadeFromColpAdapters({
            resourceIdentity: createPhase4bMcpResourceIdentity(
              cfg.mcp,
              mcpReadFeatureConfigAssertOptions({ nodeEnv: 'test', oauthIssuerEnabled: false }),
            ),
            collectionProjection: projections.collection,
            snapshotProjection: projections.snapshot,
            nodeProjection: projections.node,
            readToolAdapter: tools.adapter,
            ownedCollectionsQuery,
          }),
        },
        mcpReadResourceProjection: projections.collection,
        mcpSnapshotResourceProjection: projections.snapshot,
        mcpNodeResourceProjection: projections.node,
      } : {}),
    });
    if (featureOn) {
      const jwks = await app.inject({ method: 'GET', url: '/api/v1/auth/jwks' });
      assert.equal(jwks.statusCode, 200, jwks.body);
      jwksHolder.keys = jwks.json() as JSONWebKeySet;
    }
    return { app, jwksHolder, changeSource };
  }

  async function session() {
    return issueTestSession({
      factory,
      subject: `ac02-${randomUUID()}`,
      handle: `h${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
  }

  async function issueChild(app: ReturnType<typeof buildApiApp>) {
    const actor = await session();
    const parent = await insertTestParentCredential(isolated.runtime.db, actor, HMAC_KEY, FUTURE);
    const child = await app.inject({
      method: 'POST', url: '/api/v1/auth/credential-children',
      headers: {
        authorization: `Bearer ${parent.secret}`,
        'content-type': 'application/json', 'known-command-id': randomUUID(),
      },
      payload: { label: 'child', expiresAt: FUTURE, account: { mode: 'new' } },
    });
    assert.equal(child.statusCode, 201, child.body);
    return {
      secret: child.json().secret as string,
      parentSecret: parent.secret,
      actor,
      credential: child.json().credential as { id: string; accountId: string; subjectId: string },
    };
  }

  async function exchange(app: ReturnType<typeof buildApiApp>, secret: string, audience: string, scope: string) {
    return app.inject({
      method: 'POST', url: '/api/v1/auth/key-token',
      headers: { 'content-type': 'application/json' },
      payload: { grant_type: GRANT, credential: secret, audience, scope },
    });
  }

  test('child key exchanges a product token, writes and reads a collection, then MCP reads it back', async () => {
    const { app, jwksHolder, changeSource } = await compose();
    try {
      const child = await issueChild(app);
      // AC-F003: the stored secret_hash must be the keyed digest, not the
      // bare SHA-256 of the raw secret (the deployment key is wired into the
      // UoW options in this compose).
      const stored = await isolated.runtime.pool.query<{ secret_hash: string }>(
        `select secret_hash from account_credentials where id = $1`, [child.credential.id]);
      assert.ok(stored.rows[0]);
      const bare = createHash('sha256').update(child.secret, 'utf8').digest('hex');
      assert.notEqual(stored.rows[0]!.secret_hash, bare, 'stored hash must be keyed HMAC');
      const tokenRes = await exchange(app, child.secret, 'product', 'product:write product:read');
      assert.equal(tokenRes.statusCode, 200, tokenRes.body);
      const body = tokenRes.json() as {
        access_token: string; token_type: string; expires_in: number; scope: string; audience: string;
      };
      assert.deepEqual(Object.keys(body).sort(), ['access_token', 'audience', 'expires_in', 'scope', 'token_type']);
      assert.equal(body.token_type, 'Bearer');
      assert.equal(body.expires_in, 300);
      assert.equal(body.audience, 'product');
      assert.equal(body.scope, 'product:read product:write');
      assert.equal(tokenRes.headers['cache-control'], 'no-store');
      const header = decodeProtectedHeader(body.access_token);
      assert.equal(header.alg, 'ES256');
      assert.equal(header.kid, 'ac02-es256');
      const verified = await jwtVerify(body.access_token, createLocalJWKSet(jwksHolder.keys!), {
        issuer: ISSUER, audience: ORIGIN, algorithms: ['ES256'],
      });
      assert.equal(verified.payload.iss, ISSUER);
      assert.equal(verified.payload.sub, child.credential.subjectId);
      assert.equal(verified.payload.aud, ORIGIN);
      assert.notEqual(verified.payload.aud, 'product');
      assert.equal(verified.payload.known_credential_id, child.credential.id);
      assert.equal(verified.payload.scope, 'product:read product:write');
      assert.match(String(verified.payload.client_id), UUID_V4);
      assert.match(String(verified.payload.jti), UUID_V4);
      assert.match(String(verified.payload.known_account_epoch), /^(?:0|[1-9][0-9]{0,18})$/u);
      assert.match(String(verified.payload.known_credential_epoch), /^(?:0|[1-9][0-9]{0,18})$/u);
      assert.match(String(verified.payload.known_ancestor_epoch), /^[0-9a-f]{64}$/u);
      assert.equal(typeof verified.payload.iat, 'number');
      assert.equal(typeof verified.payload.nbf, 'number');
      assert.equal(verified.payload.exp, Number(verified.payload.iat) + 300);
      assert.equal('isBot' in verified.payload, false);
      assert.equal('email_verified' in verified.payload, false);
      assert.equal('refresh_token' in body, false);
      const replay = await exchange(app, child.secret, 'product', 'product:read product:write');
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(decodeJwt(replay.json().access_token as string).client_id, verified.payload.client_id);
      assert.notEqual(decodeJwt(replay.json().access_token as string).jti, verified.payload.jti);

      const identityRes = await app.inject({
        method: 'GET', url: '/api/v1/me/credential-identity',
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      assert.equal(identityRes.statusCode, 200, identityRes.body);
      assert.equal(identityRes.headers['cache-control'], 'private, no-store');
      const identity = identityRes.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(identity).sort(), ['accountId', 'credentialId', 'expiresAt', 'scopes', 'subjectId']);
      assert.equal(identity.accountId, child.credential.accountId);
      assert.equal(identity.subjectId, child.credential.subjectId);
      assert.equal(identity.credentialId, child.credential.id);
      assert.deepEqual(identity.scopes, ['product:read', 'product:write']);
      assert.match(String(identity.expiresAt), TIMESTAMP);
      const cookieIdentity = await app.inject({
        method: 'GET', url: '/api/v1/me/credential-identity',
        headers: { cookie: (await session()).cookie },
      });
      assert.equal(cookieIdentity.statusCode, 404);
      const mixedIdentity = await app.inject({
        method: 'GET', url: '/api/v1/me/credential-identity',
        headers: {
          cookie: (await session()).cookie,
          authorization: `Bearer ${body.access_token}`,
        },
      });
      assert.equal(mixedIdentity.statusCode, 404);
      assert.equal(mixedIdentity.json().error.code, 'resource_not_found');
      const missingBearer = await app.inject({ method: 'GET', url: '/api/v1/me/credential-identity' });
      assert.equal(missingBearer.statusCode, 404);

      const created = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${body.access_token}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'AC-02 machine collection', summary: 'from child token' },
      });
      assert.equal(created.statusCode, 201, created.body);
      const collectionId = created.json().collection.id as string;
      const listed = await app.inject({
        method: 'GET', url: '/api/v1/collections',
        headers: { authorization: `Bearer ${body.access_token}` },
      });
      assert.equal(listed.statusCode, 200, listed.body);
      const listedIds = (listed.json().items as Array<{ collection?: { id?: string } }>)
        .map((item) => item.collection?.id);
      assert.equal(listedIds.includes(collectionId), true, listed.body);

      const mcpToken = await exchange(app, child.secret, 'mcp_strict', 'mcp:read:own');
      assert.equal(mcpToken.statusCode, 200, mcpToken.body);
      const mcpAccess = mcpToken.json().access_token as string;
      const mcpVerified = await jwtVerify(mcpAccess, createLocalJWKSet(jwksHolder.keys!), {
        issuer: ISSUER, audience: MCP_AUDIENCE, algorithms: ['ES256'],
      });
      assert.equal(mcpVerified.payload.aud, MCP_AUDIENCE);
      const mcpRead = await app.inject({
        method: 'POST', url: '/collections/-/mcp',
        headers: withMcpTestHost({
          authorization: `Bearer ${mcpAccess}`,
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'collections.get',
          'mcp-param-x-collection-id': collectionId,
          accept: 'application/json;q=1, text/event-stream;q=0.5',
        }, ORIGIN),
        payload: {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': { tools: { call: true } },
              'io.modelcontextprotocol/clientInfo': { name: 'ac02', version: '1.0.0' },
            },
            name: 'collections.get', arguments: { collectionId },
          },
        },
      });
      assert.equal(mcpRead.statusCode, 200, mcpRead.body);
      const mcpBody = mcpRead.json() as {
        result?: { structuredContent?: { collection?: { id?: string } } };
        error?: unknown;
      };
      assert.equal(mcpBody.result?.structuredContent?.collection?.id, collectionId, JSON.stringify(mcpBody));
    } finally {
      await app.close();
    }
  });

  test('real verifier rejects wrong aud, iss, sub, and signature', async () => {
    const { app, jwksHolder, changeSource } = await compose();
    try {
      const child = await issueChild(app);
      const ok = await exchange(app, child.secret, 'product', 'product:read');
      assert.equal(ok.statusCode, 200, ok.body);
      const now = Math.floor(Date.now() / 1000);
      const key = await importJWK(signing.jwk as never, 'ES256');
      const other = es256Jwk('other-kid');
      const otherKey = await importJWK(other.jwk as never, 'ES256');
      const claims = {
        scope: 'product:read',
        known_credential_id: child.credential.id,
        known_account_epoch: '0',
        known_credential_epoch: '1',
        known_ancestor_epoch: 'a'.repeat(64),
        client_id: randomUUID(),
      };
      async function mint(overrides: Record<string, unknown>, signKey = key, kid = 'ac02-es256') {
        return new SignJWT({ ...claims, ...overrides })
          .setProtectedHeader({ alg: 'ES256', kid })
          .setIssuer(typeof overrides.iss === 'string' ? overrides.iss : ISSUER)
          .setSubject(typeof overrides.sub === 'string' ? overrides.sub : child.credential.subjectId)
          .setAudience(typeof overrides.aud === 'string' ? overrides.aud : ORIGIN)
          .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).setJti(randomUUID())
          .sign(signKey);
      }
      const wrongAud = await mint({ aud: 'https://evil.example.test' });
      const wrongIss = await mint({ iss: 'https://evil.example.test/api/v1/auth' });
      const wrongSub = await mint({ sub: 'not-the-subject' });
      const wrongSig = await mint({}, otherKey, 'other-kid');
      for (const token of [wrongAud, wrongIss, wrongSub, wrongSig]) {
        const response = await app.inject({
          method: 'GET', url: '/api/v1/me/credential-identity',
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.statusCode, 404, response.body);
      }
      const mcpWrongAud = await mint({ aud: ORIGIN, scope: 'mcp:read:own' });
      const mcp = await app.inject({
        method: 'POST', url: '/collections/-/mcp',
        headers: withMcpTestHost({
          authorization: `Bearer ${mcpWrongAud}`,
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/list',
          accept: 'application/json;q=1, text/event-stream;q=0.5',
        }, ORIGIN),
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'ac02', version: '1.0.0' },
        } } },
      });
      assert.equal(mcp.statusCode, 401, mcp.body);
      assert.ok(jwksHolder.keys?.keys.some((key) => key.kid === 'ac02-es256'));
      assert.ok(jwksHolder.keys?.keys.some((key) => key.kid === 'ac02-previous'));
    } finally {
      await app.close();
    }
  });

  test('cookie is rejected on exchange; feature-off 404s while cookie collection still works', async () => {
    const on = await compose();
    try {
      const child = await issueChild(on.app);
      const withCookie = await on.app.inject({
        method: 'POST', url: '/api/v1/auth/key-token',
        headers: { 'content-type': 'application/json', cookie: 'x=1' },
        payload: { grant_type: GRANT, credential: child.secret, audience: 'product', scope: 'product:read' },
      });
      assert.equal(withCookie.statusCode, 404);
      assert.equal(withCookie.json().code, 'resource_not_found');
      const withAuthorization = await on.app.inject({
        method: 'POST', url: '/api/v1/auth/key-token',
        headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
        payload: { grant_type: GRANT, credential: child.secret, audience: 'product', scope: 'product:read' },
      });
      assert.equal(withAuthorization.statusCode, 404);
      assert.equal(withAuthorization.json().code, 'resource_not_found');
      const mixedExchange = await on.app.inject({
        method: 'POST', url: '/api/v1/auth/key-token',
        headers: { 'content-type': 'application/json', cookie: 'x=1', authorization: 'Bearer x' },
        payload: { grant_type: GRANT, credential: child.secret, audience: 'product', scope: 'product:read' },
      });
      assert.equal(mixedExchange.statusCode, 404);
      assert.equal(mixedExchange.json().code, 'resource_not_found');
    } finally {
      await on.app.close();
    }

    const off = await compose(false);
    try {
      const actor = await session();
      const token = await off.app.inject({
        method: 'POST', url: '/api/v1/auth/key-token',
        headers: { 'content-type': 'application/json' },
        payload: { grant_type: GRANT, credential: 'kn_c_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', audience: 'product', scope: 'product:read' },
      });
      assert.equal(token.statusCode, 404);
      const ident = await off.app.inject({ method: 'GET', url: '/api/v1/me/credential-identity' });
      assert.equal(ident.statusCode, 404);
      const created = await off.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          cookie: actor.cookie, origin: ORIGIN, 'x-csrf-token': actor.csrfToken,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'browser still works', summary: null },
      });
      assert.equal(created.statusCode, 201, created.body);
    } finally {
      await off.app.close();
    }
  });

  test('exchange rejects contract-invalid bodies, parent/revoked/expired keys, mixed Product carriers, and MCP tokens', async () => {
    const { app } = await compose();
    try {
      const child = await issueChild(app);
      const valid = {
        grant_type: GRANT, credential: child.secret, audience: 'product', scope: 'product:read',
      };
      async function postToken(payload: unknown, headers: Record<string, string> = {}) {
        return app.inject({
          method: 'POST', url: '/api/v1/auth/key-token',
          headers: { 'content-type': 'application/json', ...headers },
          payload,
        });
      }
      function oauthError(response: Awaited<ReturnType<typeof postToken>>, _status: number, _error: string) {
        assert.equal(response.statusCode, 404, response.body);
        assert.equal(response.json().code, 'resource_not_found');
      }

      oauthError(await postToken({ ...valid, extra: true }), 400, 'invalid_request');
      oauthError(await postToken({ grant_type: GRANT, credential: child.secret, audience: 'product' }), 400, 'invalid_request');
      oauthError(await postToken({ ...valid, scope: null }), 400, 'invalid_request');
      oauthError(await postToken({ ...valid, audience: 'mcp' }), 400, 'invalid_scope');
      oauthError(await postToken({ ...valid, credential: child.parentSecret }), 401, 'invalid_grant');
      oauthError(await postToken({
        ...valid,
        credential: 'kn_c_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      }), 401, 'invalid_grant');
      oauthError(await app.inject({ method: 'GET', url: '/api/v1/auth/key-token' }), 405, 'invalid_request');
      oauthError(await app.inject({
        method: 'POST', url: '/api/v1/auth/key-token?foo=1',
        headers: { 'content-type': 'application/json' },
        payload: valid,
      }), 400, 'invalid_request');

      const product = await postToken({ ...valid, scope: 'product:read product:write' });
      assert.equal(product.statusCode, 200, product.body);
      const access = product.json().access_token as string;
      const mixedProduct = await app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${access}`,
          cookie: child.actor.cookie,
          origin: ORIGIN,
          'x-csrf-token': child.actor.csrfToken,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'mixed', summary: null },
      });
      assert.equal(mixedProduct.statusCode, 400, mixedProduct.body);

      const mcpToken = await postToken({
        grant_type: GRANT, credential: child.secret, audience: 'mcp_strict', scope: 'mcp:read:own',
      });
      assert.equal(mcpToken.statusCode, 200, mcpToken.body);
      const mcpOnProduct = await app.inject({
        method: 'GET', url: '/api/v1/me/credential-identity',
        headers: { authorization: `Bearer ${mcpToken.json().access_token}` },
      });
      assert.equal(mcpOnProduct.statusCode, 404, mcpOnProduct.body);
      const extraQuery = await app.inject({
        method: 'GET', url: '/api/v1/me/credential-identity?foo=1',
        headers: { authorization: `Bearer ${access}` },
      });
      assert.equal(extraQuery.statusCode, 400, extraQuery.body);

      const childGet = await app.inject({
        method: 'GET', url: `/api/v1/auth/credential-children/${child.credential.id}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      const revoked = await app.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${child.credential.id}/revoke`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
          'if-match': String(childGet.headers.etag),
        },
        payload: { reason: 'ac02-revoke' },
      });
      assert.equal(revoked.statusCode, 200, revoked.body);
      oauthError(await postToken(valid), 401, 'invalid_grant');
      const afterRevoke = await app.inject({
        method: 'GET', url: '/api/v1/me/credential-identity',
        headers: { authorization: `Bearer ${access}` },
      });
      assert.equal(afterRevoke.statusCode, 404, afterRevoke.body);

      const live = await issueChild(app);
      await isolated.runtime.pool.query(
        'update account_credentials set expires_at = now() - interval \'1 day\' where id = $1',
        [live.credential.id],
      );
      oauthError(await postToken({
        grant_type: GRANT, credential: live.secret, audience: 'product', scope: 'product:read',
      }), 401, 'invalid_grant');
      assert.match(live.secret, CHILD_SHAPE);
    } finally {
      await app.close();
    }
  });

  test('AC-F011 a format-invalid credential is refused without claiming a credential rate bucket', async () => {
    const { app } = await compose();
    try {
      // The route-level format gate rejects before any credential-keyed
      // limiter admission: garbage strings get invalid_request, not
      // invalid_grant and never count toward a per-credential window.
      const malformed = await exchange(app, 'not-a-credential-value', 'product', 'product:read');
      assert.equal(malformed.statusCode, 404, malformed.body);
      assert.equal(malformed.json().code, 'resource_not_found', malformed.body);
      // Negative-verifiable flood: the default credential limiter allows 30
      // calls per bucket (60s window). Pre-fix, every malformed string still
      // claimed a bucket, so the 31st identical call returned 429; with the
      // gate, none of them ever touch a credential bucket and every call
      // stays a 400 invalid_request.
      for (let index = 0; index < 34; index += 1) {
        const res = await exchange(app, 'not-a-credential-value', 'product', 'product:read');
        assert.equal(res.statusCode, 404, `flood ${index}: ${res.body}`);
        assert.equal(res.json().code, 'resource_not_found', res.body);
      }
    } finally {
      await app.close();
    }
  });
});

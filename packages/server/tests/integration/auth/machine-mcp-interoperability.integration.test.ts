import { createLocalIssuerJwks } from '../../../src/infrastructure/auth/local-issuer-jwks.js';
import { publicJwkFromPrivate, type AccountKeyEs256PrivateJwk } from '../../../src/modules/auth/index.js';
import { insertTestParentCredential } from '../../support/account-credential-db-fixture.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { JSONWebKeySet } from 'jose';
import { loadConfig } from '../../support/test-config.js';
import { composeApiMcpSurface } from '../../../src/bootstrap/api-mcp-surface-composition.js';
import { createApiPostgresPorts } from '../../../src/bootstrap/api-postgres-ports.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCredentialUnitOfWork } from '../../../src/infrastructure/auth/account-credentials-postgres.js';
import {
  createAccountCredentialCursorCodec,
} from '../../../src/modules/auth/index.js';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
  PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME,
  PHASE4B_MCP_READ_TOOL_NAMES,
} from '../../../src/modules/mcp/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createLogger, InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  mcpCompatAcceptHeaders,
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatToolsCallBody,
  mcpCompatToolsListBody,
  asMcpCompatJsonRpc,
  parseMcpCompatHttpPayload,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  applyBetterAuth17LibrarySchemaExpand,
} from '../../support/better-auth-postgres.js';
import { createAuthTestMailbox } from '../../support/auth-test-mailbox.js';
import {
  buildBetterAuthOptions,
  createBetterAuthRuntime,
} from '../../../src/infrastructure/auth/better-auth-runtime.js';
import { createPostgresBusinessAccountUnitOfWork } from '../../../src/infrastructure/auth/business-account-unit-of-work.js';
import { createAuthEmailAdapter } from '../../../src/infrastructure/email/auth-email-adapter.js';
import { buildBetterAuthConfig } from '../../../src/modules/auth/better-auth-config.js';
import { createMemoryAuthRateLimiter } from '../../../src/transport/http-security.js';
import {
  T09_PASSWORD,
  T09_TRUSTED_ORIGIN,
  t09CimdCodeGrant,
  t09ExchangeCode,
  t09IssuerMcpEnv,
  t09SessionCookieOf,
  t09TestFetchClientMetadataResource,
  t09UniqueEmail,
} from '../../support/mcp-oauth-builtin-issuer-helpers.js';
import {
  BUILTIN_ISSUER_TEST_AUDIENCE,
  createJwksProviderFromKeySet,
} from '../../support/builtin-issuer-test-helpers.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import {
  assertCapabilityMatrixCoversManifests,
  buildAccountBearerCapabilityMatrix,
} from './account-bearer-capability-matrix.js';

const HMAC_KEY = Buffer.alloc(32, 13).toString('base64url');
const FUTURE = '2026-12-01T00:00:00.000Z';
const ORIGIN = 'https://app.example.test';
const MCP_STRICT = `${ORIGIN}/collections/-/mcp`;
const ISSUER = `${ORIGIN}/api/v1/auth`;
const GRANT = 'urn:known:params:oauth:grant-type:account-key';
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const MCP_SCOPES = [
  'mcp:read:public',
  'mcp:read:own',
  'nodes:write',
  'access:write',
  'changes:commit',
  'changes:cancel',
].join(',');

function es256Jwk(kid: string) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { json: JSON.stringify({ ...jwk, kid, kty: 'EC', crv: 'P-256' }), jwk: { ...jwk, kid, kty: 'EC', crv: 'P-256' } };
}

function destroyPostgresCursorKeys(ports: ReturnType<typeof createApiPostgresPorts>): void {
  ports.ownedCollectionsCursorSigner.destroy();
  ports.sharedCollectionsCursorSigner.destroy();
  ports.collaborationMembersCursorSigner.destroy();
  ports.myCollaborationInvitesCursorSigner.destroy();
  ports.linkHealthCursorSigner.destroy();
  ports.classifyInboxCursorSigner.destroy();
  ports.collectionVersionCursorSigner.destroy();
  ports.followCursorKeys?.destroy();
  ports.followedCollectionsCursorKeys?.destroy();
  ports.feedCursorKeys?.destroy();
  ports.publicActivityCursorKeys?.destroy();
  ports.notificationCursorKeys?.destroy();
  ports.publicationCursorKeys.destroy();
}

describeWithPostgres('machine MCP interoperability', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let cursors: ReturnType<typeof createAccountCredentialCursorCodec>;
  const signing = es256Jwk('ac04-es256');

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ac04_machine_mcp', {
      maxConnections: 16,
      applicationName: 'known-ac04-machine-mcp',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db, baseURL: ORIGIN });
    cursors = createAccountCredentialCursorCodec(HMAC_KEY);
  }, 120_000);

  afterAll(async () => {
    cursors?.destroy();
    await isolated?.close();
  });

  function machineEnv(): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: ORIGIN,
      ALLOWED_ORIGINS: ORIGIN,
      PUBLICATION_ORIGIN: ORIGIN,
      PUBLICATION_SERVER_UUID: SERVER_UUID,
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: HMAC_KEY,
      AUTOMATION_ES256_PRIVATE_JWK: signing.json,
      KNOWN_FEATURE_MCP_READ: 'true',
      KNOWN_FEATURE_MCP_WRITE: 'true',
      KNOWN_FEATURE_MCP_COMPAT: 'true',
      MCP_SERVER_UUID: SERVER_UUID,
      MCP_ALLOWED_ORIGINS: ORIGIN,
      MCP_OAUTH_ISSUER: ISSUER,
      MCP_OAUTH_AUDIENCE: MCP_STRICT,
      MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
        `${ORIGIN}/.well-known/oauth-authorization-server/api/v1/auth`,
      MCP_OAUTH_JWKS_URI: `${ISSUER}/jwks`,
      MCP_OAUTH_SCOPES: MCP_SCOPES,
    };
  }

  async function composeMachine() {
    const config = loadConfig(machineEnv());
    const metrics = new InMemoryMetrics();
    const metricsLogger = createLogger('silent');
    const ports = createApiPostgresPorts({
      database: isolated.runtime,
      config,
      metrics,
      metricsLogger,
    });
    const uow = createPostgresAccountCredentialUnitOfWork(isolated.runtime.db, undefined, undefined,
      { secretHmacKey: HMAC_KEY });
    const jwksHolder: { keys?: JSONWebKeySet } = {};
    const mcp = await composeApiMcpSurface({
      config,
      database: isolated.runtime,
      identityUnitOfWork: ports.identityUnitOfWork,
      metrics,
      publicationDirectoryReads: ports.publicationDirectoryReads,
      publicationMetadataReads: ports.publicationMetadataReads,
      publicationCursorKeys: ports.publicationCursorKeys,
      accessPolicyFacts: ports.accessPolicyFacts,
      publicationSnapshotQuery: ports.publicationSnapshotQuery,
      ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
      jwksProvider: createLocalIssuerJwks(isolated.runtime.db, [publicJwkFromPrivate(signing.jwk as AccountKeyEs256PrivateJwk)]),
    });
    const app = buildApiApp({
      config,
      identityUnitOfWork: ports.identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      accountCredentialUnitOfWork: uow,
      accountCredentialCursors: cursors,
      collectionsUnitOfWork: ports.collectionsUnitOfWork,
      productCollectionMutationUnitOfWork: ports.productCollectionMutationUnitOfWork,
      ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
      bookmarkCounts: ports.collectionBookmarkCountOrigin,
      mcpReadResourceProjection: mcp.mcpReadResourceProjection,
      mcpSnapshotResourceProjection: mcp.mcpSnapshotResourceProjection,
      mcpNodeResourceProjection: mcp.mcpNodeResourceProjection,
      mcpReadTransport: {
        changeSignalSource: mcp.mcpChangeSignalSource!,
        ...(mcp.mcpRateLimiter === undefined ? {} : { requestRateLimiter: mcp.mcpRateLimiter }),
        readToolAdapter: mcp.mcpReadToolAdapter!.adapter,
        readToolParamDeclarations: mcp.mcpReadToolAdapter!.paramDeclarations,
        applicationFacade: mcp.mcpApplicationFacade,
        ...(mcp.mcpWriteComposition === undefined ? {} : {
          writeToolAdapter: mcp.mcpWriteComposition.adapter,
          writeToolParamDeclarations: mcp.mcpWriteComposition.paramDeclarations,
        }),
        oauthVerifier: mcp.mcpReadOAuthDependencies.oauthVerifier,
        ...(mcp.mcpReadOAuthDependencies.dependencyHealth === undefined
          ? {}
          : { dependencyHealth: mcp.mcpReadOAuthDependencies.dependencyHealth }),
      },
    });
    const jwks = await app.inject({ method: 'GET', url: '/api/v1/auth/jwks' });
    assert.equal(jwks.statusCode, 200, jwks.body);
    jwksHolder.keys = jwks.json() as JSONWebKeySet;
    return { app, mcp, ports, jwksHolder };
  }

  async function closeMachine(input: Awaited<ReturnType<typeof composeMachine>>): Promise<void> {
    await input.app.close().catch(() => undefined);
    await input.mcp.mcpRateLimiter?.close().catch(() => undefined);
    await input.mcp.mcpChangeSignalSource?.close().catch(() => undefined);
    input.mcp.mcpCollectionResourceCursorKeys?.destroy();
    destroyPostgresCursorKeys(input.ports);
  }

  async function session() {
    return issueTestSession({
      factory,
      subject: `ac04-${randomUUID()}`,
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
      parentSecret: parent.secret,
      secret: child.json().secret as string,
      actor,
      credential: child.json().credential as { id: string; accountId: string; subjectId: string },
    };
  }

  async function exchange(
    app: ReturnType<typeof buildApiApp>,
    secret: string,
    audience: string,
    scope: string,
  ) {
    return app.inject({
      method: 'POST', url: '/api/v1/auth/key-token',
      headers: { 'content-type': 'application/json' },
      payload: { grant_type: GRANT, credential: secret, audience, scope },
    });
  }

  async function accessToken(
    app: ReturnType<typeof buildApiApp>,
    secret: string,
    audience: string,
    scope: string,
  ): Promise<string> {
    const response = await exchange(app, secret, audience, scope);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().access_token as string;
  }

  function strictPayload(
    method: string,
    id: number,
    params: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { tools: { call: true } },
          'io.modelcontextprotocol/clientInfo': { name: 'ac04', version: '1.0.0' },
        },
        ...params,
      },
    };
  }

  function postStrict(
    app: ReturnType<typeof buildApiApp>,
    token: string,
    method: string,
    id: number,
    params: Record<string, unknown> = {},
    extra: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/collections/-/mcp',
      headers: withMcpTestHost({
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        accept: 'application/json;q=1, text/event-stream;q=0.5',
        ...extra,
      }, ORIGIN),
      payload: strictPayload(method, id, params),
    });
  }

  function postCompat(
    app: ReturnType<typeof buildApiApp>,
    token: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: MCP_COMPAT_ENDPOINT_PATH,
      headers: withMcpTestHost({
        ...mcpCompatAcceptHeaders(MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION),
        authorization: `Bearer ${token}`,
        ...extra,
      }, ORIGIN),
      payload: body,
    });
  }

  function toolNames(body: unknown): string[] {
    const record = body as { result?: { tools?: Array<{ name?: string }> } };
    return (record.result?.tools ?? [])
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === 'string');
  }

  test('capability matrix records MCP strict/compat and COLP protocol carriers', () => {
    const matrix = buildAccountBearerCapabilityMatrix();
    assertCapabilityMatrixCoversManifests(matrix, assert);
    const ac04 = 'tests/integration/auth/machine-mcp-interoperability.integration.test.ts';
    const strict = matrix.find((row) => row.url === '/collections/-/mcp' && row.method === 'POST');
    const compat = matrix.find((row) => row.url === MCP_COMPAT_ENDPOINT_PATH && row.method === 'POST');
    assert.ok(strict?.identitySource.includes('mcp-strict'));
    assert.ok(compat?.identitySource.includes('mcp-compat'));
    assert.equal(strict?.testPath, ac04);
    assert.equal(compat?.testPath, ac04);
    assert.match(strict?.requiredScope ?? '', /mcp:read/);
    assert.match(compat?.objectPolicy ?? '', /mcp_compat|wrong audience|Product JWT/i);
    const colp = matrix.filter((row) => row.identitySource.includes('colp'));
    assert.ok(colp.length > 0);
    assert.ok(colp.every((row) => /Cookie|replica|not Product JWT/i.test(row.objectPolicy)));
  });

  test('mcp_strict machine token initializes, lists real tools, and reads an owned collection', async () => {
    const composed = await composeMachine();
    try {
      const child = await issueChild(composed.app);
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const created = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${product}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'AC-04 owned library', summary: null },
      });
      assert.equal(created.statusCode, 201, created.body);
      const collectionId = created.json().collection.id as string;

      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_strict', 'mcp:read:public mcp:read:own nodes:write',
      );
      const discover = await postStrict(composed.app, mcpToken, 'server/discover', 1);
      assert.equal(discover.statusCode, 200, discover.body);
      assert.equal((discover.json() as { error?: unknown }).error, undefined, discover.body);

      const listed = await postStrict(composed.app, mcpToken, 'tools/list', 2);
      assert.equal(listed.statusCode, 200, listed.body);
      const names = toolNames(listed.json());
      assert.ok(names.length > 0, listed.body);
      assert.ok(names.includes('nodes.search'), listed.body);
      for (const name of PHASE4B_MCP_READ_TOOL_NAMES) {
        assert.equal(names.includes(name), true, `missing ${name}: ${listed.body}`);
      }
      assert.equal(names.includes(PHASE4B_MCP_COLLECTIONS_LIST_TOOL_NAME), true, listed.body);
      assert.equal(names.includes('collections.create'), true, listed.body);

      const templates = await postStrict(composed.app, mcpToken, 'resources/templates/list', 3);
      assert.equal(templates.statusCode, 200, templates.body);
      const templateBody = templates.json() as { result?: { resourceTemplates?: unknown[] } };
      assert.ok(Array.isArray(templateBody.result?.resourceTemplates), templates.body);
      assert.ok((templateBody.result?.resourceTemplates?.length ?? 0) > 0, templates.body);

      const resources = await postStrict(composed.app, mcpToken, 'resources/list', 4);
      assert.equal(resources.statusCode, 200, resources.body);
      assert.ok(Array.isArray((resources.json() as { result?: { resources?: unknown[] } }).result?.resources), resources.body);

      const read = await postStrict(
        composed.app, mcpToken, 'tools/call', 5,
        { name: 'collections.get', arguments: { collectionId } },
        { 'mcp-name': 'collections.get', 'mcp-param-x-collection-id': collectionId },
      );
      assert.equal(read.statusCode, 200, read.body);
      const readBody = read.json() as {
        result?: { structuredContent?: { collection?: { id?: string } } };
        error?: unknown;
      };
      assert.equal(readBody.error, undefined, read.body);
      assert.equal(readBody.result?.structuredContent?.collection?.id, collectionId, read.body);
    } finally {
      await closeMachine(composed);
    }
  });

  test('mcp_compat machine token initializes and performs an allowed read', async () => {
    const composed = await composeMachine();
    try {
      const child = await issueChild(composed.app);
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const created = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${product}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'AC-04 compat library', summary: null },
      });
      assert.equal(created.statusCode, 201, created.body);
      const collectionId = created.json().collection.id as string;
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat', 'mcp:read:public mcp:read:own',
      );
      const initialize = await postCompat(
        composed.app,
        mcpToken,
        mcpCompatInitializeBody(MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION, { name: 'ac04', version: '1.0.0' }),
      );
      assert.equal(initialize.statusCode, 200, initialize.body);
      const initRpc = asMcpCompatJsonRpc(parseMcpCompatHttpPayload(
        String(initialize.headers['content-type'] ?? ''),
        initialize.body,
      ));
      assert.equal(initRpc.result?.protocolVersion, MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION, initialize.body);

      await postCompat(composed.app, mcpToken, mcpCompatInitializedBody());

      const listed = await postCompat(composed.app, mcpToken, mcpCompatToolsListBody(2));
      assert.equal(listed.statusCode, 200, listed.body);
      const listRpc = asMcpCompatJsonRpc(parseMcpCompatHttpPayload(
        String(listed.headers['content-type'] ?? ''),
        listed.body,
      ));
      const names = ((listRpc.result?.tools as Array<{ name?: string }> | undefined) ?? [])
        .map((tool) => tool.name);
      assert.equal(names.includes('collections.get'), true, listed.body);
      assert.equal(names.includes('collections.list'), true, listed.body);

      const called = await postCompat(
        composed.app,
        mcpToken,
        mcpCompatToolsCallBody('collections.get', 3, { collectionId }),
      );
      assert.equal(called.statusCode, 200, called.body);
      const callRpc = asMcpCompatJsonRpc(parseMcpCompatHttpPayload(
        String(called.headers['content-type'] ?? ''),
        called.body,
      ));
      const text = JSON.stringify(callRpc.result ?? {});
      assert.equal(text.includes(collectionId), true, called.body);
    } finally {
      await closeMachine(composed);
    }
  });

  test('Product token and product:read/write MCP tokens are refused as native MCP capabilities', async () => {
    const composed = await composeMachine();
    try {
      const child = await issueChild(composed.app);
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read');
      const productOnMcp = await postStrict(composed.app, product, 'tools/list', 1);
      assert.equal(productOnMcp.statusCode, 401, productOnMcp.body);
      const productOnCompat = await postCompat(
        composed.app,
        product,
        mcpCompatInitializeBody(MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION, { name: 'ac04', version: '1.0.0' }),
      );
      assert.equal(productOnCompat.statusCode, 401, productOnCompat.body);

      const productReadMcp = await accessToken(composed.app, child.secret, 'mcp_strict', 'product:read');
      const resources = await postStrict(composed.app, productReadMcp, 'resources/list', 2);
      assert.equal(resources.statusCode, 403, resources.body);
      assert.equal(
        (resources.json() as { error?: { code?: string } }).error?.code,
        'insufficient_permission',
      );

      const get = await postStrict(
        composed.app, productReadMcp, 'tools/call', 3,
        { name: 'collections.get', arguments: { collectionId: 'x' } },
        { 'mcp-name': 'collections.get', 'mcp-param-x-collection-id': 'x' },
      );
      assert.notEqual(get.statusCode, 500, get.body);
      const getBody = get.json() as { result?: { structuredContent?: { collection?: unknown } }; error?: unknown };
      assert.equal(getBody.result?.structuredContent?.collection === undefined, true, get.body);

      const productWriteMcp = await accessToken(composed.app, child.secret, 'mcp_strict', 'product:write');
      const listedWrite = await postStrict(composed.app, productWriteMcp, 'tools/list', 4);
      assert.equal(listedWrite.statusCode, 200, listedWrite.body);
      assert.equal(toolNames(listedWrite.json()).includes('collections.create'), false, listedWrite.body);
      const created = await postStrict(
        composed.app, productWriteMcp, 'tools/call', 5,
        { name: 'collections.create', arguments: { title: 'product-write-only', kind: 'bookmarks', idempotencyKey: randomUUID() } },
        { 'mcp-name': 'collections.create' },
      );
      assert.notEqual(created.statusCode, 500, created.body);
      const createdBody = created.json() as {
        error?: unknown;
        result?: { resultType?: string; isError?: boolean; structuredContent?: { collectionId?: string } };
      };
      assert.equal(createdBody.result?.structuredContent?.collectionId === undefined, true, created.body);
      assert.ok(
        createdBody.error !== undefined
          || createdBody.result?.isError === true
          || createdBody.result?.resultType !== 'complete',
        created.body,
      );
    } finally {
      await closeMachine(composed);
    }
  });

  test('missing native write scope rejects collections.create', async () => {
    const composed = await composeMachine();
    try {
      const child = await issueChild(composed.app);
      const readOnly = await accessToken(composed.app, child.secret, 'mcp_strict', 'mcp:read:own');
      const listed = await postStrict(composed.app, readOnly, 'tools/list', 1);
      assert.equal(listed.statusCode, 200, listed.body);
      assert.equal(toolNames(listed.json()).includes('collections.create'), false, listed.body);

      const created = await postStrict(
        composed.app, readOnly, 'tools/call', 2,
        { name: 'collections.create', arguments: { title: 'should fail', kind: 'bookmarks', idempotencyKey: randomUUID() } },
        { 'mcp-name': 'collections.create' },
      );
      assert.notEqual(created.statusCode, 500, created.body);
      const body = created.json() as {
        error?: unknown;
        result?: { resultType?: string; isError?: boolean; structuredContent?: { collectionId?: string } };
      };
      const createdId = body.result?.structuredContent?.collectionId;
      assert.equal(createdId === undefined, true, created.body);
      assert.ok(body.error !== undefined || body.result?.isError === true || body.result?.resultType !== 'complete', created.body);
    } finally {
      await closeMachine(composed);
    }
  });

  test('MCP collections.create and HTTP read share canonical identity; replay does not double-create', async () => {
    const composed = await composeMachine();
    try {
      const child = await issueChild(composed.app);
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_strict', 'mcp:read:own nodes:write',
      );
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const title = `AC-04 mcp write ${randomUUID()}`;
      // MRS-03 requires an intent key for MCP collection creation; the replay
      // below reuses `args`, which is exactly the same-key replay it asserts.
      const args = { title, kind: 'bookmarks' as const, summary: null, idempotencyKey: randomUUID() };
      const first = await postStrict(
        composed.app, mcpToken, 'tools/call', 1,
        { name: 'collections.create', arguments: args },
        { 'mcp-name': 'collections.create' },
      );
      assert.equal(first.statusCode, 200, first.body);
      const firstBody = first.json() as {
        result?: { resultType?: string; structuredContent?: { collectionId?: string } };
        error?: unknown;
      };
      assert.equal(firstBody.error, undefined, first.body);
      const collectionId = firstBody.result?.structuredContent?.collectionId;
      assert.ok(typeof collectionId === 'string' && collectionId.length > 0, first.body);

      const listed = await composed.app.inject({
        method: 'GET', url: '/api/v1/collections',
        headers: { authorization: `Bearer ${product}` },
      });
      assert.equal(listed.statusCode, 200, listed.body);
      const ids = (listed.json().items as Array<{ collection?: { id?: string } }>)
        .map((item) => item.collection?.id);
      assert.equal(ids.includes(collectionId), true, listed.body);

      const replay = await postStrict(
        composed.app, mcpToken, 'tools/call', 2,
        { name: 'collections.create', arguments: args },
        { 'mcp-name': 'collections.create' },
      );
      assert.equal(replay.statusCode, 200, replay.body);
      const replayBody = replay.json() as {
        result?: { structuredContent?: { collectionId?: string } };
        error?: unknown;
      };
      assert.equal(replayBody.error, undefined, replay.body);
      assert.equal(replayBody.result?.structuredContent?.collectionId, collectionId, replay.body);

      const listedAgain = await composed.app.inject({
        method: 'GET', url: '/api/v1/collections',
        headers: { authorization: `Bearer ${product}` },
      });
      const againIds = (listedAgain.json().items as Array<{ collection?: { id?: string } }>)
        .map((item) => item.collection?.id)
        .filter((id) => id === collectionId);
      assert.equal(againIds.length, 1, listedAgain.body);

      const compatToken = await accessToken(
        composed.app, child.secret, 'mcp_compat', 'mcp:read:own nodes:write',
      );
      const compatInit = await postCompat(
        composed.app,
        compatToken,
        mcpCompatInitializeBody(MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION, { name: 'ac04-write', version: '1.0.0' }),
      );
      assert.equal(compatInit.statusCode, 200, compatInit.body);
      await postCompat(composed.app, compatToken, mcpCompatInitializedBody());
      const compatTitle = `AC-04 compat write ${randomUUID()}`;
      const compatCreate = await postCompat(
        composed.app,
        compatToken,
        mcpCompatToolsCallBody('collections.create', 3, { title: compatTitle, kind: 'bookmarks', summary: null, idempotencyKey: randomUUID() }),
      );
      assert.equal(compatCreate.statusCode, 200, compatCreate.body);
      const compatRpc = asMcpCompatJsonRpc(parseMcpCompatHttpPayload(
        String(compatCreate.headers['content-type'] ?? ''),
        compatCreate.body,
      ));
      const compatText = JSON.stringify(compatRpc.result ?? {});
      const listedCompat = await composed.app.inject({
        method: 'GET', url: '/api/v1/collections',
        headers: { authorization: `Bearer ${product}` },
      });
      const httpTitles = (listedCompat.json().items as Array<{ collection?: { title?: string } }>)
        .map((item) => item.collection?.title);
      assert.equal(httpTitles.includes(compatTitle), true, `${compatText}\n${listedCompat.body}`);
    } finally {
      await closeMachine(composed);
    }
  });

  test('revoked child is rejected on MCP while the access token is unexpired', async () => {
    const composed = await composeMachine();
    try {
      const child = await issueChild(composed.app);
      const mcpToken = await accessToken(composed.app, child.secret, 'mcp_strict', 'mcp:read:own');
      const before = await postStrict(composed.app, mcpToken, 'tools/list', 1);
      assert.equal(before.statusCode, 200, before.body);

      const childGet = await composed.app.inject({
        method: 'GET', url: `/api/v1/auth/credential-children/${child.credential.id}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      const revoked = await composed.app.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${child.credential.id}/revoke`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json', 'known-command-id': randomUUID(),
          'if-match': String(childGet.headers.etag),
        },
        payload: { reason: 'ac04-revoke' },
      });
      assert.equal(revoked.statusCode, 200, revoked.body);

      const after = await postStrict(composed.app, mcpToken, 'tools/list', 2);
      assert.equal(after.statusCode, 401, after.body);
    } finally {
      await closeMachine(composed);
    }
  });

  test('browser OAuth MCP path still works through the built-in issuer', async () => {
    const mailbox = createAuthTestMailbox();
    const env = t09IssuerMcpEnv({
      DATABASE_URL: isolated.databaseUrl,
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'true',
      AUTOMATION_CURSOR_HMAC_KEY: HMAC_KEY,
      AUTOMATION_ES256_PRIVATE_JWK: signing.json,
      MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
      MCP_ALLOWED_ORIGINS: T09_TRUSTED_ORIGIN,
      PUBLICATION_ORIGIN: T09_TRUSTED_ORIGIN,
      PUBLICATION_SERVER_UUID: SERVER_UUID,
      MCP_SERVER_UUID: SERVER_UUID,
      AUTH_RATE_LIMIT_MAX: '10000',
    });
    const config = loadConfig(env);
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
    const metrics = new InMemoryMetrics();
    const metricsLogger = createLogger('silent');
    const ports = createApiPostgresPorts({
      database: isolated.runtime, config, metrics, metricsLogger,
    });
    const jwksHolder: { keys?: JSONWebKeySet } = {};
    const mcp = await composeApiMcpSurface({
      config,
      database: isolated.runtime,
      identityUnitOfWork: ports.identityUnitOfWork,
      metrics,
      publicationDirectoryReads: ports.publicationDirectoryReads,
      publicationMetadataReads: ports.publicationMetadataReads,
      publicationCursorKeys: ports.publicationCursorKeys,
      accessPolicyFacts: ports.accessPolicyFacts,
      publicationSnapshotQuery: ports.publicationSnapshotQuery,
      ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
      jwksProvider: {
        async getKeySet() {
          if (!jwksHolder.keys) throw new Error('JWKS must be published before verify');
          return createJwksProviderFromKeySet(jwksHolder.keys).getKeySet();
        },
      },
    });
    const app = buildApiApp({
      config,
      betterAuthRuntime: runtime,
      authRateLimiter: createMemoryAuthRateLimiter({ maxRequests: 1_000_000, windowMs: 60_000 }),
      mcpReadResourceProjection: mcp.mcpReadResourceProjection,
      mcpSnapshotResourceProjection: mcp.mcpSnapshotResourceProjection,
      mcpNodeResourceProjection: mcp.mcpNodeResourceProjection,
      mcpReadTransport: {
        changeSignalSource: mcp.mcpChangeSignalSource!,
        ...(mcp.mcpRateLimiter === undefined ? {} : { requestRateLimiter: mcp.mcpRateLimiter }),
        readToolAdapter: mcp.mcpReadToolAdapter!.adapter,
        readToolParamDeclarations: mcp.mcpReadToolAdapter!.paramDeclarations,
        applicationFacade: mcp.mcpApplicationFacade,
        oauthVerifier: mcp.mcpReadOAuthDependencies.oauthVerifier,
      },
    });
    try {
      const jwks = await app.inject({ method: 'GET', url: '/api/v1/auth/jwks' });
      assert.equal(jwks.statusCode, 200, jwks.body);
      jwksHolder.keys = jwks.json() as JSONWebKeySet;

      const email = t09UniqueEmail('ac04-oauth');
      const signup = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-up/email',
        headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
        payload: JSON.stringify({ name: 'AC04 User', email, password: T09_PASSWORD }),
      });
      assert.equal(signup.statusCode, 200, signup.body);
      const mail = mailbox.lastMailFor({ email, purpose: 'email-verification' });
      assert.ok(mail, 'verification email must be delivered');
      const token = mail.textBody.match(/token=([A-Za-z0-9._~-]+)/u)?.[1];
      assert.ok(token, 'verification email must carry the token');
      const verify = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/verify-email?token=${token}`,
        headers: { origin: T09_TRUSTED_ORIGIN },
      });
      assert.equal(verify.statusCode, 200, verify.body);
      const signin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-in/email',
        headers: { 'content-type': 'application/json', origin: T09_TRUSTED_ORIGIN },
        payload: JSON.stringify({ email, password: T09_PASSWORD }),
      });
      assert.equal(signin.statusCode, 200, signin.body);
      const cookie = t09SessionCookieOf(signin);
      assert.ok(cookie, 'verified sign-in must set the session cookie');

      const grant = await t09CimdCodeGrant(app, cookie, {
        resource: BUILTIN_ISSUER_TEST_AUDIENCE,
        scope: 'mcp:read:public mcp:read:own',
      });
      const exchanged = await t09ExchangeCode(app, {
        code: grant.code,
        verifier: grant.verifier,
        resource: BUILTIN_ISSUER_TEST_AUDIENCE,
      });
      assert.equal(exchanged.statusCode, 200, exchanged.body);
      const access = exchanged.json().access_token as string;
      const listed = await postStrict(app, access, 'tools/list', 1);
      assert.equal(listed.statusCode, 200, listed.body);
      const names = toolNames(listed.json());
      assert.ok(names.length > 0, listed.body);
      assert.equal(names.includes('collections.get'), true, listed.body);
    } finally {
      await app.close().catch(() => undefined);
      await mcp.mcpRateLimiter?.close().catch(() => undefined);
      await mcp.mcpChangeSignalSource?.close().catch(() => undefined);
      mcp.mcpCollectionResourceCursorKeys?.destroy();
      destroyPostgresCursorKeys(ports);
    }
  });
});

import { insertTestParentCredential } from '../../support/account-credential-db-fixture.js';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { JSONWebKeySet } from 'jose';
import { loadConfig } from '../../support/test-config.js';
import { composeApiMcpSurface } from '../../../src/bootstrap/api-mcp-surface-composition.js';
import { createReportPublishGuard } from '../../../src/bootstrap/account-credential-grant-composition.js';
import { createApiPostgresPorts } from '../../../src/bootstrap/api-postgres-ports.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { createPostgresAccountCredentialUnitOfWork } from '../../../src/infrastructure/auth/account-credentials-postgres.js';
import {
  authorizePlanWithCredentialGrant,
  createAccountCredentialCursorCodec,
  createCredentialGrantCursorCodec,
} from '../../../src/modules/auth/index.js';
import {
  MCP_COMPAT_ENDPOINT_PATH,
  MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION,
} from '../../../src/modules/mcp/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { createFixedWindowRateLimiter } from '../../../src/transport/http-security.js';
import { createLogger, InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { issueTestSession } from '../../support/product-http-harness.js';
import { createPostgresBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { withMcpTestHost } from '../../support/phase4b-mcp-transport-scaffold.js';
import {
  mcpCompatAcceptHeaders,
  mcpCompatInitializeBody,
  mcpCompatInitializedBody,
  mcpCompatToolsCallBody,
  asMcpCompatJsonRpc,
  parseMcpCompatHttpPayload,
} from '../../support/phase4b-mcp-compat-spike.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const HMAC_KEY = Buffer.alloc(32, 13).toString('base64url');
const FUTURE = '2026-12-01T00:00:00.000Z';
const GRANT_EXPIRY = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
const ORIGIN = 'https://app.example.test';
const MCP_STRICT = `${ORIGIN}/collections/-/mcp`;
const ISSUER = `${ORIGIN}/api/v1/auth`;
const GRANT = 'urn:known:params:oauth:grant-type:account-key';
const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const MCP_SCOPES = [
  'mcp:read:public', 'mcp:read:own', 'nodes:write', 'access:write',
  'changes:commit', 'changes:cancel', 'product:read', 'product:write',
  'reports:read', 'reports:write', 'reports:publish',
].join(',');
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPAQUE = /^[A-Za-z0-9._~-]{1,128}$/;
const REVISION = /^[1-9][0-9]{0,18}$/;
const DIGEST = /^sha-256:[A-Za-z0-9_-]{43}$/;

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
  ports.followCursorKeys.destroy();
  ports.followedCollectionsCursorKeys.destroy();
  ports.feedCursorKeys.destroy();
  ports.publicActivityCursorKeys.destroy();
  ports.notificationCursorKeys.destroy();
  ports.publicationCursorKeys.destroy();
}

function assertGrant(value: unknown): asserts value is {
  id: string; credentialId: string; resource: { kind: string; id: string };
  actions: string[]; state: string; revision: string; expiresAt: string; createdAt: string;
} {
  assert.equal(value && typeof value === 'object' && !Array.isArray(value), true);
  const record = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(record).sort(), [
    'actions', 'createdAt', 'credentialId', 'expiresAt', 'id', 'resource', 'revision', 'state',
  ]);
  assert.match(String(record.id), OPAQUE);
  assert.match(String(record.credentialId), OPAQUE);
  assert.match(String(record.revision), REVISION);
  assert.match(String(record.expiresAt), TIMESTAMP);
  assert.match(String(record.createdAt), TIMESTAMP);
  assert.ok(Array.isArray(record.actions) && record.actions.length >= 1);
}

describeWithPostgres('credential grant plan', () => {
  let isolated: IsolatedPostgresRuntime;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  let cursors: ReturnType<typeof createAccountCredentialCursorCodec>;
  let grantCursors: ReturnType<typeof createCredentialGrantCursorCodec>;
  const signing = es256Jwk('ac05-es256');

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ac05_grant_plan', {
      maxConnections: 16,
      applicationName: 'known-ac05-grants',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: isolated.runtime.db, baseURL: ORIGIN });
    cursors = createAccountCredentialCursorCodec(HMAC_KEY);
    grantCursors = createCredentialGrantCursorCodec(HMAC_KEY);
  }, 120_000);

  afterAll(async () => {
    cursors?.destroy();
    grantCursors?.destroy();
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
      KNOWN_FEATURE_REPORTS: 'true',
      KNOWN_FEATURE_REPORTS_MCP: 'true',
      KNOWN_FEATURE_REPORTS_MCP_WRITE: 'true',
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
      reportsUnitOfWork: ports.reportsUnitOfWork,
      reportsUnitOfWorkOptions: ports.reportsUnitOfWorkOptions,
      jwksProvider: {
        async getKeySet() {
          if (!jwksHolder.keys) throw new Error('JWKS must be published before verify');
          return jwksHolder.keys;
        },
      },
    });
    const uow = createPostgresAccountCredentialUnitOfWork(
      isolated.runtime.db, undefined, mcp.accountCredentialGrantRuntime,
      { secretHmacKey: HMAC_KEY },
    );
    const app = buildApiApp({
      config,
      identityUnitOfWork: ports.identityUnitOfWork,
      browserSessionAuthority: factory.authority,
      accountCredentialUnitOfWork: uow,
      accountCredentialCursors: cursors,
      accountCredentialGrantCursors: grantCursors,
      collectionsUnitOfWork: ports.collectionsUnitOfWork,
      productCollectionMutationUnitOfWork: ports.productCollectionMutationUnitOfWork,
      ownedCollectionsQuery: ports.ownedCollectionsQueryPorts,
      bookmarkCounts: ports.collectionBookmarkCountOrigin,
      reportsUnitOfWork: ports.reportsUnitOfWork,
      reportsRateLimiter: createFixedWindowRateLimiter({ maxRequests: 120, windowMs: 60_000 }),
      ...(mcp.accountCredentialGrantRuntime === undefined ? {} : {
        reportPublishGuard: createReportPublishGuard({
          db: isolated.runtime.db, ...mcp.accountCredentialGrantRuntime,
          ...ports.reportsUnitOfWorkOptions,
        }),
      }),
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
          ? {} : { dependencyHealth: mcp.mcpReadOAuthDependencies.dependencyHealth }),
      },
    });
    const jwks = await app.inject({ method: 'GET', url: '/api/v1/auth/jwks' });
    assert.equal(jwks.statusCode, 200, jwks.body);
    jwksHolder.keys = jwks.json() as JSONWebKeySet;
    return { app, mcp, ports, uow };
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
      subject: `ac05-${randomUUID()}`,
      handle: `h${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    });
  }

  function cookieHeaders(actor: Awaited<ReturnType<typeof session>>, extra: Record<string, string> = {}) {
    return {
      cookie: actor.cookie, origin: ORIGIN, 'x-csrf-token': actor.csrfToken,
      'content-type': 'application/json', ...extra,
    };
  }

  async function issueSameAccountChild(app: ReturnType<typeof buildApiApp>, actor: Awaited<ReturnType<typeof session>>) {
    const parent = await insertTestParentCredential(isolated.runtime.db, actor, HMAC_KEY, FUTURE);
    const child = await app.inject({
      method: 'POST', url: '/api/v1/auth/credential-children',
      headers: { authorization: `Bearer ${parent.secret}`, 'content-type': 'application/json', 'known-command-id': randomUUID() },
      payload: { label: 'child', expiresAt: FUTURE, account: { mode: 'existing', accountId: actor.accountId } },
    });
    assert.equal(child.statusCode, 201, child.body);
    return {
      parentSecret: parent.secret,
      secret: child.json().secret as string,
      credential: child.json().credential as { id: string; accountId: string; etag?: string },
      etag: String(child.headers.etag),
    };
  }

  async function accessToken(app: ReturnType<typeof buildApiApp>, secret: string, audience: string, scope: string) {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/key-token',
      headers: { 'content-type': 'application/json' },
      payload: { grant_type: GRANT, credential: secret, audience, scope },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().access_token as string;
  }

  async function attachEdition(
    app: ReturnType<typeof buildApiApp>,
    token: string,
    seriesId: string,
    collectionId: string,
  ): Promise<{ editionId: string; revision: string }> {
    const issueKey = `i-${randomUUID().slice(0, 10)}`;
    const attached = await app.inject({
      method: 'POST', url: `/api/v1/reports/${seriesId}/issues`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'known-command-id': randomUUID(),
      },
      payload: { collectionId, issueKey, title: `Issue ${issueKey}`, summary: null },
    });
    assert.equal(attached.statusCode, 201, attached.body);
    return {
      editionId: attached.json().id as string,
      revision: String(attached.json().resourceRevision),
    };
  }

  function postCompat(app: ReturnType<typeof buildApiApp>, token: string, body: unknown) {
    return app.inject({
      method: 'POST', url: MCP_COMPAT_ENDPOINT_PATH,
      headers: withMcpTestHost({
        ...mcpCompatAcceptHeaders(MCP_COMPAT_NEGOTIATED_PROTOCOL_VERSION),
        authorization: `Bearer ${token}`,
      }, ORIGIN),
      payload: body,
    });
  }

  function compatRpc(response: { readonly headers: Record<string, unknown>; readonly body: string }) {
    const contentType = response.headers['content-type'];
    return asMcpCompatJsonRpc(parseMcpCompatHttpPayload(
      typeof contentType === 'string' ? contentType : undefined,
      response.body,
    ));
  }

  async function initCompat(app: ReturnType<typeof buildApiApp>, token: string) {
    const initialize = await postCompat(app, token, mcpCompatInitializeBody(1));
    assert.equal(initialize.statusCode, 200, initialize.body);
    await postCompat(app, token, mcpCompatInitializedBody());
  }

  test('collection Plan digest, grant authorize, native commit, refresh, and reject paths', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const collection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: cookieHeaders(actor, { 'known-command-id': randomUUID() }),
        payload: { kind: 'bookmarks', title: 'AC-05 plan library', summary: null },
      });
      assert.equal(collection.statusCode, 201, collection.body);
      const collectionId = collection.json().collection.id as string;
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const botCannotManage = await composed.app.inject({ method: 'GET', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${product}` } });
      assert.equal(botCannotManage.statusCode, 404, botCannotManage.body);

      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'collection', id: collectionId },
          actions: ['collection.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      assert.equal(grantRes.statusCode, 201, grantRes.body);
      const grant = grantRes.json();
      const grantEtag = String(grantRes.headers.etag);
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'mcp:read:own nodes:write access:write changes:commit product:read product:write',
      );
      await initCompat(composed.app, mcpToken);
      const root = (await isolated.runtime.pool.query<{ id: string }>(
        `select id from nodes where collection_id = $1 and parent_id is null and deleted_at is null limit 1`,
        [collectionId],
      )).rows[0];
      assert.ok(root, 'collection root node');
      const createdNode = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('nodes.create', 11, {
        collectionId,
        parentId: root.id,
        node: { kind: 'bookmark', title: 'Plan target', url: 'https://example.test/a' },
      }));
      const nodeId = (compatRpc(createdNode).result?.structuredContent as { node?: { id?: string } } | undefined)?.node?.id;
      assert.ok(nodeId, createdNode.body);
      const nodeRow = (await isolated.runtime.pool.query<{ resource_revision: string }>(
        'select resource_revision from nodes where id = $1', [nodeId],
      )).rows[0];
      const planned = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('changes.plan', 12, {
        operations: [{
          type: 'set_visibility',
          collectionId,
          baseRevision: nodeRow!.resource_revision,
          input: { visibility: 'protected' },
        }],
        reason: 'ac05 unattended',
        dryRun: true,
      }));
      assert.equal(planned.statusCode, 200, planned.body);
      const planFields = compatRpc(planned).result as {
        structuredContent?: { planId?: string; expiresAt?: string };
        content?: Array<{ text?: string }>;
      };
      const awaiting = planFields.structuredContent ?? (JSON.parse(String(planFields.content?.[0]?.text ?? '{}')) as { planId?: string });
      const planId = awaiting.planId;
      assert.ok(planId, planned.body);
      const view = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/collection/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(view.statusCode, 200, view.body);
      const planView = view.json();
      assert.deepEqual(Object.keys(planView).sort(), [
        'bindingCurrent', 'credentialId', 'expiresAt', 'planDigest', 'planId', 'planKind', 'requiredScopes', 'status',
      ]);
      assert.match(planView.planDigest, DIGEST);
      assert.equal(planView.bindingCurrent, true);
      const staleDigest = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grant.id}/authorize-plan`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
          'if-match': grantEtag,
        },
        payload: { planKind: 'collection', planId, planDigest: 'sha-256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      });
      assert.equal(staleDigest.statusCode, 400);
      const authCommand = randomUUID();
      const authorized = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grant.id}/authorize-plan`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': authCommand,
          'if-match': grantEtag,
        },
        payload: { planKind: 'collection', planId, planDigest: planView.planDigest },
      });
      assert.equal(authorized.statusCode, 200, authorized.body);
      assert.equal(authorized.json().approved, true);
      const authReplay = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grant.id}/authorize-plan`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': authCommand,
          'if-match': grantEtag,
        },
        payload: { planKind: 'collection', planId, planDigest: planView.planDigest },
      });
      assert.equal(authReplay.statusCode, 200);
      assert.equal(authReplay.json().planId, planId);
      const refreshed = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'mcp:read:own nodes:write access:write changes:commit product:read product:write',
      );
      await initCompat(composed.app, refreshed);
      const committed = await postCompat(composed.app, refreshed, mcpCompatToolsCallBody('changes.commit', 13, {
        planId, idempotencyKey: 'ac05-commit-1',
      }));
      assert.equal(committed.statusCode, 200, committed.body);
      const commitJson = compatRpc(committed);
      assert.equal(commitJson.error, undefined, committed.body);
      const otherCollection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: cookieHeaders(actor, { 'known-command-id': randomUUID() }),
        payload: { kind: 'bookmarks', title: 'mismatch', summary: null },
      });
      const otherId = otherCollection.json().collection.id as string;
      const mismatchGrant = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID() } },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'collection', id: otherId },
          actions: ['collection.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      const mismatchPlan = await postCompat(composed.app, refreshed, mcpCompatToolsCallBody('changes.plan', 14, {
        operations: [{
          type: 'set_visibility', collectionId, baseRevision: nodeRow!.resource_revision,
          input: { visibility: 'private' },
        }],
        reason: 'mismatch', dryRun: true,
      }));
      const mismatchPlanId = ((compatRpc(mismatchPlan).result?.structuredContent as { planId?: string } | undefined)?.planId)
        ?? (JSON.parse(String((compatRpc(mismatchPlan).result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '{}')) as { planId?: string }).planId;
      if (mismatchPlanId) {
        const mismatchView = await composed.app.inject({
          method: 'GET', url: `/api/v1/me/credential-plans/collection/${mismatchPlanId}`,
          headers: { authorization: `Bearer ${child.parentSecret}` },
        });
        if (mismatchView.statusCode === 200) {
          const denied = await composed.app.inject({
            method: 'POST', url: `/api/v1/me/credential-grants/${mismatchGrant.json().id}/authorize-plan`,
            headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json',
              'known-command-id': randomUUID(),
              'if-match': String(mismatchGrant.headers.etag),
            },
            payload: { planKind: 'collection', planId: mismatchPlanId, planDigest: mismatchView.json().planDigest },
          });
          assert.ok(denied.statusCode === 403 || denied.statusCode === 400, denied.body);
        }
      }
    } finally {
      await closeMachine(composed);
    }
  }, 180_000);

  test('collection commit re-checks the grant in-transaction; revoked grant rejects the commit', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const collection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: cookieHeaders(actor, { 'known-command-id': randomUUID() }),
        payload: { kind: 'bookmarks', title: 'AC-05 revoke-commit library', summary: null },
      });
      assert.equal(collection.statusCode, 201, collection.body);
      const collectionId = collection.json().collection.id as string;
      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID() } },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'collection', id: collectionId },
          actions: ['collection.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      assert.equal(grantRes.statusCode, 201, grantRes.body);
      const grantId = grantRes.json().id as string;
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'mcp:read:own nodes:write access:write changes:commit product:read product:write',
      );
      await initCompat(composed.app, mcpToken);
      const root = (await isolated.runtime.pool.query<{ id: string }>(
        `select id from nodes where collection_id = $1 and parent_id is null and deleted_at is null limit 1`,
        [collectionId],
      )).rows[0];
      assert.ok(root, 'collection root node');
      const createdNode = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('nodes.create', 51, {
        collectionId,
        parentId: root!.id,
        node: { kind: 'bookmark', title: 'Revoke target', url: 'https://example.test/revoke' },
      }));
      const nodeId = (compatRpc(createdNode).result?.structuredContent as { node?: { id?: string } } | undefined)?.node?.id;
      assert.ok(nodeId, createdNode.body);
      const nodeRow = (await isolated.runtime.pool.query<{ resource_revision: string }>(
        'select resource_revision from nodes where id = $1', [nodeId],
      )).rows[0];
      const planned = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('changes.plan', 52, {
        operations: [{ type: 'set_visibility', collectionId, baseRevision: nodeRow!.resource_revision, input: { visibility: 'protected' } }],
        reason: 'ac05 revoke commit',
        dryRun: true,
      }));
      assert.equal(planned.statusCode, 200, planned.body);
      const planFields = compatRpc(planned).result as {
        structuredContent?: { planId?: string }; content?: Array<{ text?: string }>;
      };
      const planId = planFields.structuredContent?.planId
        ?? (JSON.parse(String(planFields.content?.[0]?.text ?? '{}')) as { planId?: string }).planId;
      assert.ok(planId, planned.body);
      const view = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/collection/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(view.statusCode, 200, view.body);
      const planDigest = (view.json() as { planDigest?: string }).planDigest;
      assert.ok(planDigest);
      const authorized = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/authorize-plan`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
          'if-match': String(grantRes.headers.etag),
        },
        payload: { planKind: 'collection', planId, planDigest },
      });
      assert.equal(authorized.statusCode, 200, authorized.body);
      const revoked = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/revoke`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': String(grantRes.headers.etag) } },
        payload: { reason: 'before commit' },
      });
      assert.equal(revoked.statusCode, 200, revoked.body);
      // The final commit re-checks the grant inside its own transaction: a
      // grant revoked before the commit must deterministically reject it.
      const committed = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('changes.commit', 53, {
        planId, idempotencyKey: 'ac05-revoke-commit',
      }));
      const commitJson = compatRpc(committed);
      const kind = (commitJson.result as { structuredContent?: { kind?: string } } | undefined)?.structuredContent?.kind;
      assert.ok(commitJson.error !== undefined || commitJson.result?.isError === true || kind !== 'committed', committed.body);
      const afterCommit = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/collection/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(afterCommit.statusCode, 200, afterCommit.body);
      assert.equal((afterCommit.json() as { status?: string }).status, 'pending');
    } finally {
      await closeMachine(composed);
    }
  }, 180_000);

  test('plan approval and authorization row commit atomically with the grant', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const collection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: cookieHeaders(actor, { 'known-command-id': randomUUID() }),
        payload: { kind: 'bookmarks', title: 'AC-05 atomic library', summary: null },
      });
      assert.equal(collection.statusCode, 201, collection.body);
      const collectionId = collection.json().collection.id as string;
      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID() } },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'collection', id: collectionId },
          actions: ['collection.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      assert.equal(grantRes.statusCode, 201, grantRes.body);
      const grantId = grantRes.json().id as string;
      const grantEtag = String(grantRes.headers.etag);
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'mcp:read:own nodes:write access:write changes:commit product:read product:write',
      );
      await initCompat(composed.app, mcpToken);
      const root = (await isolated.runtime.pool.query<{ id: string }>(
        `select id from nodes where collection_id = $1 and parent_id is null and deleted_at is null limit 1`,
        [collectionId],
      )).rows[0];
      assert.ok(root, 'collection root node');
      const createdNode = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('nodes.create', 61, {
        collectionId,
        parentId: root!.id,
        node: { kind: 'bookmark', title: 'Atomic target', url: 'https://example.test/atomic' },
      }));
      const nodeId = (compatRpc(createdNode).result?.structuredContent as { node?: { id?: string } } | undefined)?.node?.id;
      assert.ok(nodeId, createdNode.body);
      const nodeRow = (await isolated.runtime.pool.query<{ resource_revision: string }>(
        'select resource_revision from nodes where id = $1', [nodeId],
      )).rows[0];
      const planned = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('changes.plan', 62, {
        operations: [{ type: 'set_visibility', collectionId, baseRevision: nodeRow!.resource_revision, input: { visibility: 'protected' } }],
        reason: 'ac05 atomic approve',
        dryRun: true,
      }));
      assert.equal(planned.statusCode, 200, planned.body);
      const planFields = compatRpc(planned).result as {
        structuredContent?: { planId?: string }; content?: Array<{ text?: string }>;
      };
      const planId = planFields.structuredContent?.planId
        ?? (JSON.parse(String(planFields.content?.[0]?.text ?? '{}')) as { planId?: string }).planId;
      assert.ok(planId, planned.body);
      const view = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/collection/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(view.statusCode, 200, view.body);
      const planDigest = (view.json() as { planDigest?: string }).planDigest;
      assert.ok(planDigest);

      // Force the authorize command past the Plan-approval write, then fail
      // before COMMIT: the approval update and the authorization row live in
      // the SAME unit of work, so both must roll back together.
      await assert.rejects(
        composed.uow.execute(async (ports) => {
          const outcome = await authorizePlanWithCredentialGrant(ports, {
            ownerAccountId: actor.accountId,
            grantId,
            commandId: randomUUID(),
            ifMatch: grantEtag,
            planKind: 'collection',
            planId,
            planDigest,
          });
          assert.equal(outcome.kind, 'succeeded', JSON.stringify(outcome));
          throw new Error('rollback-after-plan-approval');
        }),
        /rollback-after-plan-approval/,
      );
      const approvalsAfterRollback = await isolated.runtime.pool.query<{ plan_id: string }>(
        'select plan_id from mcp_approvals where plan_id = $1', [planId],
      );
      const authzAfterRollback = await isolated.runtime.pool.query<{ plan_id: string }>(
        'select plan_id from account_credential_plan_authorizations where plan_id = $1', [planId],
      );
      assert.deepEqual(approvalsAfterRollback.rows, []);
      assert.deepEqual(authzAfterRollback.rows, []);

      // A normal commit-path authorize then leaves both rows present.
      const authorized = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/authorize-plan`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
          'if-match': grantEtag,
        },
        payload: { planKind: 'collection', planId, planDigest },
      });
      assert.equal(authorized.statusCode, 200, authorized.body);
      const approvalsAfterCommit = await isolated.runtime.pool.query<{ plan_id: string }>(
        'select plan_id from mcp_approvals where plan_id = $1', [planId],
      );
      const authzAfterCommit = await isolated.runtime.pool.query<{ plan_id: string }>(
        'select plan_id from account_credential_plan_authorizations where plan_id = $1', [planId],
      );
      assert.equal(approvalsAfterCommit.rows.length, 1);
      assert.equal(authzAfterCommit.rows.length, 1);
    } finally {
      await closeMachine(composed);
    }
  }, 180_000);

  test('reports publish requires parent approval and MCP hides credential management', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const series = await composed.app.inject({
        method: 'POST', url: '/api/v1/reports',
        headers: {
          authorization: `Bearer ${product}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { title: 'AC-05 digest', summary: null, slug: `ac05-${randomUUID().slice(0, 8)}`, visibility: 'private' },
      });
      assert.ok(series.statusCode === 201 || series.statusCode === 200, series.body);
      if (series.statusCode !== 201 && series.statusCode !== 200) return;
      const seriesId = (series.json() as { id?: string }).id ?? (series.json() as { series?: { id?: string } }).series?.id;
      assert.ok(seriesId);
      const revision = String((series.json() as { resourceRevision?: string }).resourceRevision
        ?? (series.json() as { series?: { resourceRevision?: string } }).series?.resourceRevision ?? '1');
      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'report', id: seriesId },
          actions: ['report.metadata.write', 'report.issue.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      assert.equal(grantRes.statusCode, 201, grantRes.body);
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'reports:write reports:publish product:read product:write mcp:read:own',
      );
      await initCompat(composed.app, mcpToken);
      const listed = await postCompat(composed.app, mcpToken, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      });
      const names = ((compatRpc(listed).result as { tools?: Array<{ name?: string }> })?.tools ?? [])
        .map((tool) => tool.name);
      assert.ok(!names.includes('known.credentials.plan'));
      assert.ok(!names.includes('known.credentials.authorize_plan'));
      assert.ok(names.includes('reports.plan'), JSON.stringify(names));
      assert.ok(names.includes('reports.commit'), JSON.stringify(names));
      const planned = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('reports.plan', 21, {
        operations: [{
          type: 'report', action: 'series.update', targetId: seriesId, expectedRevision: revision,
          patch: { visibility: 'unlisted' },
        }],
        reportRevision: revision,
      }));
      assert.equal(planned.statusCode, 200, planned.body);
      const planFields = compatRpc(planned).result as {
        structuredContent?: { planId?: string };
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      const awaiting = planFields.structuredContent
        ?? (JSON.parse(String(planFields.content?.[0]?.text ?? '{}')) as { planId?: string });
      const planId = awaiting.planId;
      assert.ok(planId, planned.body);
      const commitBare = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('reports.commit', 22, {
        planId, idempotencyKey: 'ac05-report-bare',
      }));
      const bare = compatRpc(commitBare);
      assert.ok(bare.result?.isError === true || (bare.result as { structuredContent?: { kind?: string } })?.structuredContent?.kind !== 'committed', commitBare.body);
      const httpView = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/report/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(httpView.statusCode, 200, httpView.body);
      for (const name of ['known.credentials.plan', 'known.credentials.authorize_plan']) {
        const denied = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody(name, 24, {}));
        const response = compatRpc(denied);
        assert.ok(response.error || response.result?.isError, denied.body);
      }
      const authorized = await composed.app.inject({ method: 'POST',
        url: `/api/v1/me/credential-grants/${grantRes.json().id}/authorize-plan`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json',
          'known-command-id': randomUUID(), 'if-match': String(grantRes.headers.etag) },
        payload: { planKind: 'report', planId, planDigest: httpView.json().planDigest },
      });
      assert.equal(authorized.statusCode, 200, authorized.body);
      assert.equal(authorized.json().approved, true);
      const committed = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('reports.commit', 25, {
        planId, idempotencyKey: 'ac05-report-ok',
      }));
      assert.equal(committed.statusCode, 200, committed.body);
      const commitJson = compatRpc(committed);
      assert.equal(commitJson.error, undefined, committed.body);
      assert.notEqual(commitJson.result?.isError, true, committed.body);
    } finally {
      await closeMachine(composed);
    }
  }, 180_000);

  test('publish-only report Plan authorizes against a series grant', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const product = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const series = await composed.app.inject({
        method: 'POST', url: '/api/v1/reports',
        headers: {
          authorization: `Bearer ${product}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { title: 'AC-05 publish-only', summary: null, slug: `pubonly-${randomUUID().slice(0, 8)}`, visibility: 'private' },
      });
      assert.ok(series.statusCode === 201 || series.statusCode === 200, series.body);
      const seriesId = (series.json() as { id?: string }).id
        ?? (series.json() as { series?: { id?: string } }).series?.id;
      assert.ok(seriesId);
      const seriesRevision = String((series.json() as { resourceRevision?: string }).resourceRevision
        ?? (series.json() as { series?: { resourceRevision?: string } }).series?.resourceRevision ?? '1');
      const collection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${product}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'AC-05 publish-only source', summary: null },
      });
      assert.equal(collection.statusCode, 201, collection.body);
      const collectionId = collection.json().collection.id as string;
      const issueKey = `i-${randomUUID().slice(0, 10)}`;
      const attached = await composed.app.inject({
        method: 'POST', url: `/api/v1/reports/${seriesId}/issues`,
        headers: {
          authorization: `Bearer ${product}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { collectionId, issueKey, title: `Issue ${issueKey}`, summary: null },
      });
      assert.equal(attached.statusCode, 201, attached.body);
      const editionId = attached.json().id as string;
      const editionRevision = String(attached.json().resourceRevision);
      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID() } },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'report', id: seriesId },
          actions: ['report.issue.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      assert.equal(grantRes.statusCode, 201, grantRes.body);
      const grantId = grantRes.json().id as string;
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'reports:write reports:publish product:read product:write mcp:read:own',
      );
      await initCompat(composed.app, mcpToken);
      const planned = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('reports.plan', 51, {
        operations: [{
          type: 'report', action: 'edition.publish', targetId: editionId,
          expectedRevision: editionRevision, patch: {},
        }],
        reportRevision: seriesRevision,
      }));
      assert.equal(planned.statusCode, 200, planned.body);
      const planId = (compatRpc(planned).result as { structuredContent?: { planId?: string } }).structuredContent?.planId;
      assert.ok(planId, planned.body);
      const httpView = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/report/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(httpView.statusCode, 200, httpView.body);
      const planDigest = (httpView.json() as { planDigest?: string }).planDigest;
      assert.ok(planDigest);
      const authorized = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/authorize-plan`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': String(grantRes.headers.etag) } },
        payload: { planKind: 'report', planId, planDigest },
      });
      assert.equal(authorized.statusCode, 200, authorized.body);
    } finally {
      await closeMachine(composed);
    }
  }, 180_000);

  test('revoke grant, rotate key, and feature-off reject authorize or commit', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const collection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: cookieHeaders(actor, { 'known-command-id': randomUUID() }),
        payload: { kind: 'bookmarks', title: 'revoke library', summary: null },
      });
      const collectionId = collection.json().collection.id as string;
      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID() } },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'collection', id: collectionId },
          actions: ['collection.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      const got = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-grants/${grantRes.json().id}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantRes.json().id}/revoke`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': String(got.headers.etag) } },
        payload: { reason: 'stop' },
      });
      const product = await accessToken(composed.app, child.secret, 'product', 'product:write product:read');
      const afterRevoke = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantRes.json().id}/authorize-plan`,
        headers: {
          authorization: `Bearer ${child.parentSecret}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
          'if-match': String(grantRes.headers.etag),
        },
        payload: {
          planKind: 'collection', planId: 'missing-plan',
          planDigest: 'sha-256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      });
      assert.ok(afterRevoke.statusCode === 404 || afterRevoke.statusCode === 412, afterRevoke.body);
      const rotated = await composed.app.inject({
        method: 'POST', url: `/api/v1/auth/credential-children/${child.credential.id}/rotate`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': child.etag } },
        payload: { expiresAt: FUTURE },
      });
      assert.equal(rotated.statusCode, 200, rotated.body);
    } finally {
      await closeMachine(composed);
    }
    const offConfig = loadConfig({
      ...process.env as Record<string, string>,
      DATABASE_URL: isolated.databaseUrl,
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_ORIGIN: ORIGIN,
      LOG_LEVEL: 'silent',
      KNOWN_FEATURE_ACCOUNT_CREDENTIALS: 'false',
    });
    const offPorts = createApiPostgresPorts({
      database: isolated.runtime,
      config: offConfig,
      metrics: new InMemoryMetrics(),
      metricsLogger: createLogger('silent'),
    });
    const offApp = buildApiApp({
      config: offConfig,
      identityUnitOfWork: offPorts.identityUnitOfWork,
      browserSessionAuthority: factory.authority,
    });
    try {
      const actor = await session();
      const listed = await offApp.inject({
        method: 'GET', url: '/api/v1/me/credential-grants',
        headers: { cookie: actor.cookie },
      });
      assert.equal(listed.statusCode, 404);
    } finally {
      await offApp.close().catch(() => undefined);
      destroyPostgresCursorKeys(offPorts);
    }
  }, 120_000);

  test('bearer HTTP report publish requires reports:publish AND approved grant/plan; revoke blocks it', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const plainToken = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const series = await composed.app.inject({
        method: 'POST', url: '/api/v1/reports',
        headers: {
          authorization: `Bearer ${plainToken}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { title: 'AC-05 gate digest', summary: null, slug: `gate-${randomUUID().slice(0, 8)}`, visibility: 'private' },
      });
      assert.ok(series.statusCode === 201 || series.statusCode === 200, series.body);
      const seriesId = (series.json() as { id?: string }).id
        ?? (series.json() as { series?: { id?: string } }).series?.id;
      assert.ok(seriesId);
      const seriesRevision = String((series.json() as { resourceRevision?: string }).resourceRevision
        ?? (series.json() as { series?: { resourceRevision?: string } }).series?.resourceRevision ?? '1');
      const collection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${plainToken}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'AC-05 source library', summary: null },
      });
      assert.equal(collection.statusCode, 201, collection.body);
      const collectionId = collection.json().collection.id as string;

      const first = await attachEdition(composed.app, plainToken, seriesId, collectionId);
      const publishUrl = `/api/v1/reports/${seriesId}/issues/${first.editionId}/publish`;

      // 1) product:read + product:write only (no reports:publish scope) must be rejected.
      const noScope = await composed.app.inject({
        method: 'POST', url: publishUrl,
        headers: {
          authorization: `Bearer ${plainToken}`,
          'known-command-id': randomUUID(),
          'if-match': `"${first.revision}"`,
        },
      });
      assert.equal(noScope.statusCode, 403, noScope.body);

      // 2) reports:publish scope but no approved grant/plan must still be rejected.
      const scopedToken = await accessToken(
        composed.app, child.secret, 'product', 'product:read product:write reports:publish',
      );
      const noPlan = await composed.app.inject({
        method: 'POST', url: publishUrl,
        headers: {
          authorization: `Bearer ${scopedToken}`,
          'known-command-id': randomUUID(),
          'if-match': `"${first.revision}"`,
        },
      });
      assert.equal(noPlan.statusCode, 403, noPlan.body);

      // 3) full grant + plan + authorize chain allows the bearer publish.
      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID() } },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'report', id: seriesId },
          actions: ['report.issue.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      assert.equal(grantRes.statusCode, 201, grantRes.body);
      const grantId = grantRes.json().id as string;
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'reports:write reports:publish product:read product:write mcp:read:own',
      );
      await initCompat(composed.app, mcpToken);
      const planned = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('reports.plan', 41, {
        operations: [{
          type: 'report', action: 'edition.publish', targetId: first.editionId,
          expectedRevision: first.revision, patch: {},
        }],
        reportRevision: seriesRevision,
      }));
      assert.equal(planned.statusCode, 200, planned.body);
      const planId = (compatRpc(planned).result as { structuredContent?: { planId?: string } }).structuredContent?.planId;
      assert.ok(planId, planned.body);
      const httpView = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/report/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(httpView.statusCode, 200, httpView.body);
      const planDigest = (httpView.json() as { planDigest?: string }).planDigest;
      assert.ok(planDigest);
      const authorized = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/authorize-plan`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': String(grantRes.headers.etag) } },
        payload: { planKind: 'report', planId, planDigest },
      });
      assert.equal(authorized.statusCode, 200, authorized.body);
      const published = await composed.app.inject({
        method: 'POST', url: publishUrl,
        headers: {
          authorization: `Bearer ${scopedToken}`,
          'known-command-id': randomUUID(),
          'if-match': `"${first.revision}"`,
        },
      });
      assert.equal(published.statusCode, 200, published.body);
      const consumed = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/report/${planId}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(consumed.statusCode, 200, consumed.body);
      assert.equal((consumed.json() as { status?: string }).status, 'committed');

      // 4) after grant revoke, a newly approved plan cannot publish anymore.
      const second = await attachEdition(composed.app, plainToken, seriesId, collectionId);
      const current = await composed.app.inject({
        method: 'GET', url: `/api/v1/reports/${seriesId}`,
        headers: { authorization: `Bearer ${plainToken}` },
      });
      assert.equal(current.statusCode, 200, current.body);
      const currentRevision = String((current.json() as { resourceRevision?: string }).resourceRevision ?? seriesRevision);
      const planned2 = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('reports.plan', 42, {
        operations: [{
          type: 'report', action: 'edition.publish', targetId: second.editionId,
          expectedRevision: second.revision, patch: {},
        }],
        reportRevision: currentRevision,
      }));
      assert.equal(planned2.statusCode, 200, planned2.body);
      const plan2Id = (compatRpc(planned2).result as { structuredContent?: { planId?: string } }).structuredContent?.planId;
      assert.ok(plan2Id, planned2.body);
      const view2 = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/report/${plan2Id}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(view2.statusCode, 200, view2.body);
      const digest2 = (view2.json() as { planDigest?: string }).planDigest;
      assert.ok(digest2);
      const auth2 = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/authorize-plan`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': String(grantRes.headers.etag) } },
        payload: { planKind: 'report', planId: plan2Id, planDigest: digest2 },
      });
      assert.equal(auth2.statusCode, 200, auth2.body);
      const revoked = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/revoke`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': String(grantRes.headers.etag) } },
        payload: { reason: 'gate test' },
      });
      assert.equal(revoked.statusCode, 200, revoked.body);
      const afterRevoke = await composed.app.inject({
        method: 'POST', url: `/api/v1/reports/${seriesId}/issues/${second.editionId}/publish`,
        headers: {
          authorization: `Bearer ${scopedToken}`,
          'known-command-id': randomUUID(),
          'if-match': `"${second.revision}"`,
        },
      });
      assert.equal(afterRevoke.statusCode, 403, afterRevoke.body);
    } finally {
      await closeMachine(composed);
    }
  }, 180_000);

  test('HTTP publish matches only edition.publish on the target edition and consumes the Plan', async () => {
    const composed = await composeMachine();
    try {
      const actor = await session();
      const child = await issueSameAccountChild(composed.app, actor);
      const plainToken = await accessToken(composed.app, child.secret, 'product', 'product:read product:write');
      const series = await composed.app.inject({
        method: 'POST', url: '/api/v1/reports',
        headers: {
          authorization: `Bearer ${plainToken}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { title: 'AC-05 edition target', summary: null, slug: `ed-${randomUUID().slice(0, 8)}`, visibility: 'private' },
      });
      assert.ok(series.statusCode === 201 || series.statusCode === 200, series.body);
      const seriesId = (series.json() as { id?: string }).id
        ?? (series.json() as { series?: { id?: string } }).series?.id;
      assert.ok(seriesId);
      const seriesRevision = String((series.json() as { resourceRevision?: string }).resourceRevision
        ?? (series.json() as { series?: { resourceRevision?: string } }).series?.resourceRevision ?? '1');
      const collection = await composed.app.inject({
        method: 'POST', url: '/api/v1/collections',
        headers: {
          authorization: `Bearer ${plainToken}`,
          'content-type': 'application/json',
          'known-command-id': randomUUID(),
        },
        payload: { kind: 'bookmarks', title: 'AC-05 edition source', summary: null },
      });
      assert.equal(collection.statusCode, 201, collection.body);
      const collectionId = collection.json().collection.id as string;
      const first = await attachEdition(composed.app, plainToken, seriesId, collectionId);
      const second = await attachEdition(composed.app, plainToken, seriesId, collectionId);
      const grantRes = await composed.app.inject({
        method: 'POST', url: '/api/v1/me/credential-grants',
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID() } },
        payload: {
          credentialId: child.credential.id,
          resource: { kind: 'report', id: seriesId },
          actions: ['report.metadata.write', 'report.issue.publish'],
          expiresAt: GRANT_EXPIRY,
        },
      });
      assert.equal(grantRes.statusCode, 201, grantRes.body);
      const grantId = grantRes.json().id as string;
      const grantEtag = String(grantRes.headers.etag);
      const scopedToken = await accessToken(
        composed.app, child.secret, 'product', 'product:read product:write reports:publish',
      );
      const mcpToken = await accessToken(
        composed.app, child.secret, 'mcp_compat',
        'reports:write reports:publish product:read product:write mcp:read:own',
      );
      await initCompat(composed.app, mcpToken);
      const current = await composed.app.inject({
        method: 'GET', url: `/api/v1/reports/${seriesId}`,
        headers: { authorization: `Bearer ${plainToken}` },
      });
      assert.equal(current.statusCode, 200, current.body);
      const currentRevision = String((current.json() as { resourceRevision?: string }).resourceRevision ?? seriesRevision);

      async function authorizeOperations(
        rpcId: number,
        operations: readonly Record<string, unknown>[],
        reportRevision: string,
      ): Promise<string> {
        const planned = await postCompat(composed.app, mcpToken, mcpCompatToolsCallBody('reports.plan', rpcId, {
          operations, reportRevision,
        }));
        assert.equal(planned.statusCode, 200, planned.body);
        const planId = (compatRpc(planned).result as { structuredContent?: { planId?: string } }).structuredContent?.planId;
        assert.ok(planId, planned.body);
        const view = await composed.app.inject({
          method: 'GET', url: `/api/v1/me/credential-plans/report/${planId}`,
          headers: { authorization: `Bearer ${child.parentSecret}` },
        });
        assert.equal(view.statusCode, 200, view.body);
        const planDigest = (view.json() as { planDigest?: string }).planDigest;
        assert.ok(planDigest);
        const authorized = await composed.app.inject({
          method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/authorize-plan`,
          headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': grantEtag } },
          payload: { planKind: 'report', planId, planDigest },
        });
        assert.equal(authorized.statusCode, 200, authorized.body);
        return planId;
      }

      function publish(editionId: string, revision: string) {
        return composed.app.inject({
          method: 'POST', url: `/api/v1/reports/${seriesId}/issues/${editionId}/publish`,
          headers: {
            authorization: `Bearer ${scopedToken}`,
            'known-command-id': randomUUID(),
            'if-match': `"${revision}"`,
          },
        });
      }

      await authorizeOperations(71, [{
        type: 'report', action: 'series.update', targetId: seriesId,
        expectedRevision: currentRevision, patch: { visibility: 'unlisted' },
      }], currentRevision);
      const seriesUpdateOnly = await publish(first.editionId, first.revision);
      assert.equal(seriesUpdateOnly.statusCode, 403, seriesUpdateOnly.body);

      const planForA = await authorizeOperations(72, [{
        type: 'report', action: 'edition.publish', targetId: first.editionId,
        expectedRevision: first.revision, patch: {},
      }], currentRevision);
      const publishBWithPlanA = await publish(second.editionId, second.revision);
      assert.equal(publishBWithPlanA.statusCode, 403, publishBWithPlanA.body);
      const publishA = await publish(first.editionId, first.revision);
      assert.equal(publishA.statusCode, 200, publishA.body);
      const consumedA = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/report/${planForA}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      assert.equal(consumedA.statusCode, 200, consumedA.body);
      assert.equal((consumedA.json() as { status?: string }).status, 'committed');

      // AC-F010: re-authorizing the CONSUMED plan (its authorization row
      // dropped, e.g. another grant consumed it) must be a semantic 400 —
      // not a retryable 503 the SDK would keep re-issuing as same_request
      // against a dead plan.
      const stalePlanView = await composed.app.inject({
        method: 'GET', url: `/api/v1/me/credential-plans/report/${planForA}`,
        headers: { authorization: `Bearer ${child.parentSecret}` },
      });
      const stalePlanDigest = (stalePlanView.json() as { planDigest?: string }).planDigest;
      assert.ok(stalePlanDigest);
      await isolated.runtime.pool.query(
        `delete from account_credential_plan_authorizations where plan_kind='report' and plan_id=$1`,
        [planForA]);
      const staleAuthorize = await composed.app.inject({
        method: 'POST', url: `/api/v1/me/credential-grants/${grantId}/authorize-plan`,
        headers: { authorization: `Bearer ${child.parentSecret}`, 'content-type': 'application/json', ...{ 'known-command-id': randomUUID(), 'if-match': grantEtag } },
        payload: { planKind: 'report', planId: planForA, planDigest: stalePlanDigest },
      });
      assert.equal(staleAuthorize.statusCode, 400, staleAuthorize.body);
      assert.equal(staleAuthorize.json().error?.code, 'invalid_request', staleAuthorize.body);

      const third = await attachEdition(composed.app, plainToken, seriesId, collectionId);
      const reuseConsumed = await publish(third.editionId, third.revision);
      assert.equal(reuseConsumed.statusCode, 403, reuseConsumed.body);
    } finally {
      await closeMachine(composed);
    }
  }, 180_000);
});

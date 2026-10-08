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
  ports.followCursorKeys?.destroy();
  ports.followedCollectionsCursorKeys?.destroy();
  ports.feedCursorKeys?.destroy();
  ports.publicActivityCursorKeys?.destroy();
  ports.notificationCursorKeys?.destroy();
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
});

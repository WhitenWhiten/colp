import { createPhase4bMcpLowRiskNodeCreateService } from '../../../src/modules/mcp/low-risk-node-create.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresLibraryCollectionUnitOfWork } from '../../../src/infrastructure/collections/library-collection-postgres.js';
import { createPostgresCanonicalMutationUnitOfWork } from '../../../src/infrastructure/collections/canonical-product-unit-of-work.js';
import { createPostgresCollectionsUnitOfWork, createPostgresOwnedCollectionsReadPort } from '../../../src/infrastructure/collections/index.js';
import { runMigrations, createAttachmentExposurePolicyAdapter, createPostgresSharedExposureFactsPort } from '../../../src/infrastructure/database/index.js';
import { createPostgresReplicaStore, createPostgresSyncSessionIssuer, createPostgresSyncBootstrapSnapshotApplication } from '../../../src/infrastructure/sync/index.js';
import { ensureLibraryCollection, type LibraryCollection } from '../../../src/modules/collections/application/ensure-library-collection.js';
import { createPhase4bMcpLowRiskNodeCreateInspect } from '../../../src/bootstrap/mcp-write-composition.js';
import { createPhase4bMcpLowRiskNodeUpdateService } from '../../../src/modules/mcp/low-risk-node-update.js';
import { createProductOwnedCollectionsCursorSigner } from '../../../src/modules/collections/index.js';
import { registerCollectionRoutes } from '../../../src/transport/product/collection-routes.js';
import { registerExtensionCollectionRoutes } from '../../../src/transport/colp-sync/extension-collection-routes.js';
import { createIdentityMemoryState, createIdentityMemoryUnitOfWork, issueTestSession } from '../../support/product-http-harness.js';
import { createInMemoryBetterAuthTestFactory } from '../../support/better-auth-test-factory.js';
import { mintExtensionCredentialHttpFixture } from '../../support/extension-credential.js';
import { loadConfig } from '../../support/test-config.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const ORIGIN = 'https://app.example.test';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describeWithPostgres('one private bookmark library per account', () => {
  let isolated: IsolatedPostgresRuntime;
  let library: LibraryCollection;
  let extensionAuth: Awaited<ReturnType<typeof mintExtensionCredentialHttpFixture>>;
  let owner: Awaited<ReturnType<typeof issueTestSession>>;
  const app = Fastify();
  const identity = createIdentityMemoryUnitOfWork(createIdentityMemoryState(new Date()));
  const factory = createInMemoryBetterAuthTestFactory({ identityUnitOfWork: identity });
  const cursors = createProductOwnedCollectionsCursorSigner({ current: { id: 'library-test', key: 'library-cursor-test-secret-32-bytes' } });

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('account_library', { maxConnections: 6 });
    await runMigrations(isolated.runtime.db, 'latest');
    owner = await issueTestSession({ factory, subject: 'library-owner', displayName: 'Owner', handle: 'libraryowner' });
    await isolated.runtime.db.insertInto('accounts').values({ id: owner.accountId,
      subject_id: owner.subjectId, status: 'active', security_epoch: 0n, created_at: new Date() }).execute();
    await isolated.runtime.db.insertInto('profile_handles').values({ handle: 'libraryowner', account_id: owner.accountId, created_at: new Date() }).execute();
    await isolated.runtime.db.insertInto('account_identities').values({ id: 'library-identity',
      account_id: owner.accountId, issuer: 'https://issuer.example', subject: 'library-oidc', created_at: new Date() }).execute();
    app.decorate('browserSessionAuthority', factory.authority);
    app.addContentTypeParser('application/merge-patch+json', { parseAs: 'string' }, (_request, body, done) => {
      try { done(null, JSON.parse(String(body))); } catch (error) { done(error as Error); }
    });
    app.setErrorHandler((error: { statusCode?: number; productCode?: string; code?: string; message?: string }, _request, reply) =>
      reply.code(error.statusCode ?? 500).send({ error: { code: error.productCode ?? error.code, message: error.message } }));
    const libraryCollectionUnitOfWork = createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db);
    registerCollectionRoutes(app, {
      config: loadConfig({ DATABASE_URL: 'postgres://localhost/library', PRODUCT_ORIGIN: ORIGIN,
        ALLOWED_ORIGINS: ORIGIN, OIDC_ISSUER: 'https://issuer.example/realms/known',
        OIDC_CLIENT_ID: 'known-web', OIDC_REDIRECT_URI: ORIGIN + '/api/v1/auth/oidc/callback',
        OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
        OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
        OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default', NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      identityUnitOfWork: identity, libraryCollectionUnitOfWork,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(isolated.runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      collectionMetadataMutationsEnabled: true,
      ownedCollectionsQuery: { reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db), cursors, clock: { now: async () => new Date() } },
      bookmarkCounts: { lookupBookmarkCounts: async entries => new Map(entries.map(entry => [entry.collectionId, 0])) },
    });
    const auth = extensionAuth = await mintExtensionCredentialHttpFixture({ issuer: 'https://issuer.example',
      audience: 'known-api', clientId: 'known-extension', subject: 'library-oidc', credentialId: 'library-credential' });
    registerExtensionCollectionRoutes(app, {
      libraryCollectionUnitOfWork, credentialVerifier: auth.verifier, allowedOrigins: [EXTENSION_ORIGIN],
      ownedCollectionsQuery: { reads: createPostgresOwnedCollectionsReadPort(isolated.runtime.db), cursors, clock: { now: async () => new Date() } },
      ownerSubject: { resolveOwnerSubject: async () => owner.subjectId },
      ownerAccount: { resolveActiveAccount: async () => ({ accountId: owner.accountId, subjectId: owner.subjectId }) },
    });
    await app.ready();
  }, 120_000);
  afterAll(async () => { await app.close(); cursors.destroy(); await isolated?.close(); });

  test('concurrent ensures create exactly one library and atomically bootstrap canonical role folders', async () => {
    const unit = createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db);
    const actor = { principalId: owner.accountId, subjectId: owner.subjectId };
    const [first, second] = await Promise.all([ensureLibraryCollection(unit, actor), ensureLibraryCollection(unit, actor)]);
    assert.deepEqual(first, second);
    library = first;
    const collections = await isolated.runtime.db.selectFrom('collections').selectAll()
      .where('owner_subject_id', '=', owner.subjectId).execute();
    assert.equal(collections.length, 1);
    assert.equal(collections[0]?.is_library, true);
    assert.equal(BigInt(collections[0]!.commit_ordinal), 3n);
    const nodes = await isolated.runtime.db.selectFrom('nodes').selectAll().where('collection_id', '=', library.id).execute();
    assert.equal(nodes.length, 3);
    for (const role of ['bookmarks-bar', 'other-bookmarks']) {
      const node = nodes.find(row => row.folder_role === role);
      assert.ok(node);
      assert.equal(node.parent_id, library.rootNodeId);
      assert.equal(node.payload_json?.folderRole, role);
      assert.ok(node.resource_revision);
    }
    const operations = await isolated.runtime.db.selectFrom('operations').select('operation_type').where('collection_id', '=', library.id).execute();
    assert.equal(operations.length, 3);
    const outbox = await isolated.runtime.db.selectFrom('outbox_events').select('event_type').where('aggregate_scope', '=', library.id).execute();
    assert.ok(outbox.length >= 3);
  });

  test('cookie and extension endpoints return the same library and listings mark it', async () => {
    const web = await app.inject({ method: 'GET', url: '/api/v1/me/library', headers: { cookie: owner.cookie } });
    assert.equal(web.statusCode, 200, web.body);
    assert.deepEqual(web.json(), library);
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/me/library' });
    assert.equal(anonymous.statusCode, 401);
    const auth = extensionAuth;
    const extension = await app.inject({ method: 'GET', url: '/colp/v0.1/sync/library',
      headers: { authorization: auth.authorization, origin: EXTENSION_ORIGIN } });
    assert.equal(extension.statusCode, 200, extension.body);
    assert.deepEqual(extension.json(), library);
    const listing = await app.inject({ method: 'GET', url: '/api/v1/collections', headers: { cookie: owner.cookie } });
    assert.equal(listing.statusCode, 200, listing.body);
    assert.equal(listing.json().items[0].collection.library, true);
    assert.equal(listing.json().items[0].capabilities.managePublication, false);
  });

  test('the real sync bootstrap snapshot contains the two canonical browser role folders', async () => {
    const auth = await mintExtensionCredentialHttpFixture({ issuer: 'https://issuer.example', audience: 'known-api',
      clientId: 'known-extension', subject: 'library-oidc', credentialId: 'library-snapshot-credential' });
    const replica = await createPostgresReplicaStore(isolated.runtime.db).create({ accountId: owner.accountId, collectionId: library.id, deviceName: 'Library browser', replicaName: 'Library replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: false, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'library-profile', mountMode: 'whole-profile', browserGeneration: 'library-install' },
      leaseDurationSeconds: 3_600 }, { actorAccountId: owner.accountId });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, { issuer: 'https://issuer.example',
      audience: 'known-api', clientId: 'known-extension', replayEncryptionKey: Buffer.alloc(32, 91),
      replayEncryptionKeyVersion: 1, sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1, endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'] });
    const issued = await issuer.issue({ credential: auth.credential, idempotencyKey: 'library-session',
      requestFingerprint: 'library-session-fingerprint', collectionId: library.id, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:bootstrap', 'sync:pull', 'sync:push'],
      protocolVersion: '0.2', origin: EXTENSION_ORIGIN });
    assert.equal(issued.state, 'issued');
    if (issued.state !== 'issued') throw new Error('session was not issued');
    const snapshot = await createPostgresSyncBootstrapSnapshotApplication(isolated.runtime, {
      cursorSecret: Buffer.alloc(32, 93), attachmentExposure: createAttachmentExposurePolicyAdapter(createPostgresSharedExposureFactsPort(isolated.runtime)),
    }).query({ credential: auth.credential, origin: EXTENSION_ORIGIN, request: { sessionId: issued.envelope.sessionId, limit: 10 } });
    assert.equal(snapshot.nodes.length, 3);
    assert.equal(snapshot.nodes.filter(node => node.kind === 'folder' && node.folderRole === 'bookmarks-bar').length, 1);
    assert.equal(snapshot.nodes.filter(node => node.kind === 'folder' && node.folderRole === 'other-bookmarks').length, 1);
  });

  test('Product create and move require a destination under a browser role folder', async () => {
    const headers = { cookie: owner.cookie, origin: ORIGIN, 'x-csrf-token': owner.csrfToken,
      'content-type': 'application/json' };
    const create = (parentId: string) => app.inject({ method: 'POST', url: `/api/v1/collections/${library.id}/nodes`,
      headers: { ...headers, 'known-command-id': randomUUID() }, payload: { parentId, afterId: null, beforeId: null,
        node: { kind: 'bookmark', title: 'Saved link', url: 'https://example.test/saved', description: null, tags: [], visibility: 'inherit' } } });
    const rejected = await create(library.rootNodeId);
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.equal(rejected.json().error.code, 'invalid_document', rejected.body);
    const accepted = await create(library.bookmarksBarId);
    assert.equal(accepted.statusCode, 201, accepted.body);
    const node = accepted.json().node;
    const parent = await isolated.runtime.db.selectFrom('nodes').selectAll().where('id', '=', library.bookmarksBarId).executeTakeFirstOrThrow();
    const root = await isolated.runtime.db.selectFrom('nodes').selectAll().where('id', '=', library.rootNodeId).executeTakeFirstOrThrow();
    const moved = await app.inject({ method: 'POST', url: `/api/v1/collections/${library.id}/nodes/${node.id}/move`,
      headers: { ...headers, 'known-command-id': randomUUID(), 'if-match': node.etag }, payload: {
        newParentId: library.rootNodeId, afterId: null, beforeId: null,
        baseSourceParentRevision: parent.children_revision, baseTargetParentRevision: root.children_revision } });
    assert.equal(moved.statusCode, 422, moved.body);
    assert.equal(moved.json().error.code, 'invalid_document');
  });

  test('MCP create applies the same role-folder destination rules in preview and apply', async () => {
    const targetLibrary = await ensureLibraryCollection(createPostgresLibraryCollectionUnitOfWork(isolated.runtime.db), { principalId: owner.accountId, subjectId: owner.subjectId });
    const service = createPhase4bMcpLowRiskNodeCreateService({
      unitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      inspect: createPhase4bMcpLowRiskNodeCreateInspect(isolated.runtime.db),
    });
    const context = { accountSubjectId: owner.subjectId, scope: ['nodes:write'], binding: {
      kind: 'authenticated' as const, principalId: owner.accountId, clientId: 'library-agent',
      credentialBindingId: 'library-agent-key', resourceAudience: 'colp://known/collections', securityEpoch: '0',
    } };
    for (const dryRun of [false, true]) for (const parentId of [undefined, targetLibrary.rootNodeId]) {
      await assert.rejects(service.execute({ idempotencyKey: randomUUID(), expectedBaseRevisions: {}, input: { tool: 'nodes.create', collectionId: targetLibrary.id, ...(parentId ? { parentId } : {}),
        node: { kind: 'bookmark', title: 'Library bookmark', url: 'https://example.test/mcp', visibility: 'inherit', description: null, tags: [] },
        ...(dryRun ? { dryRun: true } : { confirmApply: true }),
      } }, context), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'parent_invalid');
    }
  });

  test('MCP node update refuses role-folder renaming in apply and preview', async () => {
    const service = createPhase4bMcpLowRiskNodeUpdateService({
      unitOfWork: createPostgresCanonicalMutationUnitOfWork(isolated.runtime.db),
      inspect: createPhase4bMcpLowRiskNodeCreateInspect(isolated.runtime.db),
    });
    const node = await isolated.runtime.db.selectFrom('nodes').selectAll().where('id', '=', library.bookmarksBarId).executeTakeFirstOrThrow();
    const context = { accountSubjectId: owner.subjectId, scope: ['nodes:write'], binding: {
      kind: 'authenticated' as const, principalId: owner.accountId, clientId: 'library-agent',
      credentialBindingId: 'library-agent-key', resourceAudience: 'colp://known/collections', securityEpoch: '0',
    } };
    for (const dryRun of [false, true]) await assert.rejects(service.execute({
      collectionId: library.id, nodeId: node.id, baseRevision: node.resource_revision,
      patch: { title: 'Renamed' }, ...(dryRun ? { dryRun: true } : {}),
    }, context), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'library_protected');
  });

  test('Product writes refuse library deletion, publication and role folder deletion, movement and renaming', async () => {
    const collection = await isolated.runtime.db.selectFrom('collections').selectAll().where('id', '=', library.id).executeTakeFirstOrThrow();
    const headers = { cookie: owner.cookie, origin: ORIGIN, 'x-csrf-token': owner.csrfToken };
    const request = async (method: 'PATCH' | 'DELETE' | 'POST', path: string, body?: unknown) => {
      const response = await app.inject({ method, url: `/api/v1/collections/${library.id}${path}`,
        headers: { ...headers, 'known-command-id': randomUUID(), 'if-match': '"'+collection.resource_revision+'"',
          ...(body === undefined ? {} : { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' }) },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error.code, 'library_protected');
    };
    await request('DELETE', '');
    for (const patch of [{ visibility: 'public', publicationSlug: 'library-published' },
      { visibility: 'private' }, { allowSearchIndexing: true }, { publicationSlug: 'library-slug' }]) await request('PATCH', '', patch);
    for (const nodeId of [library.bookmarksBarId, library.otherBookmarksId]) {
      await request('PATCH', `/nodes/${nodeId}`, { title: 'Renamed' });
      await request('DELETE', `/nodes/${nodeId}`);
      const root = await isolated.runtime.db.selectFrom('nodes').selectAll().where('id', '=', library.rootNodeId).executeTakeFirstOrThrow();
      await request('POST', `/nodes/${nodeId}/move`, { newParentId: library.rootNodeId,
        afterId: null, beforeId: null, baseSourceParentRevision: root.children_revision, baseTargetParentRevision: root.children_revision });
    }
  });
});

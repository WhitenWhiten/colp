import { createPostgresReportSourceInvalidationOutboxPort } from '../../../src/infrastructure/outbox/report-source-invalidation-producer.js';
/**
 * P1-03 Product trash bulk restore, subtree restore, and empty.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Manifest, Problem, SyncPushResult } from '@know-n/colp/types';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import { runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { createPostgresIdentityUnitOfWork } from '../../../src/infrastructure/identity/index.js';
import {
  createPostgresCanonicalMutationUnitOfWork,
  createPostgresCollectionsUnitOfWork,
} from '../../../src/infrastructure/collections/index.js';
import {
  createPostgresProductSyncCenterUnitOfWork,
  createPostgresReplicaStore,
  createPostgresSyncPushApplication,
  createPostgresSyncSessionIssuer,
  SyncTombstonePurgeFenceLostError,
} from '../../../src/infrastructure/sync/index.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import { encodeTrashDeletionId } from '../../../src/modules/sync/product-sync-trash.js';
import { purgeOwnedTrashInTransaction } from '../../../src/infrastructure/sync/sync-tombstone-user-purge-postgres.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import { createSyncSessionBlackBoxClient } from '../../support/sync-session-black-box-client.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const PRODUCT_ORIGIN = 'https://app.example.test';
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const EXTENSION_ISSUER = 'https://issuer.example/realms/known';
const AUTHORIZATION = 'Bearer KNS-P103-EXTENSION-AUTHORIZATION-MARKER';

interface ProductClient {
  readonly cookie: string; readonly csrf: string; readonly accountId: string;
  readonly subjectId: string; readonly identitySubject: string;
}

describeWithPostgres('P1-03 Product trash batch restore, subtree, and empty', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  const syncApps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p1_03_trash_batch', { maxConnections: 16 });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    factory = createPostgresBetterAuthTestFactory({ db: runtime.db });
    config = loadConfig({
      DATABASE_URL: isolated.databaseUrl, PRODUCT_ORIGIN, ALLOWED_ORIGINS: PRODUCT_ORIGIN,
      OIDC_ISSUER: 'https://issuer.example/realms/known', OIDC_CLIENT_ID: 'known-web',
      OIDC_REDIRECT_URI: `${PRODUCT_ORIGIN}/api/v1/auth/oidc/callback`,
      OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
      OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token', OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'p1-03-editor-cursor-secret', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    });
  }, 120_000);

  afterEach(async () => {
    await Promise.all(syncApps.splice(0).map(async (app) => { try { await app.close(); } catch { /* closed */ } }));
  });
  afterAll(async () => isolated?.close());

  function productApp() {
    const identity = createPostgresIdentityUnitOfWork(runtime.db, {
      oidcTransactionSecrets: config.oidcTransactionSecrets,
    });
    return buildApiApp({
      config, identityUnitOfWork: identity,
      collectionsUnitOfWork: createPostgresCollectionsUnitOfWork(runtime.db),
      productCollectionMutationUnitOfWork: createPostgresCanonicalMutationUnitOfWork(runtime.db),
      productSyncCenterUnitOfWork: createPostgresProductSyncCenterUnitOfWork(runtime.db, {
        cursorSecret: 'p1-03-product-sync-trash-cursor-secret-32b',
        reportSourceInvalidation: createPostgresReportSourceInvalidationOutboxPort(),
        conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] },
      }),
      browserSessionAuthority: factory.authority,
    });
  }

  async function login(subject: string): Promise<ProductClient> {
    const client = await issueTestSession({
      factory, subject, displayName: subject, handle: `p103_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    await runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
      [`p1-03-identity-${randomUUID()}`, client.accountId, EXTENSION_ISSUER, subject],
    );
    return { cookie: client.cookie, csrf: client.csrfToken,
      accountId: client.accountId, subjectId: client.subjectId, identitySubject: subject };
  }

  function mutation(client: ProductClient, commandId: string, contentType?: string) {
    return { cookie: client.cookie, origin: PRODUCT_ORIGIN, 'x-csrf-token': client.csrf,
      'known-command-id': commandId, ...(contentType ? { 'content-type': contentType } : {}) };
  }

  async function createCollection(api: ReturnType<typeof productApp>, owner: ProductClient, title: string) {
    const response = await api.inject({ method: 'POST', url: '/api/v1/collections',
      headers: mutation(owner, randomUUID(), 'application/json'),
      payload: { kind: 'bookmarks', title, summary: null } });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json() as { collection: { id: string }; root: { id: string } };
    return { collectionId: body.collection.id, rootId: body.root.id };
  }

  async function syncContext(owner: ProductClient, collectionId: string) {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension',
      subject: owner.identitySubject, credentialId: `p1-03-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(runtime.db, { ids: {
      deviceId: () => `p1-03-device-${suffix}`, replicaId: () => `p1-03-replica-${suffix}`,
      leaseId: () => `p1-03-lease-${suffix}`,
    } }).create({
      accountId: owner.accountId, collectionId, deviceName: 'P1-03 device', replicaName: 'P1-03 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `p1-03-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `p1-03-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: owner.accountId });
    const issuer = createPostgresSyncSessionIssuer(runtime.db, {
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 6), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `p1-03-session-${suffix}`, requestFingerprint: `p1-03-fingerprint-${suffix}`,
      collectionId, replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push', 'sync:pull'], origin: EXTENSION_ORIGIN,
    });
    return { credential, replica, issuer, session: issued.session, collectionId };
  }

  async function startPush(value: Awaited<ReturnType<typeof syncContext>>) {
    const app = Fastify({ logger: false });
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-update', allowedOrigins: [EXTENSION_ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(runtime.db, value.issuer),
      rateLimit: { maxRequests: 100, windowMs: 60_000 }, maxBatchOperations: 1,
      allowInsecureLoopback: true,
    });
    app.get('/.well-known/collection-protocol', async () => manifest(app));
    await app.listen({ host: '127.0.0.1', port: 0 });
    syncApps.push(app);
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('Sync test server did not listen');
    return createSyncSessionBlackBoxClient({
      manifestUrl: `http://127.0.0.1:${address.port}/.well-known/collection-protocol`,
      mountId: 'known-sync-entry', authorization: AUTHORIZATION, origin: EXTENSION_ORIGIN,
    });
  }

  function applied(body: Problem | SyncPushResult): SyncPushResult['results'][number] {
    assert.ok('results' in body, `expected SyncPushResult, got ${'code' in body ? body.code : 'unknown'}`);
    return body.results[0]!;
  }

  test('batch restore handles mixed ids, empty selection, replay, concealment, and subtree Recovered', async () => {
    const api = productApp();
    try {
      const owner = await login(`p1-03-owner-${randomUUID()}`);
      const outsider = await login(`p1-03-outsider-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'Batch trash');
      const ownerSync = await syncContext(owner, collectionId);
      const push = await startPush(ownerSync);
      let sequence = 1;
      async function pushOp(request: ReturnType<typeof syncNodeCreatePushRequest>) {
        const response = await push.push({ idempotencyKey: `p1-03-${randomUUID()}`, request });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return applied(response.body);
      }
      const first = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-a-${randomUUID()}`, parentId: rootId,
        node: { kind: 'bookmark', title: 'One', url: 'https://example.test/one' },
      }));
      const second = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-b-${randomUUID()}`, parentId: rootId,
        node: { kind: 'bookmark', title: 'Two', url: 'https://example.test/two' },
      }));
      const folder = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-folder-${randomUUID()}`, parentId: rootId,
        node: { kind: 'folder', title: 'Tree' },
      }));
      const child = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-child-${randomUUID()}`, parentId: folder.targetId,
        node: { kind: 'bookmark', title: 'Leaf', url: 'https://example.test/leaf' },
      }));
      const deletedFirst = await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-a-${randomUUID()}`,
        targetId: first.targetId, baseRevision: first.revision,
      }));
      const deletedSecond = await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-b-${randomUUID()}`,
        targetId: second.targetId, baseRevision: second.revision,
      }));
      await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-child-${randomUUID()}`,
        targetId: child.targetId, baseRevision: child.revision,
      }));
      const deletedFolder = await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-folder-${randomUUID()}`,
        targetId: folder.targetId, baseRevision: folder.revision, subtree: true,
      }));
      const tombstones = await runtime.pool.query<{ operation_id: string; target_id: string; delete_revision: string }>(
        `select operation_id, target_id, delete_revision from sync_node_tombstones
          where collection_id=$1 and payload_purged_at is null`, [collectionId]);
      const byTarget = new Map(tombstones.rows.map((row) => [row.target_id, row]));
      const firstId = encodeTrashDeletionId(byTarget.get(first.targetId)!.operation_id, first.targetId);
      const secondId = encodeTrashDeletionId(byTarget.get(second.targetId)!.operation_id, second.targetId);
      const folderId = encodeTrashDeletionId(byTarget.get(folder.targetId)!.operation_id, folder.targetId);
      const empty = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: mutation(owner, randomUUID(), 'application/json'),
        payload: { collectionId, items: [] },
      });
      assert.equal(empty.statusCode, 422);
      const mixedCommand = randomUUID();
      const mixed = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: mutation(owner, mixedCommand, 'application/json'),
        payload: { collectionId, items: [
          { deletionId: firstId, expectedRevision: deletedFirst.revision },
          { deletionId: secondId, expectedRevision: 'stale-revision' },
          { deletionId: 'not-a-real-deletion-id', expectedRevision: deletedSecond.revision },
        ] },
      });
      assert.equal(mixed.statusCode, 200, mixed.body);
      const mixedBody = mixed.json() as {
        results: Array<{ deletionId: string; outcome: string; nodeId?: string }>;
        summary: { applied: number; preconditionFailed: number; notFound: number };
      };
      assert.equal(mixedBody.summary.applied, 1);
      assert.equal(mixedBody.summary.preconditionFailed, 1);
      assert.equal(mixedBody.summary.notFound, 1);
      assert.equal(mixedBody.results.find((row) => row.deletionId === firstId)?.outcome, 'applied');
      assert.equal(mixedBody.results.find((row) => row.deletionId === firstId)?.nodeId, first.targetId);
      assert.equal(mixedBody.results.find((row) => row.deletionId === secondId)?.outcome, 'precondition_failed');
      const liveFirst = await runtime.pool.query<{ deleted_at: Date | null }>(
        'select deleted_at from nodes where id=$1', [first.targetId]);
      assert.equal(liveFirst.rows[0]?.deleted_at, null);
      const stillSecond = await runtime.pool.query<{ deleted_at: Date | null }>(
        'select deleted_at from nodes where id=$1', [second.targetId]);
      assert.notEqual(stillSecond.rows[0]?.deleted_at, null);
      const replay = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: mutation(owner, mixedCommand, 'application/json'),
        payload: { collectionId, items: [
          { deletionId: firstId, expectedRevision: deletedFirst.revision },
          { deletionId: secondId, expectedRevision: 'stale-revision' },
          { deletionId: 'not-a-real-deletion-id', expectedRevision: deletedSecond.revision },
        ] },
      });
      assert.equal(replay.statusCode, 200);
      assert.deepEqual(replay.json().summary, mixedBody.summary);
      const restoreEvents = await runtime.db.selectFrom('outbox_events').select('outbox_id')
        .where('aggregate_id', '=', first.targetId!).where('event_type', '=', 'node.restored').execute();
      assert.equal(restoreEvents.length, 1, 'Product restore and replay append one canonical restoration event');
      const reportEvents = await runtime.pool.query(`SELECT outbox_id FROM outbox_events
        WHERE aggregate_scope=$1 AND payload_json->>'sourceEventType'='node.restored'`, [collectionId]);
      assert.equal(reportEvents.rowCount, 1, 'Product restore forwards report invalidation');
      const reused = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: mutation(owner, mixedCommand, 'application/json'),
        payload: { collectionId, items: [
          { deletionId: firstId, expectedRevision: deletedFirst.revision },
        ] },
      });
      assert.equal(reused.statusCode, 409);
      assert.equal(reused.json().error.code, 'command_id_reused');
      const hidden = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: mutation(outsider, randomUUID(), 'application/json'),
        payload: { collectionId, items: [
          { deletionId: secondId, expectedRevision: deletedSecond.revision },
        ] },
      });
      assert.equal(hidden.statusCode, 404);
      assert.equal(hidden.json().error.code, 'resource_not_found');
      const concealedItem = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/restore-batch',
        headers: mutation(owner, randomUUID(), 'application/json'),
        payload: { collectionId, items: [
          { deletionId: encodeTrashDeletionId('op-other', 'node-other'), expectedRevision: 'r1' },
        ] },
      });
      assert.equal(concealedItem.statusCode, 200);
      assert.equal(concealedItem.json().results[0]?.outcome, 'not_found');
      const tree = await api.inject({
        method: 'POST', url: `/api/v1/sync/trash/${folderId}/restore-subtree`,
        headers: { ...mutation(owner, randomUUID()), 'if-match': `"${deletedFolder.revision}"` },
      });
      assert.equal(tree.statusCode, 200, tree.body);
      const treeBody = tree.json() as { results: Array<{ deletionId: string; outcome: string; nodeId?: string; parentId?: string }> };
      assert.equal(treeBody.results[0]?.nodeId, folder.targetId);
      assert.equal(treeBody.results[0]?.outcome, 'applied');
      const childResult = treeBody.results.find((row) => row.nodeId === child.targetId);
      assert.equal(childResult?.outcome, 'applied');
      const placed = await runtime.pool.query<{ parent_id: string; folder_role: string | null }>(
        `select node.parent_id, parent.folder_role from nodes node
           join nodes parent on parent.id=node.parent_id where node.id=$1`, [child.targetId]);
      assert.equal(placed.rows[0]?.folder_role, null);
      assert.equal(placed.rows[0]?.parent_id, folder.targetId);
      const parentGone = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-gone-${randomUUID()}`, parentId: rootId,
        node: { kind: 'folder', title: 'Gone parent' },
      }));
      const nested = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-nested-${randomUUID()}`, parentId: parentGone.targetId,
        node: { kind: 'folder', title: 'Nested' },
      }));
      const nestedChild = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-nested-child-${randomUUID()}`, parentId: nested.targetId,
        node: { kind: 'bookmark', title: 'Nested leaf', url: 'https://example.test/nested' },
      }));
      await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-nested-child-${randomUUID()}`,
        targetId: nestedChild.targetId, baseRevision: nestedChild.revision,
      }));
      const deletedNested = await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-nested-${randomUUID()}`,
        targetId: nested.targetId, baseRevision: nested.revision, subtree: true,
      }));
      await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-gone-${randomUUID()}`,
        targetId: parentGone.targetId, baseRevision: parentGone.revision, subtree: true,
      }));
      const nestedTombstone = await runtime.pool.query<{ operation_id: string; delete_revision: string }>(
        `select operation_id, delete_revision from sync_node_tombstones
          where collection_id=$1 and target_id=$2`, [collectionId, nested.targetId]);
      const nestedId = encodeTrashDeletionId(nestedTombstone.rows[0]!.operation_id, nested.targetId);
      const recoveredTree = await api.inject({
        method: 'POST', url: `/api/v1/sync/trash/${nestedId}/restore-subtree`,
        headers: { ...mutation(owner, randomUUID()), 'if-match': `"${deletedNested.revision}"` },
      });
      assert.equal(recoveredTree.statusCode, 200, recoveredTree.body);
      const recoveredParent = await runtime.pool.query<{ folder_role: string | null }>(
        `select parent.folder_role from nodes node
           join nodes parent on parent.id=node.parent_id where node.id=$1`, [nested.targetId]);
      assert.equal(recoveredParent.rows[0]?.folder_role, 'recovered');
      const recoveredChild = await runtime.pool.query<{ parent_id: string }>(
        'select parent_id from nodes where id=$1', [nestedChild.targetId]);
      assert.equal(recoveredChild.rows[0]?.parent_id, nested.targetId);
      const single = await api.inject({
        method: 'POST', url: `/api/v1/sync/trash/${secondId}/restore`,
        headers: { ...mutation(owner, randomUUID()), 'if-match': `"${deletedSecond.revision}"` },
      });
      assert.equal(single.statusCode, 200);
      assert.equal(single.json().nodeId, second.targetId);
    } finally { await api.close(); }
  }, 60_000);

  test('empty skips retention and unacked replicas, and a lost fence rolls back', async () => {
    const api = productApp();
    try {
      const owner = await login(`p1-03-empty-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'Empty trash');
      const ownerSync = await syncContext(owner, collectionId);
      const push = await startPush(ownerSync);
      let sequence = 1;
      async function pushOp(request: ReturnType<typeof syncNodeCreatePushRequest>) {
        const response = await push.push({ idempotencyKey: `p1-03-${randomUUID()}`, request });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return applied(response.body);
      }
      const bookmark = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-keep-${randomUUID()}`, parentId: rootId,
        node: { kind: 'bookmark', title: 'Kept', url: 'https://example.test/kept' },
      }));
      await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-keep-${randomUUID()}`,
        targetId: bookmark.targetId, baseRevision: bookmark.revision,
      }));
      const count = await runtime.pool.query<{ count: string }>(
        `select count(*)::text as count from sync_node_tombstones
          where collection_id=$1 and payload_purged_at is null`, [collectionId]);
      const expectedCount = Number(count.rows[0]?.count);
      const skipped = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/empty',
        headers: mutation(owner, randomUUID(), 'application/json'),
        payload: { collectionId, expectedCount, confirmation: 'permanently_delete' },
      });
      assert.equal(skipped.statusCode, 200, skipped.body);
      const skippedBody = skipped.json() as {
        results: Array<{ outcome: string; reason?: string }>; summary: { purged: number; skipped: number };
      };
      assert.equal(skippedBody.summary.purged, 0);
      assert.ok(skippedBody.summary.skipped >= 1);
      assert.ok(skippedBody.results.every((row) => row.outcome === 'skipped'));
      assert.ok(skippedBody.results.some((row) => row.reason === 'retention_window' || row.reason === 'replica_checkpoint'));
      const still = await runtime.pool.query<{ payload_purged_at: Date | null; purge_after: Date }>(
        'select payload_purged_at, purge_after from sync_node_tombstones where collection_id=$1 and target_id=$2',
        [collectionId, bookmark.targetId]);
      assert.equal(still.rows[0]?.payload_purged_at, null);
      const missingConfirm = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/empty',
        headers: mutation(owner, randomUUID(), 'application/json'),
        payload: { collectionId, expectedCount },
      });
      assert.equal(missingConfirm.statusCode, 422);
      const mismatch = await api.inject({
        method: 'POST', url: '/api/v1/sync/trash/empty',
        headers: mutation(owner, randomUUID(), 'application/json'),
        payload: { collectionId, expectedCount: expectedCount + 1, confirmation: 'permanently_delete' },
      });
      assert.equal(mismatch.statusCode, 412);
      const afterRetention = new Date(still.rows[0]!.purge_after.getTime() + 1_000);
      const unacked = await createUnitOfWork(runtime.db).execute(async ({ transaction }) =>
        purgeOwnedTrashInTransaction(transaction, {
          collectionId, workerId: `p1-03-unacked-${randomUUID()}`, leaseDurationMs: 30_000,
          now: afterRetention,
        }));
      assert.equal(unacked.results.every((row) => row.outcome === 'skipped'), true);
      assert.ok(unacked.results.some((row) => row.reason === 'replica_checkpoint'));
      await runtime.pool.query(
        `update sync_replicas
            set status='expired',
                wire_json = jsonb_set(wire_json, '{status}', '"expired"')
          where collection_id=$1 and status='active'`,
        [collectionId]);
      await assert.rejects(
        () => createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
          await purgeOwnedTrashInTransaction(transaction, {
            collectionId, workerId: `p1-03-fault-${randomUUID()}`, leaseDurationMs: 30_000,
            now: afterRetention,
            async faultAfterGroup() { throw new SyncTombstonePurgeFenceLostError(); },
          });
        }),
        (error: unknown) => error instanceof SyncTombstonePurgeFenceLostError,
      );
      const afterFault = await runtime.pool.query<{ payload_purged_at: Date | null }>(
        'select payload_purged_at from sync_node_tombstones where collection_id=$1 and target_id=$2',
        [collectionId, bookmark.targetId]);
      assert.equal(afterFault.rows[0]?.payload_purged_at, null);
      const purged = await createUnitOfWork(runtime.db).execute(async ({ transaction }) =>
        purgeOwnedTrashInTransaction(transaction, {
          collectionId, workerId: `p1-03-purge-${randomUUID()}`, leaseDurationMs: 30_000,
          now: afterRetention,
        }));
      assert.equal(purged.results.filter((row) => row.outcome === 'purged').length, 1);
      const compacted = await runtime.pool.query<{ payload_purged_at: Date | null }>(
        'select payload_purged_at from sync_node_tombstones where collection_id=$1 and target_id=$2',
        [collectionId, bookmark.targetId]);
      assert.equal(compacted.rows[0]?.payload_purged_at instanceof Date, true);
      const node = await runtime.pool.query<{ id: string }>(
        'select id from nodes where id=$1', [bookmark.targetId]);
      assert.equal(node.rows.length, 1);
    } finally { await api.close(); }
  }, 60_000);
});

function manifest(app: FastifyInstance): Manifest {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Sync test server did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  return { protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019fa766-5706-7413-8a21-afb8ccebcd84', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncPush: `${origin}/private-entry/canonical-update` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
  } as Manifest;
}

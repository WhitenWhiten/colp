/**
 * Owner: KNS-08 (QA). Fixture: see Known-Extension/e2e/kns-08-ids.ts.
 * Run: see Known-Extension/e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
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
} from '../../../src/infrastructure/sync/index.js';
import { NODE_DELETION_PURGE_RETENTION_MS } from '../../../src/modules/collections/index.js';
import { encodeTrashDeletionId } from '../../../src/modules/sync/product-sync-trash.js';
import { createPostgresBetterAuthTestFactory, issueTestSession } from '../../support/better-auth-test-factory.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { registerSyncPushRoutes } from '../../../src/transport/colp-sync/sync-push-routes.js';
import { syncNodeCreatePushRequest } from '../../fixtures/phase3/sync-push-admission.js';
import { syncNodeDeletePushRequest } from '../../fixtures/phase3/sync-node-delete.js';
import { syncNodeRestorePushRequest } from '../../fixtures/phase3/sync-node-restore.js';
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
const AUTHORIZATION = 'Bearer KNS-06-EXTENSION-AUTHORIZATION-MARKER';

interface ProductClient {
  readonly cookie: string; readonly csrf: string; readonly accountId: string;
  readonly subjectId: string; readonly identitySubject: string;
}

describeWithPostgres('KNS-06 mount uniqueness, restore, and Product trash', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;
  let config: AppConfig;
  let factory: ReturnType<typeof createPostgresBetterAuthTestFactory>;
  const syncApps: FastifyInstance[] = [];

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('kns_06_mount_restore_trash', { maxConnections: 16 });
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
      PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'kns-06-editor-cursor-secret', NODE_ENV: 'test', LOG_LEVEL: 'silent',
    });
  }, 120_000);

  afterEach(async () => {
    await Promise.all(syncApps.splice(0).map(async (app) => { try { await app.close(); } catch { /* already closed */ } }));
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
        cursorSecret: 'kns-06-product-sync-trash-cursor-secret-32b',
        conflictPayloadKeyring: { active: { key: Buffer.alloc(32, 71), keyVersion: 7 }, retained: [] },
      }),
      browserSessionAuthority: factory.authority,
    });
  }

  async function login(subject: string): Promise<ProductClient> {
    const client = await issueTestSession({
      factory, subject, displayName: subject, handle: `kns06_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    });
    await runtime.pool.query(
      `insert into account_identities (id, account_id, issuer, subject) values ($1, $2, $3, $4)`,
      [`kns-06-identity-${randomUUID()}`, client.accountId, EXTENSION_ISSUER, subject],
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
      subject: owner.identitySubject, credentialId: `kns-06-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(runtime.db, { ids: {
      deviceId: () => `kns-06-device-${suffix}`, replicaId: () => `kns-06-replica-${suffix}`,
      leaseId: () => `kns-06-lease-${suffix}`,
    } }).create({
      accountId: owner.accountId, collectionId, deviceName: 'KNS-06 device', replicaName: 'KNS-06 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true,
        alias: false, annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `kns-06-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `kns-06-generation-${suffix}` }, leaseDurationSeconds: 3_600,
    }, { actorAccountId: owner.accountId });
    const issuer = createPostgresSyncSessionIssuer(runtime.db, {
      issuer: EXTENSION_ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 6), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `kns-06-session-${suffix}`, requestFingerprint: `kns-06-fingerprint-${suffix}`,
      collectionId, replicaId: replica.replicaId, expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision, binding: replica.binding,
      requestedScopes: ['sync:push', 'sync:pull'], origin: EXTENSION_ORIGIN,
    });
    return { credential, replica, issuer, session: issued.session, collectionId };
  }

  async function startPush(value: Awaited<ReturnType<typeof syncContext>>, nodeId?: () => string) {
    const app = Fastify({ logger: false });
    registerSyncPushRoutes(app, {
      path: '/private-entry/canonical-update', allowedOrigins: [EXTENSION_ORIGIN],
      credentialVerifier: { async verify({ authorization }) {
        if (authorization !== AUTHORIZATION) throw new Error('invalid credential');
        return value.credential;
      } },
      application: createPostgresSyncPushApplication(runtime.db, value.issuer, {
        ...(nodeId ? { nodeId } : {}),
      }),
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

  test('concurrent same-role mount creates rebase onto one live nodeId', async () => {
    const api = productApp();
    try {
      const owner = await login(`kns-06-mount-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'Mount uniqueness');
      const first = await syncContext(owner, collectionId);
      const second = await syncContext(owner, collectionId);
      const firstPush = await startPush(first, () => 'mount-bar-live');
      const secondPush = await startPush(second, () => 'mount-bar-lost');
      const [firstReceipt, secondReceipt] = await Promise.all([
        firstPush.push({
          idempotencyKey: `kns-06-mount-a-${randomUUID()}`,
          request: syncNodeCreatePushRequest({
            sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
            collectionId, sequence: 1, opId: `op-mount-a-${randomUUID()}`, parentId: rootId,
            node: { kind: 'folder', title: 'Bar A', folderRole: 'bookmarks-bar' },
          }),
        }),
        secondPush.push({
          idempotencyKey: `kns-06-mount-b-${randomUUID()}`,
          request: syncNodeCreatePushRequest({
            sessionId: second.session.sessionId, replicaId: second.replica.replicaId,
            collectionId, sequence: 1, opId: `op-mount-b-${randomUUID()}`, parentId: rootId,
            node: { kind: 'folder', title: 'Bar B', folderRole: 'bookmarks-bar' },
          }),
        }),
      ]);
      assert.equal(firstReceipt.status, 200, JSON.stringify(firstReceipt.body));
      assert.equal(secondReceipt.status, 200, JSON.stringify(secondReceipt.body));
      const receipts = [applied(firstReceipt.body), applied(secondReceipt.body)];
      const winner = receipts.find((row) => row.status === 'applied');
      const loser = receipts.find((row) => row.status === 'rebased');
      assert.ok(winner); assert.ok(loser);
      assert.equal(loser.targetId, winner.targetId);
      assert.equal(loser.warnings.some((warning) => warning.code === 'invalid_node_constraints'), true);
      const live = await runtime.pool.query<{ id: string }>(
        `select id from nodes where collection_id=$1 and folder_role='bookmarks-bar' and deleted_at is null`,
        [collectionId]);
      assert.equal(live.rows.length, 1);
      assert.equal(live.rows[0]?.id, winner.targetId);
    } finally { await api.close(); }
  }, 60_000);

  test('Push restore keeps original id, Product restore emits node_restored, missing parent recovers, purged is 410', async () => {
    const api = productApp();
    try {
      const owner = await login(`kns-06-restore-${randomUUID()}`);
      const outsider = await login(`kns-06-outsider-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'Restore trash');
      const ownerSync = await syncContext(owner, collectionId);
      const push = await startPush(ownerSync);
      let sequence = 1;
      async function pushOp(request: ReturnType<typeof syncNodeCreatePushRequest>) {
        const response = await push.push({ idempotencyKey: `kns-06-${randomUUID()}`, request });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return applied(response.body);
      }
      const bookmark = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-bm-${randomUUID()}`, parentId: rootId,
        node: { kind: 'bookmark', title: 'Keep id', url: 'https://example.test/keep' },
      }));
      const folder = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-folder-${randomUUID()}`, parentId: rootId,
        node: { kind: 'folder', title: 'Parent' },
      }));
      const orphan = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-orphan-${randomUUID()}`, parentId: folder.targetId,
        node: { kind: 'bookmark', title: 'Orphan', url: 'https://example.test/orphan' },
      }));
      const productBookmark = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-product-${randomUUID()}`, parentId: rootId,
        node: { kind: 'bookmark', title: 'Product restore', url: 'https://example.test/product' },
      }));
      const purgedBookmark = await pushOp(syncNodeCreatePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-purged-${randomUUID()}`, parentId: rootId,
        node: { kind: 'bookmark', title: 'Purged', url: 'https://example.test/purged' },
      }));
      const deleted = await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-${randomUUID()}`,
        targetId: bookmark.targetId, baseRevision: bookmark.revision,
      }));
      const restored = await pushOp(syncNodeRestorePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-restore-${randomUUID()}`,
        targetId: bookmark.targetId, baseRevision: deleted.revision, reason: 'restore',
      }));
      assert.equal(restored.status, 'applied');
      assert.equal(restored.targetId, bookmark.targetId);
      const afterPush = await runtime.pool.query<{ deleted_at: Date | null; parent_id: string }>(
        'select deleted_at, parent_id from nodes where id=$1', [bookmark.targetId]);
      assert.equal(afterPush.rows[0]?.deleted_at, null);
      const tombstones = await runtime.pool.query(
        'select 1 from sync_node_tombstones where target_id=$1', [bookmark.targetId]);
      assert.equal(tombstones.rowCount, 0);
      const pushEffect = await runtime.pool.query<{ kind: string }>(
        `select effect_json->>'kind' as kind from sync_operation_effects
          where collection_id=$1 order by commit_ordinal desc limit 1`, [collectionId]);
      assert.equal(pushEffect.rows[0]?.kind, 'node_restored');

      await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-orphan-${randomUUID()}`,
        targetId: orphan.targetId, baseRevision: orphan.revision,
      }));
      const orphanTombstone = await runtime.pool.query<{ delete_revision: string }>(
        'select delete_revision from sync_node_tombstones where target_id=$1', [orphan.targetId]);
      await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-folder-${randomUUID()}`,
        targetId: folder.targetId, baseRevision: folder.revision,
      }));
      const restoreOpId = `op-restore-orphan-${randomUUID()}`;
      const restoreSequence = sequence;
      const recovered = await pushOp(syncNodeRestorePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: restoreOpId,
        targetId: orphan.targetId, baseRevision: orphanTombstone.rows[0]!.delete_revision, reason: 'restore',
      }));
      assert.equal(recovered.targetId, orphan.targetId);
      const placed = await runtime.pool.query<{ parent_id: string; folder_role: string | null }>(
        `select node.parent_id, parent.folder_role
           from nodes node join nodes parent on parent.id=node.parent_id
          where node.id=$1`, [orphan.targetId]);
      assert.equal(placed.rows[0]?.folder_role, 'recovered');
      const pair = await runtime.pool.query<{
        kind: string; ordinal: string; op_id: string; replica: string; seq: string;
      }>(
        `select effect.effect_json->>'kind' as kind, effect.commit_ordinal::text as ordinal,
                effect.operation_id as op_id, effect.origin_replica_id as replica,
                effect.origin_sequence::text as seq
           from sync_operation_effects effect
          where effect.collection_id=$1
            and effect.effect_json->>'kind' in ('node_created','node_restored')
            and effect.commit_ordinal >= (
              select min(commit_ordinal) from sync_operation_effects
               where collection_id=$1 and operation_id=$2) - 1
          order by effect.commit_ordinal`,
        [collectionId, restoreOpId],
      );
      const created = pair.rows.find((row) => row.kind === 'node_created');
      const orphanRestored = pair.rows.find((row) => row.kind === 'node_restored' && row.op_id === restoreOpId);
      assert.ok(created);
      assert.ok(orphanRestored);
      assert.ok(BigInt(created.ordinal) + 1n === BigInt(orphanRestored.ordinal));
      assert.notEqual(created.op_id, restoreOpId);
      assert.notEqual(created.replica, ownerSync.replica.replicaId);
      assert.equal(orphanRestored.replica, ownerSync.replica.replicaId);
      assert.equal(orphanRestored.seq, String(restoreSequence));
      const replicaStatus = await runtime.pool.query<{ status: string }>(
        'select status from sync_replicas where replica_id=$1', [ownerSync.replica.replicaId]);
      assert.equal(replicaStatus.rows[0]?.status, 'active');

      const deletedProduct = await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-product-${randomUUID()}`,
        targetId: productBookmark.targetId, baseRevision: productBookmark.revision,
      }));
      const tombstone = await runtime.pool.query<{ operation_id: string; deleted_at: Date; purge_after: Date }>(
        `select operation_id, deleted_at, purge_after from sync_node_tombstones
          where collection_id=$1 and target_id=$2`, [collectionId, productBookmark.targetId]);
      assert.equal(tombstone.rows.length, 1);
      const retentionMs = tombstone.rows[0]!.purge_after.getTime() - tombstone.rows[0]!.deleted_at.getTime();
      assert.ok(retentionMs >= NODE_DELETION_PURGE_RETENTION_MS);
      const deletionId = encodeTrashDeletionId(tombstone.rows[0]!.operation_id, productBookmark.targetId);
      const hidden = await api.inject({ method: 'GET', url: `/api/v1/sync/trash?collectionId=${collectionId}`,
        headers: { cookie: outsider.cookie } });
      assert.equal(hidden.statusCode, 404);
      assert.equal(hidden.json().error.code, 'resource_not_found');
      const hiddenDetail = await api.inject({
        method: 'GET', url: `/api/v1/sync/trash/${deletionId}`, headers: { cookie: outsider.cookie },
      });
      const missingDetail = await api.inject({
        method: 'GET', url: '/api/v1/sync/trash/not-a-real-deletion-id', headers: { cookie: owner.cookie },
      });
      assert.equal(hiddenDetail.statusCode, 404);
      assert.equal(missingDetail.statusCode, 404);
      assert.equal(hiddenDetail.json().error.code, 'resource_not_found');
      assert.equal(missingDetail.json().error.code, 'resource_not_found');
      assert.equal(hiddenDetail.json().error.message, missingDetail.json().error.message);
      assert.equal(hidden.json().error.message, hiddenDetail.json().error.message);
      const list = await api.inject({ method: 'GET', url: `/api/v1/sync/trash?collectionId=${collectionId}`,
        headers: { cookie: owner.cookie } });
      assert.equal(list.statusCode, 200, list.body);
      const items = list.json() as { items: Array<{ deletionId: string; url?: string; originalParentId: string | null }> };
      assert.equal(items.items.some((item) => item.deletionId === deletionId), true);
      assert.equal(items.items.every((item) => item.url === undefined), true);
      const detail = await api.inject({
        method: 'GET', url: `/api/v1/sync/trash/${deletionId}`, headers: { cookie: owner.cookie },
      });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(typeof detail.json().url, 'string');
      const productRestore = await api.inject({
        method: 'POST', url: `/api/v1/sync/trash/${deletionId}/restore`,
        headers: { ...mutation(owner, randomUUID()), 'if-match': `"${deletedProduct.revision}"` },
      });
      assert.equal(productRestore.statusCode, 200, productRestore.body);
      assert.equal(productRestore.json().nodeId, productBookmark.targetId);
      const productEffect = await runtime.pool.query<{ kind: string }>(
        // SD-02 routed product restore through the canonical mutation writer, so
        // the operation type is now the canonical `resource.<action>` form
        // (canonical-mutation.ts). The authoritative effect still carries
        // kind=node_restored.
        `select effect_json->>'kind' as kind from sync_operation_effects
          where collection_id=$1 and operation_id=(
            select operation_id from operations where collection_id=$1 and operation_type='resource.restore'
            order by commit_ordinal desc limit 1)`, [collectionId]);
      assert.equal(productEffect.rows[0]?.kind, 'node_restored');

      await pushOp(syncNodeDeletePushRequest({
        sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-purged-${randomUUID()}`,
        targetId: purgedBookmark.targetId, baseRevision: purgedBookmark.revision,
      }));
      await runtime.pool.query(`
        update sync_node_tombstones
           set payload_json = jsonb_set(payload_json, '{extensions}', '{}'::jsonb, true),
               payload_purged_at = now(), purge_state_revision = 1
         where collection_id = $1 and target_id = $2 and payload_purged_at is null`,
      [collectionId, purgedBookmark.targetId]);
      const purgedPush = await push.push({
        idempotencyKey: `kns-06-purged-${randomUUID()}`,
        request: syncNodeRestorePushRequest({
          sessionId: ownerSync.session.sessionId, replicaId: ownerSync.replica.replicaId,
          collectionId, sequence: sequence++, opId: `op-restore-purged-${randomUUID()}`,
          targetId: purgedBookmark.targetId, baseRevision: purgedBookmark.revision, reason: 'restore',
        }),
      });
      assert.ok('code' in purgedPush.body);
      assert.equal(purgedPush.body.code, 'resource_purged');
      const purgedTombstone = await runtime.pool.query<{ operation_id: string; delete_revision: string }>(
        `select operation_id, delete_revision from sync_node_tombstones
          where collection_id=$1 and target_id=$2`, [collectionId, purgedBookmark.targetId]);
      const purgedDeletionId = encodeTrashDeletionId(
        purgedTombstone.rows[0]!.operation_id, purgedBookmark.targetId,
      );
      const purgedProduct = await api.inject({
        method: 'POST', url: `/api/v1/sync/trash/${purgedDeletionId}/restore`,
        headers: {
          ...mutation(owner, randomUUID()),
          'if-match': `"${purgedTombstone.rows[0]!.delete_revision}"`,
        },
      });
      assert.equal(purgedProduct.statusCode, 410);
      assert.equal(purgedProduct.json().error.code, 'resource_purged');
    } finally { await api.close(); }
  }, 60_000);

  test('FRR-05-A: orphan restores land under each original mount including custom', async () => {
    const api = productApp();
    try {
      const owner = await login(`frr-05-restore-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'FRR-05 mounts');
      const ctx = await syncContext(owner, collectionId);
      const push = await startPush(ctx);
      let sequence = 1;
      const base = () => ({ sessionId: ctx.session.sessionId, replicaId: ctx.replica.replicaId,
        collectionId, sequence: sequence++, opId: `frr05-${randomUUID()}` });
      async function apply(request: ReturnType<typeof syncNodeCreatePushRequest>) {
        const response = await push.push({ idempotencyKey: `frr05-${randomUUID()}`, request });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const receipt = applied(response.body); assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
        return receipt;
      }
      const observations: { role: string; restoredUnderOriginalMount: boolean }[] = [];
      const recoveredIds = new Set<string>();
      for (const role of ['bookmarks-bar', 'other-bookmarks', 'custom'] as const) {
        const mount = await apply(syncNodeCreatePushRequest({ ...base(), parentId: rootId,
          node: { kind: 'folder', title: role, folderRole: role } }));
        const folder = await apply(syncNodeCreatePushRequest({ ...base(), parentId: mount.targetId,
          node: { kind: 'folder', title: 'Original parent' } }));
        const child = await apply(syncNodeCreatePushRequest({ ...base(), parentId: folder.targetId,
          node: { kind: 'bookmark', title: 'Restore me', url: 'https://example.test/frr05' } }));
        const deleted = await apply(syncNodeDeletePushRequest({ ...base(), targetId: child.targetId,
          baseRevision: child.revision }));
        await apply(syncNodeDeletePushRequest({ ...base(), targetId: folder.targetId, baseRevision: folder.revision }));
        await apply(syncNodeRestorePushRequest({ ...base(), targetId: child.targetId,
          baseRevision: deleted.revision, reason: 'restore' }));
        const result = await runtime.pool.query<{ parent_id: string; recovered_id: string }>(
          `select recovered.parent_id, recovered.id as recovered_id from nodes child
           join nodes recovered on recovered.id=child.parent_id where child.id=$1`, [child.targetId]);
        recoveredIds.add(result.rows[0]!.recovered_id);
        observations.push({ role, restoredUnderOriginalMount: result.rows[0]!.parent_id === mount.targetId });
      }
      assert.deepEqual(observations, [
        { role: 'bookmarks-bar', restoredUnderOriginalMount: true },
        { role: 'other-bookmarks', restoredUnderOriginalMount: true },
        { role: 'custom', restoredUnderOriginalMount: true },
      ]);
      assert.equal(recoveredIds.size, 3);
    } finally { await api.close(); }
  }, 60_000);

  test('FRR-05-B: recovered create is unique per parent and falls back to Collection root', async () => {
    const api = productApp();
    try {
      const owner = await login(`frr-05-create-${randomUUID()}`);
      const { collectionId, rootId } = await createCollection(api, owner, 'FRR-05 create');
      const first = await syncContext(owner, collectionId);
      const second = await syncContext(owner, collectionId);
      const firstPush = await startPush(first);
      const secondPush = await startPush(second);
      let sequence = 1;
      async function applyFirst(request: ReturnType<typeof syncNodeCreatePushRequest>) {
        const response = await firstPush.push({ idempotencyKey: `frr05-${randomUUID()}`, request });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const receipt = applied(response.body);
        assert.equal(receipt.status, 'applied', JSON.stringify(receipt));
        return receipt;
      }
      const bar = await applyFirst(syncNodeCreatePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-bar-${randomUUID()}`, parentId: rootId,
        node: { kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar' },
      }));
      const other = await applyFirst(syncNodeCreatePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-other-${randomUUID()}`, parentId: rootId,
        node: { kind: 'folder', title: 'Other', folderRole: 'other-bookmarks' },
      }));
      const mobile = await applyFirst(syncNodeCreatePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-mobile-${randomUUID()}`, parentId: rootId,
        node: { kind: 'folder', title: 'Mobile', folderRole: 'mobile-bookmarks' },
      }));
      const ordinary = await applyFirst(syncNodeCreatePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-folder-${randomUUID()}`, parentId: rootId,
        node: { kind: 'folder', title: 'Ordinary' },
      }));
      const [left, right] = await Promise.all([
        firstPush.push({
          idempotencyKey: `frr05-rec-a-${randomUUID()}`,
          request: syncNodeCreatePushRequest({
            sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
            collectionId, sequence: sequence++, opId: `op-rec-a-${randomUUID()}`, parentId: bar.targetId,
            node: { kind: 'folder', title: 'Recovered', folderRole: 'recovered' },
          }),
        }),
        secondPush.push({
          idempotencyKey: `frr05-rec-b-${randomUUID()}`,
          request: syncNodeCreatePushRequest({
            sessionId: second.session.sessionId, replicaId: second.replica.replicaId,
            collectionId, sequence: 1, opId: `op-rec-b-${randomUUID()}`, parentId: bar.targetId,
            node: { kind: 'folder', title: 'Recovered', folderRole: 'recovered' },
          }),
        }),
      ]);
      assert.equal(left.status, 200, JSON.stringify(left.body));
      assert.equal(right.status, 200, JSON.stringify(right.body));
      const receipts = [applied(left.body), applied(right.body)];
      const winner = receipts.find((row) => row.status === 'applied');
      const loser = receipts.find((row) => row.status === 'rebased');
      assert.ok(winner); assert.ok(loser);
      assert.equal(loser.targetId, winner.targetId);
      assert.equal(loser.warnings.some((warning) => warning.code === 'invalid_node_constraints'), true);
      const otherRecovered = await applyFirst(syncNodeCreatePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-rec-other-${randomUUID()}`, parentId: other.targetId,
        node: { kind: 'folder', title: 'Recovered', folderRole: 'recovered' },
      }));
      assert.equal(otherRecovered.status, 'applied');
      assert.notEqual(otherRecovered.targetId, winner.targetId);
      const nested = await firstPush.push({
        idempotencyKey: `frr05-nested-${randomUUID()}`,
        request: syncNodeCreatePushRequest({
          sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
          collectionId, sequence, opId: `op-nested-${randomUUID()}`, parentId: ordinary.targetId,
          node: { kind: 'folder', title: 'Recovered', folderRole: 'recovered' },
        }),
      });
      assert.ok('code' in nested.body);
      assert.equal(nested.body.code, 'invalid_document');
      const folder = await applyFirst(syncNodeCreatePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-gone-folder-${randomUUID()}`, parentId: mobile.targetId,
        node: { kind: 'folder', title: 'Gone parent' },
      }));
      const orphan = await applyFirst(syncNodeCreatePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-gone-child-${randomUUID()}`, parentId: folder.targetId,
        node: { kind: 'bookmark', title: 'Orphan', url: 'https://example.test/gone' },
      }));
      const deletedOrphan = await applyFirst(syncNodeDeletePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-orphan-${randomUUID()}`,
        targetId: orphan.targetId, baseRevision: orphan.revision,
      }));
      await applyFirst(syncNodeDeletePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-folder-${randomUUID()}`,
        targetId: folder.targetId, baseRevision: folder.revision,
      }));
      await applyFirst(syncNodeDeletePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-del-mount-${randomUUID()}`,
        targetId: mobile.targetId, baseRevision: mobile.revision,
      }));
      await applyFirst(syncNodeRestorePushRequest({
        sessionId: first.session.sessionId, replicaId: first.replica.replicaId,
        collectionId, sequence: sequence++, opId: `op-restore-root-${randomUUID()}`,
        targetId: orphan.targetId, baseRevision: deletedOrphan.revision, reason: 'restore',
      }));
      const fallback = await runtime.pool.query<{ parent_id: string; folder_role: string | null }>(
        `select recovered.parent_id, recovered.folder_role from nodes child
         join nodes recovered on recovered.id=child.parent_id where child.id=$1`, [orphan.targetId]);
      assert.equal(fallback.rows[0]?.folder_role, 'recovered');
      assert.equal(fallback.rows[0]?.parent_id, rootId);
    } finally { await api.close(); }
  }, 60_000);
});

function manifest(app: FastifyInstance): Manifest {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Sync test server did not listen');
  const origin = `http://127.0.0.1:${address.port}`;
  return { protocol: 'https://know-n.com/colp/spec/0.1', protocolVersions: ['0.1'],
    serverId: `${origin}/`, serverUuid: '019fa766-5706-7413-8a21-afb8ccebcd83', title: 'Known',
    mounts: [{ id: 'known-sync-entry', baseUrl: `${origin}/private-entry/`, profiles: ['core'],
      endpoints: { syncPush: `${origin}/private-entry/canonical-update` },
      features: { bookmarkUrls: { acceptedSchemes: ['http', 'https'] } },
      auth: { anonymousRead: false, apiKeys: false, oauth: true,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource` },
      limits: { maxPageSize: 100, maxSnapshotNodes: 10_000,
        minPollIntervalSeconds: 10, recommendedPollIntervalSeconds: 30 } }],
  } as Manifest;
}

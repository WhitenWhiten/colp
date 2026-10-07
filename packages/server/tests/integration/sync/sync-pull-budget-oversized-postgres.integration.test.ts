import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { insertTestOperation } from '../../support/ledger-split-writes.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncPullReadPort,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { createSyncPullCursorKeyring, SyncPullReadError } from '../../../src/modules/sync/index.js';
import {
  RESOURCE_PAYLOAD_SCHEMA_VERSION,
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ACCOUNT = 'f013-account';
const SUBJECT = 'f013-subject';
const COLLECTION = 'f013-collection';
const ROOT = 'f013-root';
const TARGET = 'f013-root-target';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

// F013: a Pull page whose first event alone exceeds the negotiated byte budget
// can never be answered at that cursor. The port must not throw
// payload_too_large (413) forever; it escalates the Replica to Snapshot
// recovery — the standard 410 stale_replica path — so the Snapshot's
// materialized state carries the oversized content and the bootstrap cursor
// lands above the inexpressible event. No event is emitted or dropped.
describeWithPostgres('F013 Pull head-event byte budget escalation', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('f013_sync_pull', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
    const now = new Date('2026-07-26T06:00:00Z');
    const collection = materializeCollectionPayload({
      id: COLLECTION, ownerSubjectId: SUBJECT, title: COLLECTION, summary: null,
      kind: 'bookmarks', visibility: 'private', rootNodeId: ROOT,
      resourceRevision: 'collection-r1', contentRevision: 'content-r1', policyRevision: 'policy-r1',
      commitOrdinal: 0n, createdAt: now, updatedAt: now, deletedAt: null,
    });
    const root = materializeNodePayload({
      id: ROOT, collectionId: COLLECTION, parentId: null, kind: 'folder', isRoot: true, title: 'Root',
      url: null, description: null, tags: [], visibility: 'inherit', positionToken: null,
      resourceRevision: 'root-r1', childrenRevision: 'children-r1', createdAt: now, updatedAt: now,
      deletedAt: null, deletedCommitOrdinal: null,
    });
    const target = materializeNodePayload({
      id: TARGET, collectionId: COLLECTION, parentId: ROOT, kind: 'bookmark', isRoot: false,
      title: 'Target', url: 'https://example.test/', description: null, tags: [],
      visibility: 'inherit', positionToken: 'A', resourceRevision: 'target-r1',
      childrenRevision: 'target-children-r1', createdAt: now, updatedAt: now,
      deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(collection.ok, true); assert.equal(root.ok, true); assert.equal(target.ok, true);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node'),($3,'node')", [COLLECTION, ROOT, TARGET]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,visibility,root_node_id,resource_revision,content_revision,
         policy_revision,commit_ordinal,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,$1,'bookmarks','private',$3,'collection-r1','content-r1','policy-r1',0,$4,$4,$5,$6,'backfilled')`,
      [COLLECTION, SUBJECT, ROOT, now, collection.ok ? collection.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,null,'folder',true,'Root',null,'inherit',null,'root-r1','children-r1',$3,$3,$4,$5,'backfilled')`,
      [ROOT, COLLECTION, now, root.ok ? root.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query(`insert into nodes
        (id,collection_id,parent_id,kind,is_root,title,url,visibility,position_token,resource_revision,
         children_revision,created_at,updated_at,payload_json,payload_schema_version,payload_authority_status)
        values ($1,$2,$3,'bookmark',false,'Target','https://example.test/','inherit','A','target-r1','target-children-r1',$4,$4,$5,$6,'backfilled')`,
      [TARGET, COLLECTION, ROOT, now, target.ok ? target.payload : {}, RESOURCE_PAYLOAD_SCHEMA_VERSION]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally { client.release(); }
    await isolated.runtime.pool.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
    await isolated.runtime.pool.query("insert into profile_handles(handle,account_id) values ('f013_pull',$1)", [ACCOUNT]);
    await isolated.runtime.pool.query(`insert into account_identities(id,account_id,issuer,subject)
      values ('f013-identity',$1,$2,'f013-oidc')`, [ACCOUNT, ISSUER]);
  }, 120_000);

  afterAll(async () => isolated?.close());

  async function createScope() {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: 'f013-oidc',
      credentialId: `f013-credential-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `f013-device-${suffix}`, replicaId: () => `f013-replica-${suffix}`,
      leaseId: () => `f013-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'F013 device', replicaName: 'F013 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `f013-profile-${suffix}`, mountMode: 'whole-profile',
        browserGeneration: `generation-${suffix}` },
      leaseDurationSeconds: 3_600,
    }, { actorAccountId: ACCOUNT });
    const issuer = createPostgresSyncSessionIssuer(isolated.runtime.db, {
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension',
      replayEncryptionKey: Buffer.alloc(32, 23), replayEncryptionKeyVersion: 1,
      sessionDurationSeconds: 900, replicaLeaseExtensionSeconds: 3_600,
      tombstoneRetentionSeconds: 86_400, maxBatchOperations: 1,
      endpointCapabilities: ['syncSnapshot', 'syncPush', 'syncPull', 'syncAck', 'syncConflict'],
    });
    const issued = await issuer.issue({
      credential, idempotencyKey: `f013-session-${suffix}`,
      requestFingerprint: `f013-session-fingerprint-${suffix}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration,
      expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN, protocolVersion: '0.1',
    });
    return { credential, replica, session: issued.session };
  }

  function operation(id: string, sequence: number, replicaId: string, title: string): Operation {
    return { opId: id, replicaId, sequence, collectionId: COLLECTION,
      type: 'update_node_content', targetId: TARGET, baseRevision: 'target-r1',
      occurredAt: '2026-07-26T06:01:00Z', payload: { base: { title: 'Root' }, value: { title } } };
  }

  async function insertOperation(id: string, ordinal: number, replicaId: string,
    title = `Root ${id}`): Promise<void> {
    await isolated.runtime.pool.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'operation')", [id]);
    await insertTestOperation(isolated.runtime.db, {
      operationId: id, collectionId: COLLECTION, commitOrdinal: BigInt(ordinal),
      operationType: 'sync.node.update', payloadJson: { action: 'update' },
      syncWireJson: operation(id, ordinal, replicaId, title) as unknown as Record<string, unknown>,
      actorPrincipalId: ACCOUNT,
    });
  }

  test('escalates the replica to Snapshot recovery when the stream head exceeds the byte budget', async () => {
    const scope = await createScope();
    const suffix = randomUUID();
    const anchorId = `f013-anchor-${suffix}`;
    const headId = `f013-head-${suffix}`;
    const tailId = `f013-tail-${suffix}`;
    const ordinal = 800_000;
    await insertOperation(anchorId, ordinal - 1, scope.replica.replicaId);
    await insertOperation(headId, ordinal, scope.replica.replicaId, 'x'.repeat(64_000));
    await insertOperation(tailId, ordinal + 1, scope.replica.replicaId);
    const keys = createSyncPullCursorKeyring({
      active: { id: `f013-${suffix}`, secret: Buffer.alloc(32, 37).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys, { responseBudgetBytes: 48_000 });
    const anchorCursor = keys.sign({
      replicaId: scope.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: scope.replica.leaseGeneration, sessionId: scope.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1', policyRevision: 'policy-r1', limit: 2,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation', stableId: '' },
      tuple: { commitOrdinal: String(ordinal - 1), streamKind: 'operation', stableId: anchorId },
    });
    const input = { credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: anchorCursor, limit: 2 } as const;
    await assert.rejects(port.read(input),
      (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    const replica = await isolated.runtime.pool.query<{ status: string }>(
      'select status from sync_replicas where replica_id=$1', [scope.replica.replicaId]);
    assert.equal(replica.rows[0]?.status, 'recovery_required');
    const audit = await isolated.runtime.pool.query<{ details_json: { reason?: string } }>(
      `select payload.details_json
       from audit_events event join audit_event_payloads payload on payload.event_id=event.id
       where event.event_type='sync.replica.lifecycle.recovery_required'
         and payload.details_json->>'replicaId'=$1 order by event.created_at desc limit 1`,
      [scope.replica.replicaId]);
    assert.equal(audit.rows[0]?.details_json.reason, 'payload_too_large');
    // Neither the oversized head nor the row behind it was emitted or consumed:
    // no page evidence claims their cursors and the stream stays intact for the
    // Snapshot rebuild.
    const evidence = await isolated.runtime.db.selectFrom('sync_pull_cursor_evidence').select('evidence_id')
      .where('replica_id', '=', scope.replica.replicaId).execute();
    assert.equal(evidence.length, 0);
    // The same read now fails fast through the authority gate — no 413 loop.
    await assert.rejects(port.read(input),
      (error: unknown) => error instanceof SyncPullReadError && error.code === 'recovery_required');
    keys.destroy();
  });
});

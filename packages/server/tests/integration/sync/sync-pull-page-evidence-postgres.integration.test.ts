import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import type { Operation } from '@know-n/colp/types';
import { appendOperationWithPayload, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createPostgresReplicaStore,
  createPostgresSyncPullReadPort,
  createPostgresSyncSessionIssuer,
} from '../../../src/infrastructure/sync/index.js';
import { SyncPullReadError, createSyncPullCursorKeyring, createSyncPullCursorLineageKeyring } from '../../../src/modules/sync/index.js';
import { RESOURCE_PAYLOAD_SCHEMA_VERSION, materializeCollectionPayload, materializeNodePayload } from '../../../src/modules/collections/index.js';
import { mintVerifiedExtensionCredentialFixture } from '../../support/extension-credential.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ISSUER = 'https://issuer.example';
const ACCOUNT = 'q011-account';
const SUBJECT = 'q011-subject';
const COLLECTION = 'q011-collection';
const ROOT = 'q011-root';
const TARGET = 'q011-root-target';
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

describeWithPostgres('SYNC-Q-011 page-level Pull evidence write budget', () => {
  let isolated: IsolatedPostgresRuntime;
  let scope: Awaited<ReturnType<typeof createScope>>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('q011_page_evidence', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    await seedCollection();
    scope = await createScope();
  }, 20_000);

  afterAll(async () => isolated?.close());

  async function seedCollection(): Promise<void> {
    const now = new Date('2026-08-30T09:00:00Z');
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
      id: TARGET, collectionId: COLLECTION, parentId: ROOT, kind: 'bookmark', isRoot: false, title: 'Target',
      url: 'https://example.test/', description: null, tags: [], visibility: 'inherit', positionToken: 'A',
      resourceRevision: 'target-r1', childrenRevision: 'target-children-r1', createdAt: now, updatedAt: now,
      deletedAt: null, deletedCommitOrdinal: null,
    });
    assert.equal(collection.ok, true); assert.equal(root.ok, true); assert.equal(target.ok, true);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')", [ACCOUNT, SUBJECT]);
      await client.query("insert into profile_handles(handle,account_id) values ('q011',$1)", [ACCOUNT]);
      await client.query(`insert into account_identities(id,account_id,issuer,subject)
        values ('q011-identity',$1,$2,'q011-oidc')`, [ACCOUNT, ISSUER]);
      await client.query("insert into resource_id_ledger(resource_id,resource_type) values ($1,'collection'),($2,'node'),($3,'node')",
        [COLLECTION, ROOT, TARGET]);
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
  }

  async function createScope() {
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: 'q011-oidc',
      credentialId: 'q011-credential',
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => 'q011-device', replicaId: () => 'q011-replica', leaseId: () => 'q011-lease',
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Q011 device', replicaName: 'Q011 replica',
      kind: 'browser_extension', adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: 'q011-profile', mountMode: 'whole-profile', browserGeneration: 'generation-1' },
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
      credential, idempotencyKey: 'q011-session', requestFingerprint: 'q011-session-fingerprint',
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN,
    });
    return { credential, replica, session: issued.session };
  }

  function operation(id: string, sequence: number): Operation {
    return { opId: id, replicaId: scope.replica.replicaId, sequence, collectionId: COLLECTION,
      type: 'update_node_content', targetId: TARGET, baseRevision: 'target-r1',
      occurredAt: '2026-08-30T09:01:00Z', payload: { base: { title: 'Root' }, value: { title: `Root ${id}` } } };
  }

  async function insertOperations(prefix: string, startOrdinal: number, count: number): Promise<void> {
    await isolated.runtime.db.transaction().execute(async (transaction) => {
      for (let index = 0; index < count; index += 1) {
        const id = `${prefix}-${String(index).padStart(5, '0')}`;
        const sequence = startOrdinal + index;
        await sql`insert into resource_id_ledger(resource_id,resource_type)
          values (${id}, 'operation')`.execute(transaction);
        await appendOperationWithPayload(transaction, {
          operationId: id, collectionId: COLLECTION, commitOrdinal: BigInt(sequence),
          operationType: 'sync.node.update', payloadJson: { action: 'update' },
          syncWireJson: operation(id, sequence) as unknown as Record<string, unknown>,
          actorPrincipalId: ACCOUNT,
        });
      }
    });
  }

  async function rowCounts(replicaId: string): Promise<{
    readonly evidence: number; readonly proofs: number; readonly lineage: number; readonly pages: number;
  }> {
    const rows = await isolated.runtime.pool.query<{
      evidence: string; proofs: string; lineage: string; pages: string;
    }>(`select
      (select count(*)::text from sync_pull_cursor_evidence where replica_id=$1) evidence,
      (select count(*)::text from sync_pull_cursor_recovery_proofs where replica_id=$1) proofs,
      (select count(*)::text from sync_pull_cursor_lineage where replica_id=$1) lineage,
      (select count(*)::text from sync_pull_page_evidence where replica_id=$1) pages`, [replicaId]);
    const row = rows.rows[0];
    assert.ok(row);
    return {
      evidence: Number(row.evidence), proofs: Number(row.proofs),
      lineage: Number(row.lineage), pages: Number(row.pages),
    };
  }

  test('a 200-event page writes one envelope, one next-cursor evidence, one proof and one lineage', async () => {
    const suffix = randomUUID();
    const keys = createSyncPullCursorKeyring({
      active: { id: `q011-200-${suffix}`, secret: Buffer.alloc(32, 41).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const lineageKeys = createSyncPullCursorLineageKeyring({
      active: { id: `q011-lineage-${suffix}`, secret: Buffer.alloc(32, 47).toString('base64') },
      retained: [],
    });
    const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys, {
      lineageKeyring: lineageKeys, lineageRetentionMs: 60_000,
    });
    const anchorId = `q011-anchor-${suffix}`;
    await insertOperations(anchorId, 899_999, 1);
    const context = {
      replicaId: scope.replica.replicaId, collectionId: COLLECTION,
      leaseGeneration: scope.replica.leaseGeneration, sessionId: scope.session.sessionId,
      principalId: ACCOUNT, protocolVersion: '0.1' as const, policyRevision: 'policy-r1',
      limit: 200,
      purgeBoundary: { commitOrdinal: '0', streamKind: 'operation' as const, stableId: '' },
    };
    const anchorCursor = keys.sign({
      ...context,
      tuple: { commitOrdinal: '899999', streamKind: 'operation', stableId: `${anchorId}-00000` },
    });
    await insertOperations(`q011-200-${suffix}`, 900_000, 200);
    const before = await rowCounts(scope.replica.replicaId);
    const page = await port.read({
      credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: anchorCursor, limit: 200,
    });
    assert.equal(page.events.length, 200);
    const after = await rowCounts(scope.replica.replicaId);
    assert.deepEqual({
      evidence: after.evidence - before.evidence,
      proofs: after.proofs - before.proofs,
      lineage: after.lineage - before.lineage,
      pages: after.pages - before.pages,
    }, { evidence: 1, proofs: 1, lineage: 1, pages: 1 });
    const digest = createHash('sha256').update(page.nextCursor, 'utf8').digest('hex');
    const envelope = await isolated.runtime.db.selectFrom('sync_pull_page_evidence').selectAll()
      .where('replica_id', '=', scope.replica.replicaId).where('next_cursor_digest', '=', digest)
      .executeTakeFirstOrThrow();
    assert.equal(envelope.event_count, 200);
    assert.equal(envelope.page_limit, 200);
    const continuation = await rowCounts(scope.replica.replicaId);
    const empty = await port.read({
      credential: scope.credential, sessionId: scope.session.sessionId,
      collectionId: COLLECTION, replicaId: scope.replica.replicaId, cursor: page.nextCursor, limit: 200,
    });
    assert.equal(empty.events.length, 0);
    assert.deepEqual(await rowCounts(scope.replica.replicaId), continuation,
      'an empty continuation must not append page, evidence, proof, or lineage rows');
    lineageKeys.destroy();
    keys.destroy();
  });

  test('an aborted persist rolls back the page envelope with the next-cursor evidence', async () => {
    const suffix = randomUUID();
    const credential = await mintVerifiedExtensionCredentialFixture({
      issuer: ISSUER, audience: 'known-api', clientId: 'known-extension', subject: 'q011-oidc',
      credentialId: `q011-abort-${suffix}`,
    });
    const replica = await createPostgresReplicaStore(isolated.runtime.db, { ids: {
      deviceId: () => `q011-abort-device-${suffix}`, replicaId: () => `q011-abort-replica-${suffix}`,
      leaseId: () => `q011-abort-lease-${suffix}`,
    } }).create({
      accountId: ACCOUNT, collectionId: COLLECTION, deviceName: 'Q011 abort device',
      replicaName: 'Q011 abort replica', kind: 'browser_extension',
      adapter: { profile: 'chromium-bookmarks-v1', version: '1.0.0' },
      capabilities: { read: true, write: true, events: true, separator: true, alias: false,
        annotations: 'sidecar', maxBatchOperations: 1 },
      binding: { browserProfileId: `q011-abort-${suffix}`, mountMode: 'whole-profile',
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
      credential, idempotencyKey: `q011-abort-session-${suffix}`,
      requestFingerprint: `q011-abort-fingerprint-${suffix}`,
      collectionId: COLLECTION, replicaId: replica.replicaId,
      expectedLeaseGeneration: replica.leaseGeneration, expectedLifecycleRevision: replica.lifecycleRevision,
      binding: replica.binding, requestedScopes: ['sync:pull'], origin: ORIGIN,
    });
    await insertOperations(`q011-abort-${suffix}`, 20_000, 3);
    const keys = createSyncPullCursorKeyring({
      active: { id: `q011-abort-${suffix}`, secret: Buffer.alloc(32, 43).toString('base64') },
      retained: [], ttlMs: 60_000,
    });
    const port = createPostgresSyncPullReadPort(isolated.runtime.db, keys, {
      evidenceFaultInjector: {
        async afterPhase(phase) {
          if (phase === 'evidence_insert') throw new SyncPullReadError('integrity_failure');
        },
      },
    });
    await assert.rejects(port.read({
      credential, sessionId: issued.session.sessionId,
      collectionId: COLLECTION, replicaId: replica.replicaId, cursor: null, limit: 3,
    }), (error: unknown) => error instanceof SyncPullReadError && error.code === 'integrity_failure');
    assert.deepEqual(await rowCounts(replica.replicaId), {
      evidence: 0, proofs: 0, lineage: 0, pages: 0,
    });
    keys.destroy();
  });
});

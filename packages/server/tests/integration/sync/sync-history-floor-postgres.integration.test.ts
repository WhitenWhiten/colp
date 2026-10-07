import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';

import {
  appendOperationWithPayload,
  createPostgresLedgerArchiveSegmentRepository,
  createPostgresSyncHistoryFloorRepository,
  runMigrations,
  SyncHistoryFloorRepositoryError,
  type LedgerArchiveSegment,
} from '../../../src/infrastructure/database/index.js';
import { createPostgresReplicaRetentionWindowPort } from '../../../src/infrastructure/sync/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const ACCOUNT = 'history-floor-account';
const SUBJECT = 'history-floor-subject';
const COLLECTION = 'history-floor-collection';

describeWithPostgres('Sync archived history floor authority', () => {
  let isolated: IsolatedPostgresRuntime;
  let floor: ReturnType<typeof createPostgresSyncHistoryFloorRepository>;
  let archive: ReturnType<typeof createPostgresLedgerArchiveSegmentRepository>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('sync_history_floor', { maxConnections: 8 });
    await runMigrations(isolated.runtime.db, 'latest');
    floor = createPostgresSyncHistoryFloorRepository(isolated.runtime.db);
    archive = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    await isolated.runtime.pool.query("insert into accounts(id,subject_id,status) values ($1,$2,'active')",
      [ACCOUNT, SUBJECT]);
    await seedOperationPrefix(COLLECTION, 'history');
  }, 120_000);

  afterAll(async () => isolated?.close());

  function errorCode(code: SyncHistoryFloorRepositoryError['code']) {
    return (error: unknown): boolean => error instanceof SyncHistoryFloorRepositoryError
      && error.code === code;
  }

  /**
   * Insert a Collection the way a fixture or a restore does: raw SQL, one
   * transaction, no application command. `202607252400_sync_tombstone_purge`
   * installs an AFTER INSERT trigger, so this also creates purge authority —
   * which the retention-window tests below assert and then withhold.
   */
  async function seedCollection(collectionId: string, label: string): Promise<void> {
    const root = `${label}-root`;
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into resource_id_ledger(resource_id,resource_type)
        values ($1,'collection'),($2,'node')`, [collectionId, root]);
      await client.query(`insert into collections
        (id,owner_subject_id,title,kind,root_node_id,resource_revision,content_revision,policy_revision)
        values ($1,$2,'History floor','bookmarks',$3,'r1','c1','p1')`,
      [collectionId, SUBJECT, root]);
      await client.query(`insert into nodes
        (id,collection_id,kind,is_root,title,resource_revision,children_revision)
        values ($1,$2,'folder',true,'Root','r1','ch1')`, [root, collectionId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedOperationPrefix(collectionId: string, label: string,
    boundaryIsPull = true): Promise<void> {
    await seedCollection(collectionId, label);
    for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
      const operationId = `${label}-operation-${ordinal}`;
      await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
        values ($1,'operation')`, [operationId]);
      await isolated.runtime.db.transaction().execute((transaction) => appendOperationWithPayload(
        transaction,
        { operationId, collectionId, commitOrdinal: BigInt(ordinal),
          operationType: 'sync_history_test', payloadJson: {}, actorPrincipalId: ACCOUNT,
          syncWireJson: ordinal === 10 && !boundaryIsPull
            ? null : { operationId, commitOrdinal: String(ordinal) } },
      ));
    }
  }

  async function createSegment(input: {
    readonly collectionId?: string;
    readonly ledgerFamily?: string;
    readonly sourceRelation?: string;
    readonly scope?: string;
    readonly lower?: bigint;
    readonly upper?: bigint;
    readonly rowCount?: bigint;
    readonly sourceBytes?: bigint;
    readonly archiveSchemaVersion?: number;
    readonly verified?: boolean;
  } = {}): Promise<LedgerArchiveSegment> {
    const collectionId = input.collectionId ?? COLLECTION;
    let segment = await archive.create({
      segmentId: randomUUID(), ledgerFamily: input.ledgerFamily ?? 'operation',
      sourceRelation: input.sourceRelation ?? 'public.operation_payloads',
      sourceScope: input.scope ?? `collection:${collectionId}`,
      sourceKeyKind: 'bigint', sourceKeyComparator: 'signed-bigint-ascending-v1',
      sourceKeyBounds: { lowerInclusive: input.lower ?? 1n, upperExclusive: input.upper ?? 11n },
      rowCount: input.rowCount ?? 10n, sourceBytes: input.sourceBytes ?? 1024n,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      archiveObjectUri: `s3://known-sync-history/${randomUUID()}.parquet`,
      archiveObjectEtag: randomUUID(), archiveSchemaVersion: input.archiveSchemaVersion ?? 1,
      kmsKeyId: 'kms:known:sync-history-v1',
    });
    if (input.verified !== true) return segment;
    for (const targetState of ['sealed', 'exported', 'verified'] as const) {
      segment = await archive.transition({ segmentId: segment.segmentId,
        expectedState: segment.state, expectedRevision: segment.stateRevision,
        targetState, evidence: { verifiedBy: 'sync-history-floor-integration' } });
    }
    return segment;
  }

  async function activeReplica(checkpointOrdinal: number, stableId: string): Promise<string> {
    const suffix = randomUUID();
    const replica = `history-replica-${suffix}`;
    const device = `history-device-${suffix}`;
    const lease = `history-lease-${suffix}`;
    await isolated.runtime.pool.query(`insert into resource_id_ledger(resource_id,resource_type)
      values ($1,'sync_device'),($2,'sync_replica')`, [device, replica]);
    await isolated.runtime.pool.query(`insert into sync_devices(device_id,account_id,device_name)
      values ($1,$2,'History test')`, [device, ACCOUNT]);
    await isolated.runtime.pool.query(`insert into sync_replica_id_ledger
      (replica_id,account_id,device_id,collection_id,initial_lease_generation,binding_mode,
       browser_profile_id,browser_generation)
      values ($1,$2,$3,$4,1,'whole-profile',$5,$6)`,
    [replica, ACCOUNT, device, COLLECTION, `profile-${suffix}`, `generation-${suffix}`]);
    await isolated.runtime.pool.query(`insert into sync_replica_generations
      (replica_id,lease_generation,lease_id) values ($1,1,$2)`, [replica, lease]);
    const capabilities = { read: true, write: true, events: true, separator: true, alias: false,
      annotations: 'sidecar', maxBatchOperations: 1 };
    const wire = { replicaId: replica, accountId: ACCOUNT, collectionId: COLLECTION,
      leaseId: lease, leaseGeneration: '1', status: 'active', capabilities,
      checkpoint: { acknowledgedCursor: `cursor-${suffix}`,
        acknowledgedCommitOrdinal: String(checkpointOrdinal) } };
    await isolated.runtime.pool.query(`insert into sync_replicas
      (replica_id,account_id,device_id,collection_id,replica_name,kind,lease_generation,lease_id,
       binding_mode,browser_profile_id,browser_generation,adapter_profile,adapter_version,
       capabilities_json,checkpoint_cursor,checkpoint_commit_ordinal,checkpoint_stream_kind,
       checkpoint_stable_id,status,last_seen_at,lease_expires_at,wire_json)
      values ($1,$2,$3,$4,'History','browser_extension',1,$5,'whole-profile',$6,$7,
       'chromium','1',$8,$9,$10,0,$11,'active',current_timestamp,
       current_timestamp+interval '1 hour',$12)`,
    [replica, ACCOUNT, device, COLLECTION, lease, `profile-${suffix}`, `generation-${suffix}`,
      capabilities, `cursor-${suffix}`, checkpointOrdinal, stableId, wire]);
    return replica;
  }

  test('reads/materializes implicit zero and keeps purge authority independent', async () => {
    const dense = await isolated.runtime.pool.query<{ ordinals: string[] }>(`
      select array_agg(commit_ordinal::text order by commit_ordinal) ordinals
      from operations where collection_id=$1`, [COLLECTION]);
    assert.deepEqual(dense.rows[0]?.ordinals,
      Array.from({ length: 10 }, (_, index) => String(index + 1)));
    const initial = await floor.read(COLLECTION);
    assert.equal(initial.position.commitOrdinal, '0');
    assert.equal(initial.position.streamKind, 'operation');
    assert.equal(initial.stateRevision, '0');
    assert.equal((await floor.materializeZero(COLLECTION)).materialized, true);
    const window = await isolated.runtime.db.transaction().execute((transaction) =>
      createPostgresReplicaRetentionWindowPort('/sync/snapshot').load(transaction, COLLECTION));
    assert.deepEqual(window.earliestPullTuple,
      { commitOrdinal: '0', streamKind: 0, stableId: '' });
    assert.deepEqual(window.purgedThroughTuple,
      { commitOrdinal: '0', streamKind: 0, stableId: '' });
  });

  test('rejects a canonical Operation that is not a real Pull tuple', async () => {
    const collectionId = 'history-floor-non-pull-boundary';
    await seedOperationPrefix(collectionId, 'non-pull', false);
    const segment = await createSegment({ collectionId, verified: true });
    await assert.rejects(floor.advance({ collectionId,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'non-pull-operation-10' },
      archiveSegmentId: segment.segmentId, expectedStateRevision: '0' }),
    errorCode('boundary_missing'));
  });

  test('rejects unverified, wrong-scope, range and row-count false proofs', async () => {
    const unverified = await createSegment({ scope: 'collection:unverified' });
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'history-operation-10' },
      archiveSegmentId: unverified.segmentId, expectedStateRevision: '0' }),
    errorCode('binding_mismatch'));

    const wrongScope = await createSegment({ scope: 'collection:wrong', verified: true });
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'history-operation-10' },
      archiveSegmentId: wrongScope.segmentId, expectedStateRevision: '0' }),
    errorCode('binding_mismatch'));

    const wrongFamily = await createSegment({ ledgerFamily: 'operations', verified: true });
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'history-operation-10' },
      archiveSegmentId: wrongFamily.segmentId, expectedStateRevision: '0' }),
    errorCode('binding_mismatch'));

    const incomplete = await createSegment({ lower: 20n, upper: 30n, verified: true });
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'history-operation-10' },
      archiveSegmentId: incomplete.segmentId, expectedStateRevision: '0' }),
    errorCode('binding_mismatch'));

    const falseProofCollection = 'history-floor-false-proof';
    await seedOperationPrefix(falseProofCollection, 'false-proof');
    const wrongCount = await createSegment({ collectionId: falseProofCollection,
      rowCount: 9n, verified: true });
    await assert.rejects(floor.advance({ collectionId: falseProofCollection,
      position: { commitOrdinal: '10', streamKind: 'operation',
        stableId: 'false-proof-operation-10' },
      archiveSegmentId: wrongCount.segmentId, expectedStateRevision: '0' }),
    errorCode('binding_mismatch'));

    const emptyBytesCollection = 'history-floor-empty-bytes';
    await seedOperationPrefix(emptyBytesCollection, 'empty-bytes');
    const emptyBytes = await createSegment({ collectionId: emptyBytesCollection,
      sourceBytes: 0n, verified: true });
    await assert.rejects(floor.advance({ collectionId: emptyBytesCollection,
      position: { commitOrdinal: '10', streamKind: 'operation',
        stableId: 'empty-bytes-operation-10' },
      archiveSegmentId: emptyBytes.segmentId, expectedStateRevision: '0' }),
    errorCode('binding_mismatch'));

    const wrongSchemaCollection = 'history-floor-wrong-schema';
    await seedOperationPrefix(wrongSchemaCollection, 'wrong-schema');
    const wrongSchema = await createSegment({ collectionId: wrongSchemaCollection,
      archiveSchemaVersion: 2, verified: true });
    await assert.rejects(floor.advance({ collectionId: wrongSchemaCollection,
      position: { commitOrdinal: '10', streamKind: 'operation',
        stableId: 'wrong-schema-operation-10' },
      archiveSegmentId: wrongSchema.segmentId, expectedStateRevision: '0' }),
    errorCode('binding_mismatch'));
  });

  test('requires verified evidence and every active Replica Ack before a legal advance', async () => {
    let segment = await createSegment();
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'history-operation-10' },
      archiveSegmentId: segment.segmentId, expectedStateRevision: '0' }),
    errorCode('archive_not_verified'));
    for (const targetState of ['sealed', 'exported', 'verified'] as const) {
      segment = await archive.transition({ segmentId: segment.segmentId,
        expectedState: segment.state, expectedRevision: segment.stateRevision,
        targetState, evidence: { verifiedBy: 'sync-history-floor-integration' } });
    }
    const replica = await activeReplica(9, 'history-operation-9');
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'history-operation-10' },
      archiveSegmentId: segment.segmentId, expectedStateRevision: '0' }),
    errorCode('active_replica_behind'));
    await isolated.runtime.pool.query(`update sync_replicas set checkpoint_commit_ordinal=10,
      checkpoint_stable_id='history-operation-10' where replica_id=$1`, [replica]);

    const countsBefore = await isolated.runtime.pool.query<{ operations: string; revisions: string; receipts: string }>(`
      select (select count(*)::text from operations where collection_id=$1) operations,
        (select count(*)::text from sync_node_revision_history where collection_id=$1) revisions,
        (select count(*)::text from sync_ack_receipts where collection_id=$1) receipts`, [COLLECTION]);
    const input = { collectionId: COLLECTION,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: 'history-operation-10' },
      archiveSegmentId: segment.segmentId, expectedStateRevision: '0' } as const;
    const concurrent = await Promise.allSettled([floor.advance(input), floor.advance(input)]);
    const fulfilled = concurrent.find((result) => result.status === 'fulfilled');
    const rejected = concurrent.find((result) => result.status === 'rejected');
    assert.ok(fulfilled?.status === 'fulfilled');
    assert.ok(rejected?.status === 'rejected');
    assert.equal(errorCode('cas_conflict')(rejected.reason), true);
    const advanced = fulfilled.value;
    assert.equal(advanced.stateRevision, '1');
    assert.equal(advanced.archiveSegmentId, segment.segmentId);
    assert.deepEqual((await isolated.runtime.db.transaction().execute((transaction) =>
      createPostgresReplicaRetentionWindowPort('/sync/snapshot').load(transaction, COLLECTION)))
      .earliestPullTuple, { commitOrdinal: '10', streamKind: 0, stableId: 'history-operation-10' });
    const countsAfter = await isolated.runtime.pool.query<{ operations: string; revisions: string; receipts: string }>(`
      select (select count(*)::text from operations where collection_id=$1) operations,
        (select count(*)::text from sync_node_revision_history where collection_id=$1) revisions,
        (select count(*)::text from sync_ack_receipts where collection_id=$1) receipts`, [COLLECTION]);
    assert.deepEqual(countsAfter.rows[0], countsBefore.rows[0], 'advance must not delete source history');
  });

  test('returns stable boundary, CAS and regression errors and rejects destructive SQL', async () => {
    const current = await floor.read(COLLECTION);
    assert.equal(current.stateRevision, '1');
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '12', streamKind: 'operation', stableId: 'missing-operation' },
      archiveSegmentId: current.archiveSegmentId!, expectedStateRevision: '1' }),
    errorCode('boundary_missing'));
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '11', streamKind: 'operation', stableId: 'history-operation-11' },
      archiveSegmentId: current.archiveSegmentId!, expectedStateRevision: '0' }),
    errorCode('cas_conflict'));
    await assert.rejects(floor.advance({ collectionId: COLLECTION,
      position: { commitOrdinal: '9', streamKind: 'operation', stableId: 'history-operation-9' },
      archiveSegmentId: current.archiveSegmentId!, expectedStateRevision: '1' }),
    errorCode('regression'));
    await assert.rejects(isolated.runtime.pool.query(
      'delete from sync_history_floors where collection_id=$1', [COLLECTION]),
    (error: unknown) => (error as { constraint?: string }).constraint
      === 'sync_history_floors_delete_guard');
    await assert.rejects(isolated.runtime.pool.query('truncate table sync_history_floors'),
      (error: unknown) => (error as { constraint?: string }).constraint
        === 'sync_history_floors_truncate_guard');
  });

  test('reads the INITIAL retention window when the Collection has no purge authority row', async () => {
    const collectionId = 'history-floor-no-purge-authority';
    await seedCollection(collectionId, collectionId);
    const created = await isolated.runtime.pool.query<{ count: string }>(
      'select count(*)::text as count from sync_collection_purge_state where collection_id=$1', [collectionId]);
    assert.equal(created.rows[0]?.count, '1',
      'the collections AFTER INSERT trigger must create purge authority with the Collection');

    // Authority can still be absent — a restore that skipped triggers, or a
    // hand-repaired schema. Every other reader of this table reads the INITIAL
    // boundary there; the retention window used to be the one reader that threw,
    // which reached a Replica recovery request as a 500 instead of a Session.
    await isolated.runtime.pool.query(
      'delete from sync_collection_purge_state where collection_id=$1', [collectionId]);
    const window = await isolated.runtime.db.transaction().execute((transaction) =>
      createPostgresReplicaRetentionWindowPort('/sync/snapshot').load(transaction, collectionId));
    assert.deepEqual(window.earliestPullTuple, { commitOrdinal: '0', streamKind: 0, stableId: '' });
    assert.deepEqual(window.purgedThroughTuple, { commitOrdinal: '0', streamKind: 0, stableId: '' });
    assert.equal(window.earliestPull.commitOrdinal, '0');
    assert.equal(window.purgedThrough.commitOrdinal, '0');
  });

  test('a missing purge authority row does not hide the archived history floor', async () => {
    // The two boundaries are independent authorities. Reading them through one
    // join made the floor invisible exactly when authority was missing, so this
    // pins the floor read on its own.
    const collectionId = 'history-floor-without-purge-authority';
    await seedOperationPrefix(collectionId, collectionId);
    const segment = await createSegment({ collectionId, verified: true });
    const advanced = await floor.advance({ collectionId,
      position: { commitOrdinal: '10', streamKind: 'operation', stableId: `${collectionId}-operation-10` },
      archiveSegmentId: segment.segmentId, expectedStateRevision: '0' });
    assert.equal(advanced.position.commitOrdinal, '10');
    await isolated.runtime.pool.query(
      'delete from sync_collection_purge_state where collection_id=$1', [collectionId]);
    const window = await isolated.runtime.db.transaction().execute((transaction) =>
      createPostgresReplicaRetentionWindowPort('/sync/snapshot').load(transaction, collectionId));
    assert.deepEqual(window.earliestPullTuple,
      { commitOrdinal: '10', streamKind: 0, stableId: `${collectionId}-operation-10` });
    assert.deepEqual(window.purgedThroughTuple, { commitOrdinal: '0', streamKind: 0, stableId: '' });
  });

});

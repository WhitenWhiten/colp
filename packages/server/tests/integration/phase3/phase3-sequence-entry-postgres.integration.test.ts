import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import { verifyFixtureSyncSessionRecord } from '../../support/sync-verified-session.js';
import {
  createPhase3SequenceEntryHarness,
  createPhase3SequenceRequestDigest,
  Phase3SequenceEntryFaultError,
  type Phase3SequenceEntryResult,
  type Phase3SequenceEntryRequest,
} from '../../../scripts/evidence/phase3-sequence-entry-harness.js';
import {
  materializeCollectionPayload,
  materializeNodePayload,
} from '../../../src/modules/collections/index.js';
import { createDatabaseRuntime, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
  truncateGuardedTablesInTransaction,
} from '../../support/postgres-test-runtime.js';
import {
  PHASE3_SEQUENCE_FIXTURE as FIXTURE,
  PHASE3_SEQUENCE_FAULT_POINTS,
  phase3SequenceCanonicalMutation,
} from '../../fixtures/phase3/sequence-entry.js';

// COLP Server: one committed node update writes only the canonical outbox
// event; Know-N also writes the feed and public-activity rows (tests/EXTRACTION.md).
const COMMITTED_OUTBOX_EVENTS = 1;

async function verifiedSessionFor(sessionId = FIXTURE.sessionId) {
  return await verifyFixtureSyncSessionRecord({
    sessionId,
    principal: { type: 'user' as const, id: FIXTURE.principalId },
    credential: { kind: 'token' as const, id: 'phase3-credential' },
    oauthClientId: 'phase3-extension',
    origin: null,
    sessionScope: 'collection' as const,
    protocolVersion: '0.1' as const,
    collectionId: FIXTURE.collectionId,
    purpose: null,
    authorizationScopes: ['sync:push'] as const,
    status: 'active' as const,
  });
}

const verifiedSession = await verifiedSessionFor();
const execFileAsync = promisify(execFile);

function request(
  overrides: Partial<Phase3SequenceEntryRequest> = {},
): Phase3SequenceEntryRequest {
  return {
    session: verifiedSession,
    leaseGeneration: FIXTURE.leaseGeneration,
    batchId: FIXTURE.batchId,
    replicaId: FIXTURE.replicaId,
    sequenceScope: FIXTURE.sequenceScope,
    sequence: 1,
    operationId: FIXTURE.operationId,
    mediaType: FIXTURE.mediaType,
    endpointIdentity: FIXTURE.endpointIdentity,
    payload: phase3SequenceCanonicalMutation(),
    requestId: FIXTURE.requestId,
    date: FIXTURE.date,
    ...overrides,
  };
}

describeWithPostgres('P3-02 PostgreSQL Sequence owner exact retry entry gate', () => {
  let isolated: IsolatedPostgresRuntime;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('p3_sequence_entry', {
      maxConnections: 8,
      applicationName: 'known-p3-sequence-entry',
    });
    runtime = isolated.runtime;
    await runMigrations(runtime.db, 'latest');
    await createPhase3SequenceEntryHarness(runtime.db).ensurePrivateSchema();
  });

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await resetFixture();
  });

  async function resetFixture(): Promise<void> {
    const client = await runtime.pool.connect();
    try {
      await client.query('begin');
      await truncateGuardedTablesInTransaction(client, `
        truncate table p3_sequence_reuse_audits, p3_sequence_receipts,
          p3_sync_operation_claims, p3_sequence_lanes,
          product_command_receipts, outbox_events, audit_events, operations,
          policy_revisions, content_revisions, children_revisions, resource_revisions,
          collection_policies, collection_members, nodes, collections, resource_id_ledger cascade
      `);
      await client.query(
        `insert into accounts (id, subject_id, status) values ($1, $1, 'active')
         on conflict (id) do nothing`,
        [FIXTURE.principalId],
      );
      await client.query(
        `insert into profiles (account_id, display_name) values ($1, 'P3 Sequence owner')
         on conflict (account_id) do nothing`,
        [FIXTURE.principalId],
      );
      await client.query(
        `insert into resource_id_ledger (resource_id, resource_type) values
         ($1, 'collection'), ($2, 'node'), ($3, 'node')`,
        [FIXTURE.collectionId, FIXTURE.rootId, FIXTURE.nodeId],
      );
      await client.query(
        `insert into collections (
           id, owner_subject_id, title, summary, kind, visibility, root_node_id,
           resource_revision, content_revision, policy_revision, commit_ordinal
         ) values ($1, $2, 'P3 Sequence', null, 'bookmarks', 'private', $3,
           'collection-r1', 'content-r1', 'policy-r1', 1)`,
        [FIXTURE.collectionId, FIXTURE.principalId, FIXTURE.rootId],
      );
      await client.query(
        `insert into nodes (
           id, collection_id, parent_id, kind, is_root, title, url, description, tags,
           visibility, position_token, resource_revision, children_revision
         ) values
         ($1, $3, null, 'folder', true, 'P3 Sequence', null, null, '[]'::jsonb,
          'inherit', null, 'root-r1', 'root-children-r1'),
         ($2, $3, $1, 'bookmark', false, 'Before', 'https://example.test/before', null,
          '[]'::jsonb, 'inherit', 'U', 'node-r1', 'node-children-r1')`,
        [FIXTURE.rootId, FIXTURE.nodeId, FIXTURE.collectionId],
      );

      const collection = (await client.query('select * from collections where id = $1', [FIXTURE.collectionId])).rows[0];
      const collectionPayload = materializeCollectionPayload({
        id: collection.id, ownerSubjectId: collection.owner_subject_id, title: collection.title,
        summary: collection.summary, kind: collection.kind, visibility: collection.visibility,
        rootNodeId: collection.root_node_id, resourceRevision: collection.resource_revision,
        contentRevision: collection.content_revision, policyRevision: collection.policy_revision,
        commitOrdinal: collection.commit_ordinal, createdAt: collection.created_at,
        updatedAt: collection.updated_at, deletedAt: collection.deleted_at,
      });
      assert.equal(collectionPayload.ok, true);
      if (!collectionPayload.ok) throw new Error(collectionPayload.reason);
      await client.query(
        `update collections set payload_json=$2::jsonb, payload_schema_version=1,
          payload_authority_status='backfilled' where id=$1`,
        [FIXTURE.collectionId, JSON.stringify(collectionPayload.payload)],
      );

      const nodes = await client.query('select * from nodes where id=any($1::text[])', [[FIXTURE.rootId, FIXTURE.nodeId]]);
      for (const row of nodes.rows) {
        const nodePayload = materializeNodePayload({
          id: row.id, collectionId: row.collection_id, parentId: row.parent_id, kind: row.kind,
          isRoot: row.is_root, title: row.title, url: row.url, description: row.description,
          tags: row.tags, visibility: row.visibility, positionToken: row.position_token,
          resourceRevision: row.resource_revision, childrenRevision: row.children_revision,
          createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
          deletedCommitOrdinal: row.deleted_commit_ordinal,
        });
        assert.equal(nodePayload.ok, true);
        if (!nodePayload.ok) throw new Error(nodePayload.reason);
        await client.query(
          `update nodes set payload_json=$2::jsonb, payload_schema_version=1,
            payload_authority_status='backfilled' where id=$1`,
          [row.id, JSON.stringify(nodePayload.payload)],
        );
      }
      await client.query('commit');
    } catch (error: unknown) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  test('declares Sequence as the only owner, admits exactly one Operation, and replays immutable committed evidence', async () => {
    const harness = createPhase3SequenceEntryHarness(runtime.db);
    assert.equal(harness.operationIdReservationOwner, 'sequence');
    assert.equal(harness.maxBatchOperations, 1);
    assert.equal(harness.usesPushCoordinator, false);

    const first = await harness.admit(request());
    assert.equal(first.result.kind, 'executed');
    const committed = await harness.inspect(FIXTURE.collectionId);
    const storedReceipt = await harness.inspectReceipt(FIXTURE.replicaId, FIXTURE.sequenceScope, 1);
    const replay = await harness.admit(request({
      requestId: 'request-random-b',
      date: 'Sat, 25 Jul 2026 03:00:01 GMT',
    }));
    assert.equal(replay.result.kind, 'replayed');
    if (first.result.kind !== 'executed' || replay.result.kind !== 'replayed') assert.fail('expected receipt results');
    assert.deepEqual(replay.result.receipt, first.result.receipt);
    assert.deepEqual(await harness.inspect(FIXTURE.collectionId), committed);
    assert.deepEqual(
      await harness.inspectReceipt(FIXTURE.replicaId, FIXTURE.sequenceScope, 1),
      storedReceipt,
    );
    assert.ok(first.operationResult);
    if (!storedReceipt) assert.fail('expected stored terminal receipt');
    assert.deepEqual({ ...storedReceipt, result: { ...storedReceipt.result } }, {
      operationId: FIXTURE.operationId,
      replicaId: FIXTURE.replicaId,
      sequenceScope: FIXTURE.sequenceScope,
      sequence: 1,
      digest: createPhase3SequenceRequestDigest(request()),
      status: 'applied',
      result: { ...first.operationResult },
      sessionId: FIXTURE.sessionId,
      leaseGeneration: FIXTURE.leaseGeneration,
      batchId: FIXTURE.batchId,
      mediaType: FIXTURE.mediaType,
      endpointIdentity: FIXTURE.endpointIdentity,
    });
    assert.deepEqual(committed, {
      nodeTitle: 'After exact retry', nodeRevision: first.operationResult.resourceRevision,
      collectionContentRevision: first.operationResult.contentRevision, commitOrdinal: '2',
      resourceLedgerEntries: 4, resourceRevisions: 1, contentRevisions: 1,
      childrenRevisions: 0, policyRevisions: 0,
      operations: 1, sequenceReceipts: 1, operationClaims: 1,
      conflicts: 0, tombstones: 0, auditEvents: 1, outboxEvents: COMMITTED_OUTBOX_EVENTS,
    });
  });

  test.each(PHASE3_SEQUENCE_FAULT_POINTS)(
    'rolls back every ledger and preserves revision when failure occurs at %s',
    async (point) => {
      const harness = createPhase3SequenceEntryHarness(runtime.db, {
        faultInjector: { async after(candidate) { if (candidate === point) throw new Phase3SequenceEntryFaultError(point); } },
      });
      await assert.rejects(harness.admit(request()), (error: unknown) =>
        error instanceof Phase3SequenceEntryFaultError && error.point === point);
      assert.deepEqual(await harness.inspect(FIXTURE.collectionId), {
        nodeTitle: 'Before', nodeRevision: 'node-r1', collectionContentRevision: 'content-r1',
        commitOrdinal: '1', resourceLedgerEntries: 3, resourceRevisions: 0,
        contentRevisions: 0, childrenRevisions: 0, policyRevisions: 0,
        operations: 0, sequenceReceipts: 0,
        operationClaims: 0, conflicts: 0, tombstones: 0, auditEvents: 0, outboxEvents: 0,
      });
    },
  );

  test('treats a lost commit acknowledgement as unknown and exact retry discovers the one committed result', async () => {
    let loseAcknowledgement = true;
    const uncertain = createPhase3SequenceEntryHarness(runtime.db, {
      faultInjector: {
        async after(point) {
          if (point === 'commit_outcome' && loseAcknowledgement) {
            loseAcknowledgement = false;
            throw new Phase3SequenceEntryFaultError(point);
          }
        },
      },
    });
    await assert.rejects(uncertain.admit(request()), (error: unknown) =>
      error instanceof Phase3SequenceEntryFaultError && error.point === 'commit_outcome');
    const committed = await uncertain.inspect(FIXTURE.collectionId);
    const committedReceipt = await uncertain.inspectReceipt(FIXTURE.replicaId, FIXTURE.sequenceScope, 1);
    const childPath = fileURLToPath(new URL('../../fixtures/phase3/sequence-replay-child.ts', import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', childPath], {
      env: {
        ...process.env,
        DATABASE_URL: isolated.databaseUrl,
        KNOWN_TEST_DATABASE_URL: isolated.databaseUrl,
        NODE_ENV: 'test',
      },
      timeout: 15_000,
      windowsHide: true,
    });
    const restarted = JSON.parse(stdout) as {
      readonly kind: string;
      readonly result: Phase3SequenceEntryResult['operationResult'];
      readonly receipt: unknown;
      readonly evidence: unknown;
    };
    assert.equal(restarted.kind, 'replayed');
    assert.ok(committedReceipt);
    if (!committedReceipt) assert.fail('expected committed receipt after unknown outcome');
    assert.deepEqual(restarted.result, { ...committedReceipt.result });
    assert.deepEqual(restarted.receipt, JSON.parse(JSON.stringify(committedReceipt)));
    assert.deepEqual(restarted.evidence, committed);
    assert.equal(committed.operations, 1);
    assert.equal(committed.sequenceReceipts, 1);
    assert.equal(committed.operationClaims, 1);
    assert.equal(committed.auditEvents, 1);
    assert.equal(committed.outboxEvents, COMMITTED_OUTBOX_EVENTS);
    assert.equal(committed.conflicts, 0);
    assert.equal(committed.tombstones, 0);
  }, 20_000);

  test('rejects different-digest sequence reuse and lifetime opId reuse without a second canonical side effect', async () => {
    const harness = createPhase3SequenceEntryHarness(runtime.db);
    await harness.admit(request());
    const committed = await harness.inspect(FIXTURE.collectionId);

    const sequenceReuse = await harness.admit(request({
      payload: phase3SequenceCanonicalMutation('phase3-sequence-operation-2'),
      operationId: 'phase3-sequence-operation-2',
    }));
    assert.equal(sequenceReuse.result.kind, 'sequence_reuse');

    await assert.rejects(() => harness.admit(request({
      sequenceScope: `${FIXTURE.sequenceScope}:other`,
    })), /request_binding_mismatch/);
    const opIdReuse = await harness.admit(request({
      sequence: 2,
      payload: phase3SequenceCanonicalMutation(),
    }));
    assert.equal(opIdReuse.result.kind, 'op_id_reused');
    assert.deepEqual(await harness.inspect(FIXTURE.collectionId), committed);
    assert.deepEqual(await harness.inspectReuseCodes(), ['sequence_reuse', 'op_id_reused']);
  });

  test('serializes two independent PostgreSQL connections claiming the same lane and commits once', async () => {
    const leftRuntime = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 1, applicationName: 'known-p3-sequence-claim-left',
      connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000,
    });
    const rightRuntime = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 1, applicationName: 'known-p3-sequence-claim-right',
      connectionTimeoutMs: 5_000, idleTimeoutMs: 1_000,
    });
    try {
      const first = createPhase3SequenceEntryHarness(leftRuntime.db);
      const second = createPhase3SequenceEntryHarness(rightRuntime.db);
      const [left, right] = await Promise.all([first.admit(request()), second.admit(request())]);
      assert.deepEqual(new Set([left.result.kind, right.result.kind]), new Set(['executed', 'replayed']));
      const evidence = await first.inspect(FIXTURE.collectionId);
      assert.deepEqual(evidence, {
        nodeTitle: 'After exact retry',
        nodeRevision: left.operationResult?.resourceRevision ?? right.operationResult?.resourceRevision,
        collectionContentRevision: left.operationResult?.contentRevision ?? right.operationResult?.contentRevision,
        commitOrdinal: '2', resourceLedgerEntries: 4, resourceRevisions: 1,
        contentRevisions: 1, childrenRevisions: 0, policyRevisions: 0,
        operations: 1, sequenceReceipts: 1, operationClaims: 1,
        conflicts: 0, tombstones: 0, auditEvents: 1, outboxEvents: COMMITTED_OUTBOX_EVENTS,
      });
    } finally {
      await Promise.all([leftRuntime.close(), rightRuntime.close()]);
    }
  });

  test('canonical digest binds durable identity and payload but excludes request ID and Date', async () => {
    const base = request();
    const digest = createPhase3SequenceRequestDigest(base);
    assert.equal(createPhase3SequenceRequestDigest({ ...base, requestId: 'random-other', date: 'Mon, 27 Jul 2026 00:00:00 GMT' }), digest);
    for (const changed of [
      { session: await verifiedSessionFor('other-session') },
      { leaseGeneration: FIXTURE.leaseGeneration + 1 }, { batchId: `${FIXTURE.sessionId}.other` },
      { replicaId: `${FIXTURE.replicaId}-other` },
      { sequenceScope: `${FIXTURE.sequenceScope}:other` },
      { operationId: 'phase3-sequence-operation-other', payload: phase3SequenceCanonicalMutation('phase3-sequence-operation-other') },
      { sequence: 2 }, { mediaType: 'application/json' }, { endpointIdentity: 'manifest:endpoints.other' },
      { payload: { ...base.payload, mutation: { ...base.payload.mutation, expectedResourceRevision: 'node-r0' } } },
    ]) {
      assert.notEqual(createPhase3SequenceRequestDigest({ ...base, ...changed }), digest);
    }
  });

  test('accepts a COLP opaque batchId bound with a dot and rejects an unbound opaque ID', async () => {
    const harness = createPhase3SequenceEntryHarness(runtime.db);
    await assert.doesNotReject(harness.admit(request({ batchId: `${FIXTURE.sessionId}.batch-1` })));
    await assert.rejects(
      harness.admit(request({ batchId: 'different-session.batch-1' })),
      /batchId must be bound to the verified Session/u,
    );
  });

  test('rejects a second batch item before opening the Sequence transaction', async () => {
    const harness = createPhase3SequenceEntryHarness(runtime.db);
    await assert.rejects(harness.admitBatch([request(), request({ sequence: 2 })]), /maxBatchOperations=1/);
    const evidence = await harness.inspect(FIXTURE.collectionId);
    assert.equal(evidence.operations, 0);
    assert.equal(evidence.sequenceReceipts, 0);
    assert.equal(evidence.operationClaims, 0);
    assert.equal(evidence.resourceLedgerEntries, 3);
    assert.equal(evidence.resourceRevisions, 0);
    assert.equal(evidence.contentRevisions, 0);
    assert.equal(evidence.auditEvents, 0);
    assert.equal(evidence.outboxEvents, 0);
  });

  test('database constraints reject mutation or deletion of a terminal receipt', async () => {
    const harness = createPhase3SequenceEntryHarness(runtime.db);
    await harness.admit(request());
    const before = await harness.inspectReceipt(FIXTURE.replicaId, FIXTURE.sequenceScope, 1);
    const client = await runtime.pool.connect();
    try {
      await assert.rejects(
        client.query(
          `update p3_sequence_receipts set result_json = '{"status":"applied"}'::jsonb
           where replica_id=$1 and sequence_scope=$2 and sequence_number=1`,
          [FIXTURE.replicaId, FIXTURE.sequenceScope],
        ),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
      await assert.rejects(
        client.query(
          `delete from p3_sequence_receipts
           where replica_id=$1 and sequence_scope=$2 and sequence_number=1`,
          [FIXTURE.replicaId, FIXTURE.sequenceScope],
        ),
        (error: unknown) => (error as { code?: string }).code === '23514',
      );
    } finally {
      client.release();
    }
    assert.deepEqual(
      await harness.inspectReceipt(FIXTURE.replicaId, FIXTURE.sequenceScope, 1),
      before,
    );
  });
});

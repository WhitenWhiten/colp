import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  runPostgresEditorPagingEvidence,
  type PostgresEditorPagingEvidence,
} from '../../../scripts/evidence/postgres-editor-paging.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL 10k Editor paging evidence', () => {
  let isolated: IsolatedPostgresRuntime;
  let evidence: PostgresEditorPagingEvidence;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('editor_paging_evidence', {
      maxConnections: 8,
      applicationName: 'known-editor-paging-evidence',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    evidence = await runPostgresEditorPagingEvidence(isolated.runtime);
    console.info(JSON.stringify(evidence, null, 2));
  }, 240_000);

  afterAll(async () => {
    await isolated?.close();
  });

  test('fully traverses every configured page size with exact ordered identities', () => {
    assert.ok(evidence.environment.nodeCount >= 10_000);
    assert.deepEqual(
      evidence.traversals.slice(0, evidence.thresholds.pageSizes.length).map((item) => item.pageSize),
      evidence.thresholds.pageSizes,
    );
    for (const traversal of evidence.traversals) {
      assert.equal(traversal.duplicateCount, 0);
      assert.deepEqual(traversal.missingIds, []);
      assert.deepEqual(traversal.unexpectedIds, []);
      assert.equal(traversal.strictlyOrdered, true);
      assert.ok(traversal.pageCount > 1);
    }
    assert.equal(evidence.pass.exactTraversal, true);
  });

  test('captures bounded first, middle, final, p95, and full-traversal latency', () => {
    for (const traversal of evidence.traversals) {
      assert.ok(traversal.pageLatencyMs.p95 <= evidence.thresholds.pageP95Ms);
      assert.ok(traversal.landmarks.firstMs <= evidence.thresholds.landmarkPageMs);
      assert.ok(traversal.landmarks.middleMs <= evidence.thresholds.landmarkPageMs);
      assert.ok(traversal.landmarks.finalMs <= evidence.thresholds.landmarkPageMs);
      assert.ok(traversal.elapsedMs <= evidence.thresholds.fullTraversalMs);
    }
    assert.equal(evidence.pass.latency, true);
  });

  test('uses the live keyset index without a nodes sort or sequential scan', () => {
    assert.deepEqual(evidence.plans.map((plan) => plan.location), ['first', 'middle', 'final']);
    for (const plan of evidence.plans) {
      assert.ok(plan.indexNames.includes('nodes_live_editor_keyset_idx'));
      assert.equal(plan.hasSort, false);
      assert.equal(plan.hasNodesSequentialScan, false);
      assert.ok(plan.executionMs <= evidence.thresholds.planExecutionMs);
    }
    assert.equal(evidence.pass.plans, true);
  });

  test('allows other-collection writers and fences traversed-collection writers', () => {
    for (const operation of ['insert', 'update', 'delete'] as const) {
      assert.ok(evidence.writers.some((writer) =>
        writer.operation === operation && writer.collection === 'other'));
      assert.ok(evidence.writers.some((writer) =>
        writer.operation === operation
        && writer.collection === 'traversed'
        && writer.staleCursorOutcome === 'snapshot_expired'));
    }
    assert.ok(evidence.writers.every((writer) =>
      writer.elapsedMs <= evidence.thresholds.writerTransactionMs));
    assert.equal(evidence.pass.concurrentWriters, true);
  });

  test('rejects tampered and absolutely expired cursors and passes every gate', () => {
    assert.deepEqual(evidence.cursorChecks, {
      tampered: 'invalid_cursor',
      expired: 'invalid_cursor',
    });
    assert.equal(evidence.pass.cursorErrors, true);
    assert.equal(evidence.pass.overall, true);
  });
});

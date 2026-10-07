import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';

import {
  ARCHIVE_HOT_SOURCE_STATES,
  ARCHIVE_OBJECT_STATES,
  ARCHIVE_READ_STATES,
  createPostgresLedgerArchiveSegmentRepository,
  evaluateLedgerArchivePolicy,
  evaluateLedgerArchivePolicyFromLinear,
  lifecycleFromLinearState,
  runMigrations,
  type CreateLedgerArchiveSegmentInput,
  type LedgerArchiveSegmentState,
} from '../../../src/infrastructure/database/index.js';
import { LEDGER_ARCHIVE_STATES as LINEAR_STATES } from '../../../src/infrastructure/database/ledger-archive-segment-repository.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('ledger archive orthogonal policy', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('ledger_archive_policy', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('SQL decisions match TypeScript for every orthogonal combination and linear map', async () => {
    for (const objectState of ARCHIVE_OBJECT_STATES) {
      for (const readState of ARCHIVE_READ_STATES) {
        for (const hotSourceState of ARCHIVE_HOT_SOURCE_STATES) {
          for (const legalHold of [false, true]) {
            const ts = evaluateLedgerArchivePolicy({
              objectState, readState, hotSourceState, legalHold,
            });
            const sqlDecision = await sql<{ decisions: typeof ts }>`
              SELECT ledger_archive_policy_decisions(
                ${objectState}, ${readState}, ${hotSourceState}, ${legalHold}
              ) AS decisions
            `.execute(isolated.runtime.db);
            assert.deepEqual(sqlDecision.rows[0]?.decisions, ts,
              `${objectState}/${readState}/${hotSourceState}/${legalHold}`);
          }
        }
      }
    }
    for (const state of LINEAR_STATES) {
      const mapped = await sql<{
        object_state: string; read_state: string; hot_source_state: string;
      }>`SELECT * FROM ledger_archive_lifecycle_from_linear(${state})`.execute(isolated.runtime.db);
      assert.deepEqual(mapped.rows[0], {
        object_state: lifecycleFromLinearState(state).objectState,
        read_state: lifecycleFromLinearState(state).readState,
        hot_source_state: lifecycleFromLinearState(state).hotSourceState,
      }, state);
    }
  });

  test('repository dual-read keeps orthogonal columns aligned through the linear path', async () => {
    const repository = createPostgresLedgerArchiveSegmentRepository(isolated.runtime.db);
    let segment = await repository.create(manifest());
    for (const target of LINEAR_STATES.slice(1) as LedgerArchiveSegmentState[]) {
      segment = await repository.transition({
        segmentId: segment.segmentId,
        expectedState: segment.state,
        expectedRevision: segment.stateRevision,
        targetState: target,
        evidence: { changeId: `${target}-policy`, verifiedBy: 'policy-integration' },
      });
      const stored = await sql<{
        state: string; object_state: string; read_state: string; hot_source_state: string;
      }>`
        SELECT state, object_state, read_state, hot_source_state
          FROM ledger_archive_segments WHERE segment_id = ${segment.segmentId}::uuid
      `.execute(isolated.runtime.db);
      const row = stored.rows[0];
      assert.ok(row);
      assert.deepEqual({
        object_state: row.object_state, read_state: row.read_state, hot_source_state: row.hot_source_state,
      }, {
        object_state: lifecycleFromLinearState(row.state).objectState,
        read_state: lifecycleFromLinearState(row.state).readState,
        hot_source_state: lifecycleFromLinearState(row.state).hotSourceState,
      });
      assert.equal(
        evaluateLedgerArchivePolicyFromLinear(row.state, false).canAdvanceFloor,
        row.object_state === 'verified' || row.object_state === 'deleted',
      );
    }
    await assert.rejects(sql`
      UPDATE ledger_archive_segments
         SET object_state = 'unavailable'
       WHERE segment_id = ${segment.segmentId}::uuid
    `.execute(isolated.runtime.db), /lifecycle/i);
  });
});

function manifest(): CreateLedgerArchiveSegmentInput {
  return {
    segmentId: randomUUID(),
    ledgerFamily: 'operations',
    sourceRelation: 'public.operations',
    sourceScope: `policy:${randomUUID()}`,
    sourceKeyKind: 'bigint',
    sourceKeyComparator: 'signed-bigint-ascending-v1',
    sourceKeyBounds: { lowerInclusive: 1n, upperExclusive: 2n },
    rowCount: 1n,
    sourceBytes: 128n,
    contentDigest: `sha256:${'b'.repeat(64)}`,
    archiveObjectUri: 's3://known-ledgers/policy/1-2.parquet',
    archiveObjectEtag: 'policy-etag',
    archiveSchemaVersion: 1,
    kmsKeyId: 'kms:known:ledger-archive-v1',
    deleteAfter: new Date('2020-01-01T00:00:00.000Z'),
  };
}

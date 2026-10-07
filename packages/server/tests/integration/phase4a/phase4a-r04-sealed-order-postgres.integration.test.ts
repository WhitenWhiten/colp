/**
 * P4A cross-control sealed-order regression (I16 sealed-run root cause):
 * R03 `late_upload` immediately followed by R04
 * `replacement_cleanup_finalize_races` on ONE runtime, ONE schema and ONE
 * in-memory store — exactly the sealed I16 order (R03×3 -> R04-12 ->
 * R04-13).
 *
 * The sealed run failed at the R04 seed's `verifyToStoredPrivate`
 * (`r04_races_seed_failed:stored_private`) because the R03 control's
 * before-deadline complete enqueued a verification outbox event the control
 * never consumed; the R04 seed's repository claim takes the OLDEST pending
 * event with no target filter, so it verified the WRONG (R03) blob and left
 * its own event pending. This suite proves both halves of the fix:
 *
 *  - the R03 control leaves ZERO pending/retryable/leased verification
 *    events in the schema (the before-deadline event was consumed through
 *    the production worker route and the blob converged to `stored_private`);
 *  - the R04 races control then completes the R01 executor contract on the
 *    same schema (its claims are never polluted), and its own
 *    target-aware claim loop keeps the outbox clean for the next control.
 *
 * Anti-false-negative: the R03 control crosses the DB-clock intent deadline
 * (~8s headroom) with a generous test timeout; the R04 control includes a
 * cleanup PROCESS restart on a genuinely NEW pool.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts } from '../../../src/infrastructure/database/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I16NegativeControlExecutor,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  executeR03LateUploadControl,
  type R03ControlDeps,
  type R03LateUploadControlFacts,
} from '../../../scripts/evidence/phase4a-r03-controls.js';
import {
  executeR04ReplacementCleanupFinalizeRacesControl,
  type R04ControlDeps,
  type R04RacesControlFacts,
} from '../../../scripts/evidence/phase4a-r04-controls.js';
import {
  R04_COLLECTION,
  R04ObjectStore,
  makeActor,
  makeR04Config,
  reopenSameSchemaRuntime,
} from '../../support/phase4a-r04-test-helpers.js';

const CONFIG = makeR04Config();
const ports = createPostgresAttachmentsPorts();
const HANDLER = 'attachments_verify_generation';

async function nonTerminalOutboxCount(runtime: I07MigrationRuntime['runtime']): Promise<number> {
  const rows = await runtime.pool.query<{ count: string }>(
    `select count(*)::text as count from outbox_events
     where handler_name = $1 and state in ('pending', 'retryable', 'leased')`,
    [HANDLER],
  );
  return Number(rows.rows[0]!.count);
}

function r03ControlDeps(
  executionLedger: I16NegativeControlExecutor,
  runtime: I07MigrationRuntime,
  store: R04ObjectStore,
  nonce: string,
): R03ControlDeps {
  return {
    executionLedger,
    runtime: runtime.runtime,
    ledger: ports,
    objectStore: store,
    config: CONFIG,
    actor: makeActor(),
    collectionId: 'r03-late-upload-sealed-order',
    nonce,
    provisionObject: async (id, body) => {
      const etag = `"etag-${id.generationId}"`;
      store.seed(id.key, body, etag);
      return etag;
    },
  };
}

function r04ControlDeps(
  executionLedger: I16NegativeControlExecutor,
  runtime: I07MigrationRuntime,
  store: R04ObjectStore,
  nonce: string,
): R04ControlDeps {
  return {
    executionLedger,
    runtime: runtime.runtime,
    ledger: ports,
    objectStore: store,
    config: CONFIG,
    actor: makeActor(),
    collectionId: R04_COLLECTION,
    nonce,
    provisionObject: async (id, body) => {
      const etag = `"etag-${id.generationId}"`;
      store.seed(id.key, body, etag);
      return etag;
    },
    reopenRuntime: () => reopenSameSchemaRuntime(runtime.databaseUrl, 'known-r04-sealed-order-restart'),
  };
}

describeWithPostgres('P4A sealed order: R03 late-upload then R04 races (I16 pollution regression)', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r04_sealed_order', { maxConnections: 16 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  // R03 late-upload crosses the DB-clock intent deadline (~8s headroom) and
  // the R04 races control drives three-way barrier interleavings + a cleanup
  // process restart, so the test needs a generous timeout.
  test('R03 late-upload leaves ZERO residual verification events, then the R04 races control passes on the same schema', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new R04ObjectStore();

    // ---- Sealed order step 1: R03 late_upload. ----
    const r03Facts: R03LateUploadControlFacts = await executeR03LateUploadControl(
      r03ControlDeps(executionLedger, isolated, store, 'r03-late-upload-before-races'),
    );
    assert.equal(r03Facts.stableCode, 'late_rejected');
    assert.equal(r03Facts.beforeDeadlineOutcome, 'completed');
    assert.equal(r03Facts.lateOutcome, 'late_rejected');
    assert.equal(r03Facts.expiredKeyNotRevived, true);

    // Root-cause assertion: after the R03 control the handler has ZERO
    // pending/retryable/leased events in this schema. The before-deadline
    // event was consumed through the production worker route (the blob
    // converged to stored_private); the late complete wrote nothing. A
    // residual here is exactly what poisoned the sealed R04 seed's claim.
    const residual = await nonTerminalOutboxCount(isolated.runtime);
    assert.equal(
      residual,
      0,
      'R03 late-upload must leave ZERO non-terminal verification events that a later claim could steal',
    );
    const beforeBlobs = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from blob_records where logical_state = 'stored_private'`,
    );
    assert.equal(Number(beforeBlobs.rows[0]!.count), 1, 'the before-deadline blob converged to stored_private');

    // ---- Sealed order step 2: R04 replacement_cleanup_finalize_races on
    // the SAME schema/store/executor. ----
    const racesFacts: R04RacesControlFacts = await executeR04ReplacementCleanupFinalizeRacesControl(
      r04ControlDeps(executionLedger, isolated, store, 'r04-races-after-r03'),
    );
    assert.equal(racesFacts.stableCode, 'winner/loser protection');
    assert.equal(racesFacts.replacementSingleWinner, true);
    assert.equal(racesFacts.finalizeSingleWinner, true);
    assert.equal(racesFacts.rollbackNoSideEffect, true);
    assert.equal(racesFacts.cleanupLeaseFenced, true);
    assert.equal(racesFacts.restartConverged, true);
    assert.equal(racesFacts.noWrongDelete, true);
    assert.equal(racesFacts.singleDbWinner, true);

    const r03Receipt = executionLedger.receiptFor('late_upload');
    assert.equal(r03Receipt.stableCode, 'late_rejected');
    assert.equal(r03Receipt.verificationSource, 'postgres-integration-suite');
    assert.equal(r03Receipt.cleanupReceipt, 'no_outbox_row_orphaned_generation_key_preserved');
    const r04Receipt = executionLedger.receiptFor('replacement_cleanup_finalize_races');
    assert.equal(r04Receipt.stableCode, 'winner/loser protection');
    assert.equal(r04Receipt.cleanupReceipt, 'single_db_winner_old_retired_active_preserved');
    assert.equal(r04Receipt.runId, executionLedger.runId, 'both receipts come from the same sealed run');

    // The R04 control leaves the outbox clean as well (its target-aware
    // claims were completed; nothing is left for the next control in the
    // sealed order).
    const afterR04 = await nonTerminalOutboxCount(isolated.runtime);
    assert.equal(afterR04, 0, 'the races control must leave the outbox clean too');
  }, 300_000);
});

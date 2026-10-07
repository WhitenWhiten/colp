/**
 * P4A-R04 PostgreSQL integration suite (part 2): the
 * `replacement_cleanup_finalize_races` negative control against the
 * PRODUCTION migration (plan §6 P4A-R04, §4.3 mutation control
 * "cleanup 从 current pointer 取 key" / "finalize 在独立 transaction 写 blob
 * binding").
 *
 * THREE independent connections with deterministic promise barriers around
 * the current-generation CAS (`replacement_cas`), the cleanup claim
 * (`before/after_cleanup_claim`) and the finalize row lock
 * (`after_finalize_handoff_lock`):
 *
 *  - replacement winner/loser: two CAS races on one blob — exactly one
 *    `activated`, the loser `stale_cas` and never moves the pointer; the DB
 *    winner is read after the interleaving and the old/winner/loser keys are
 *    independently HEADed (distinct real markers, no wrong delete);
 *  - finalize winner/rollback: one finalizer attaches, the concurrent one
 *    BLOCKS (deterministic 55P03 lock-timeout proof) and converges to
 *    `binding_conflict`; a handoff against the RETIRED generation rolls back
 *    with `generation_mismatch` and zero writes;
 *  - cleanup lease steal: owner A claims and deletes; the lease expires on
 *    the DATABASE clock; owner B takes over through the PRODUCTION fence
 *    (bumped lease generation + fresh attempt token); A's late CAS fails
 *    `lease_lost`; B converges with exactly ONE DELETE;
 *  - cleanup PROCESS restart: a mid-batch crash aborts; the lease expires on
 *    the DATABASE clock; a genuinely NEW pool + fresh attempt token re-claims
 *    through the production fence and converges (never test SQL that rewrites
 *    the lease owner);
 *  - the in-run control completes the R01 executor contract at the real DB
 *    boundary.
 *
 * Anti-false-positive: no sequential "replacement then cleanup" calls, no
 * SQL lease-owner rewrites, no checking only the database `deleted_at` —
 * every interleaving asserts the provider HEAD/DELETE logs and the active
 * marker bytes. Anti-false-negative: lock waits are proven by the stable
 * 55P03 SQLSTATE and leases expire on the database clock, never a fixed
 * short sleep.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { DatabaseOperationError, createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import type { DatabaseTransaction } from '../../../src/infrastructure/database/index.js';
import {
  runCleanupBatch,
  type FinalizeHandoffInput,
  type GenerationDeleteOutcome,
  type GenerationObjectHandle,
} from '../../../src/modules/attachments/index.js';
import { BlobStoreError, type BlobStoreFailure } from '../../../src/infrastructure/object-storage/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  I16NegativeControlExecutor,
  stableI16FailureCode,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  executeR04ReplacementCleanupFinalizeRacesControl,
  type R04ControlDeps,
  type R04RacesControlFacts,
} from '../../../scripts/evidence/phase4a-r04-controls.js';
import {
  R04_COLLECTION,
  R04ObjectStore,
  expireCleanupLeaseOnDbClock,
  generationKeyCount,
  identityFor,
  makeActor,
  makeR04Config,
  r04CleanupBoundaryConfig,
  r04Uow,
  readR04GenerationRow,
  reopenSameSchemaRuntime,
  seedReplacementRace,
  seedRetiredActivePair,
  seedStoredPrivateWithRetiredCurrent,
} from '../../support/phase4a-r04-test-helpers.js';
import type { R04SeededPair } from '../../support/phase4a-r04-test-helpers.js';

const CONFIG = makeR04Config();
const ports = createPostgresAttachmentsPorts();

function isLockTimeout(error: unknown): boolean {
  return error instanceof DatabaseOperationError && error.kind === 'lock_timeout';
}

/** Runs `operation` with a bounded SET LOCAL lock_timeout (55P03 proof). */
async function withLockTimeout<Result>(
  runtime: I07MigrationRuntime['runtime'],
  timeoutMs: number,
  operation: (tx: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  return createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
    await sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}ms'`).execute(transaction);
    return operation(transaction);
  });
}

/** Builds the finalize handoff input from the COMMITTED verified facts. */
async function handoffInputForCurrent(
  runtime: I07MigrationRuntime['runtime'],
  seeded: R04SeededPair,
  bindingId: string,
  expectedGenerationId: string,
): Promise<FinalizeHandoffInput> {
  const rows = await runtime.pool.query<{
    media_type: string | null;
    verified_size: string | null;
    verified_sha256: string | null;
    verification_policy_version: string | null;
  }>(
    `select media_type, verified_size::text as verified_size, verified_sha256, verification_policy_version
     from blob_records where blob_id = $1`,
    [seeded.blobId],
  );
  const row = rows.rows[0]!;
  return {
    blobId: seeded.blobId,
    attachmentBindingId: bindingId,
    expectedGenerationId,
    ownerSubjectId: 'r04-subject-owner',
    expectedEtag: expectedGenerationId === seeded.next.generationId ? seeded.etagNext : seeded.etagOld,
    verifiedSize: Number(row.verified_size),
    verifiedSha256: row.verified_sha256!,
    mediaType: row.media_type!,
    policyRevision: row.verification_policy_version!,
  };
}

function controlDeps(
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
    reopenRuntime: () => reopenSameSchemaRuntime(runtime.databaseUrl, 'known-r04-races-restart'),
  };
}

/**
 * In-memory fault store: makes the lease-steal sub-section's `deleteExact`
 * (the control's deterministic `lease-steal-old` generation identity) fail
 * with either a non-{deleted,not_found} class or a thrown BlobStoreError.
 * Every OTHER generation delegates to the real in-memory store, so the fault
 * reaches exactly the throw point under test and nowhere else (no real R2).
 */
class LeaseStealDeleteFaultStore extends R04ObjectStore {
  constructor(
    private readonly fault:
      | { readonly kind: 'class'; readonly resultClass: 'denied' | 'retryable' | 'unknown' }
      | { readonly kind: 'throw'; readonly failure: BlobStoreFailure },
  ) {
    super();
  }

  async deleteExact(handle: GenerationObjectHandle): Promise<GenerationDeleteOutcome> {
    if (handle.generationId.endsWith('-lease-steal-old')) {
      if (this.fault.kind === 'throw') throw new BlobStoreError(this.fault.failure);
      return { class: this.fault.resultClass };
    }
    return super.deleteExact(handle);
  }
}

describeWithPostgres('P4A-R04 replacement/cleanup/finalize races', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r04_races', { maxConnections: 16 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('replacement winner/loser: two independent CAS races on one blob; exactly one activated, the loser stale_cas; the DB winner is read and old/new keys are HEADed', async () => {
    const first = identityFor(21);
    const second = identityFor(22);
    const third = identityFor(23);
    const store = new R04ObjectStore();
    const seeded = await seedReplacementRace(isolated.runtime, store, first, second, third);

    const group = new BarrierGroup();
    const runCas = (newGenerationId: string) => createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.activateReplacement(transaction, {
        blobId: seeded.blobId,
        expectedActiveGenerationId: first.generationId,
        newGenerationId,
      }, { barrier: group }));
    const casA = runCas(second.generationId);
    const casB = runCas(third.generationId);
    await group.waitArrived('replacement_cas', 2);
    group.release('replacement_cas');
    const [resultA, resultB] = await Promise.all([casA, casB]);

    const results = [resultA, resultB];
    const activated = results.filter((result) => result.outcome === 'activated');
    const stale = results.filter((result) => result.outcome === 'stale_cas');
    assert.equal(activated.length, 1, 'exactly one replacement CAS may win');
    assert.equal(stale.length, 1, 'the loser must fail stale_cas');
    const winnerId = resultA.outcome === 'activated' ? second.generationId : third.generationId;
    const loserId = winnerId === second.generationId ? third.generationId : second.generationId;

    // The DATABASE winner is the activated generation — never both, never none.
    const dbRows = await isolated.runtime.pool.query<{ current_generation_id: string | null }>(
      'select current_generation_id from blob_records where blob_id = $1',
      [seeded.blobId],
    );
    assert.equal(dbRows.rows[0]!.current_generation_id, winnerId);
    const activeRows = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from blob_generations
       where blob_id = $1 and generation_state = 'active'`,
      [seeded.blobId],
    );
    assert.equal(Number(activeRows.rows[0]!.count), 1, 'exactly one active generation per blob');

    // Independent HEAD of the old/winner/loser keys (distinct real markers):
    // the winner marker is present, the loser candidate and the retired old
    // key were never deleted (no wrong delete).
    const winnerKey = winnerId === second.generationId ? second.key : third.key;
    const loserKey = loserId === second.generationId ? second.key : third.key;
    const headWinner = await store.headExact({ generationId: winnerId, key: winnerKey });
    assert.equal(headWinner.class, 'ok', 'the winner marker is present');
    const headLoser = await store.headExact({ generationId: loserId, key: loserKey });
    assert.equal(headLoser.class, 'ok', 'the loser candidate is never deleted (no wrong delete)');
    const headOld = await store.headExact({ generationId: first.generationId, key: first.key });
    assert.equal(headOld.class, 'ok', 'the retired old marker is never deleted by the CAS race');
    assert.equal(store.deleteCountFor(second.key), 0);
    assert.equal(store.deleteCountFor(third.key), 0);
    assert.equal(store.deleteCountFor(first.key), 0);
  });

  test('finalize winner/rollback: the concurrent finalizer blocks (55P03) then binding_conflict; a handoff against the RETIRED generation rolls back with zero writes', async () => {
    const original = identityFor(24);
    const current = identityFor(25);
    const store = new R04ObjectStore();
    const seeded = await seedStoredPrivateWithRetiredCurrent(isolated.runtime, store, original, current, CONFIG);
    const winnerBinding = 'r04-test-binding-winner';
    const loserBinding = 'r04-test-binding-loser';
    const rollbackBinding = 'r04-test-binding-rollback';
    const winnerInput = await handoffInputForCurrent(isolated.runtime, seeded, winnerBinding, current.generationId);
    const loserInput = await handoffInputForCurrent(isolated.runtime, seeded, loserBinding, current.generationId);
    const rollbackInput = await handoffInputForCurrent(isolated.runtime, seeded, rollbackBinding, original.generationId);

    // Rollback FIRST (the blob is still `stored_private`, no binding): a
    // handoff against the RETIRED generation is refused with
    // `generation_mismatch` and ZERO writes — the binding stays null and the
    // blob stays `stored_private`. (Once a binding exists the production
    // fence correctly classifies any other binding as `binding_conflict`
    // BEFORE the generation check.)
    const rollback = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, rollbackInput));
    assert.equal(rollback.outcome, 'generation_mismatch');
    const afterRollback = await isolated.runtime.pool.query<{
      logical_state: string;
      attachment_binding_id: string | null;
    }>(
      'select logical_state, attachment_binding_id from blob_records where blob_id = $1',
      [seeded.blobId],
    );
    assert.equal(afterRollback.rows[0]!.logical_state, 'stored_private', 'the rollback writes nothing');
    assert.equal(afterRollback.rows[0]!.attachment_binding_id, null, 'the rollback writes no binding');

    const group = new BarrierGroup();
    const winnerPromise = createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, winnerInput, { barrier: group }));
    await group.waitArrived('after_finalize_handoff_lock');

    // The concurrent finalizer BLOCKS on the FOR UPDATE row lock: the stable
    // 55P03 lock-timeout proves the serialization (never a random sleep).
    await assert.rejects(
      withLockTimeout(isolated.runtime, 400, (tx) => ports.finalizeHandoff(tx, loserInput)),
      isLockTimeout,
      'the second finalizer must block on the row lock',
    );
    group.release('after_finalize_handoff_lock');
    const winner = await winnerPromise;
    assert.equal(winner.outcome, 'attached');
    if (winner.outcome === 'attached') assert.equal(winner.binding.attachmentBindingId, winnerBinding);

    // The loser converges to binding_conflict — never a blind redo.
    const loser = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.finalizeHandoff(transaction, loserInput));
    assert.equal(loser.outcome, 'binding_conflict');

    // Independent HEAD of the old/new keys: finalize never touches the
    // provider; the committed binding winner is the ONLY DB binding.
    const headOld = await store.headExact(
      { generationId: original.generationId, key: original.key },
      { expectedEtag: seeded.etagOld },
    );
    assert.equal(headOld.class, 'ok');
    const headNew = await store.headExact(
      { generationId: current.generationId, key: current.key },
      { expectedEtag: seeded.etagNext },
    );
    assert.equal(headNew.class, 'ok');
    const bindingRows = await isolated.runtime.pool.query<{ count: string }>(
      `select count(*)::text as count from blob_records
       where blob_id = $1 and logical_state = 'attached_private'`,
      [seeded.blobId],
    );
    assert.equal(Number(bindingRows.rows[0]!.count), 1, 'exactly one committed binding');
    const bindingIdRows = await isolated.runtime.pool.query<{ attachment_binding_id: string | null }>(
      'select attachment_binding_id from blob_records where blob_id = $1',
      [seeded.blobId],
    );
    assert.equal(bindingIdRows.rows[0]!.attachment_binding_id, winnerBinding);
  });

  test('cleanup lease steal: DB-clock expiry, the PRODUCTION fence bumps the lease generation; the late owner CAS-fails lease_lost; exactly one DELETE', async () => {
    const old = identityFor(26);
    const next = identityFor(27);
    const store = new R04ObjectStore();
    const seeded = await seedRetiredActivePair(isolated.runtime, store, old, next);

    // Owner A claims through the production fence and DELETEs the exact key.
    const claimA = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.claimCleanup(transaction, {
        leaseOwner: 'r04-owner-a',
        leaseTtlSeconds: 60,
        generationId: old.generationId,
        retiredRetentionDays: 0,
      }));
    assert.equal(claimA.outcome, 'claimed');
    if (claimA.outcome !== 'claimed') return;
    const deleteA = await store.deleteExact({ generationId: old.generationId, key: old.key });
    assert.equal(deleteA.class, 'deleted');

    // The lease expires on the DATABASE clock; owner B takes over through the
    // PRODUCTION claim fence (higher lease generation + fresh attempt token).
    await expireCleanupLeaseOnDbClock(isolated.runtime, old.generationId);
    const claimB = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.claimCleanup(transaction, {
        leaseOwner: 'r04-owner-b',
        leaseTtlSeconds: 60,
        generationId: old.generationId,
        retiredRetentionDays: 0,
      }));
    assert.equal(claimB.outcome, 'claimed');
    if (claimB.outcome !== 'claimed') return;
    assert.ok(claimB.claim.leaseGeneration > claimA.claim.leaseGeneration, 'the takeover bumps the lease generation');
    assert.notEqual(claimB.claim.attemptToken, claimA.claim.attemptToken, 'the takeover issues a fresh attempt token');

    // Owner A's late CAS with the OLD fence can never commit.
    const lateA = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.completeCleanup(transaction, { claim: claimA.claim, verdict: 'deleted' }));
    assert.equal(lateA.outcome, 'lease_lost');

    // Owner B converges via the confirmed-absent HEAD (no duplicate DELETE).
    const head = await store.headExact({ generationId: old.generationId, key: old.key });
    assert.equal(head.class, 'not_found');
    const doneB = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.completeCleanup(transaction, { claim: claimB.claim, verdict: 'deleted' }));
    assert.equal(doneB.outcome, 'completed');
    assert.equal(store.deleteCountFor(old.key), 1, 'no duplicate DELETE across owners');
    const row = await readR04GenerationRow(isolated.runtime, old.generationId);
    assert.equal(row.generationState, 'deleted');
    assert.equal(await generationKeyCount(isolated.runtime, old.generationId), 1, 'the permanent tombstone survives');
    const activeHead = await store.headExact(
      { generationId: next.generationId, key: next.key },
      { expectedEtag: seeded.etagNext },
    );
    assert.equal(activeHead.class, 'ok', 'the active marker is untouched');
  });

  test('cleanup process restart: a mid-batch crash aborts; DB-clock lease expiry + a NEW pool + fresh attempt token converges; the active marker is untouched', async () => {
    const old = identityFor(28);
    const next = identityFor(29);
    const store = new R04ObjectStore();
    const seeded = await seedRetiredActivePair(isolated.runtime, store, old, next);

    // The crashed process aborts mid-batch (after the claim committed).
    await assert.rejects(
      runCleanupBatch({
        ledger: ports,
        objectStore: store,
        config: r04CleanupBoundaryConfig(CONFIG),
        uow: r04Uow(isolated.runtime),
        leaseOwner: 'r04-crash',
        faultInjector: {
          afterClaim: async () => {
            throw new Error('r04-races-restart-crash');
          },
        },
      }),
      /r04-races-restart-crash/,
    );
    const crashedRow = await readR04GenerationRow(isolated.runtime, old.generationId);
    assert.equal(crashedRow.generationState, 'deletion_pending', 'the crashed claim is durable');
    assert.equal(crashedRow.cleanupLeaseOwner, 'r04-crash');

    // The crashed worker's lease expires on the DATABASE clock; a genuinely
    // NEW pool + fresh attempt token re-claims through the PRODUCTION fence.
    await expireCleanupLeaseOnDbClock(isolated.runtime, old.generationId);
    const restarted = await reopenSameSchemaRuntime(isolated.databaseUrl, 'known-r04-races-restart');
    try {
      const restartResult = await runCleanupBatch({
        ledger: ports,
        objectStore: store,
        config: r04CleanupBoundaryConfig(CONFIG),
        uow: r04Uow(restarted),
        leaseOwner: 'r04-restart',
      });
      const outcome = restartResult.outcomes.find((entry) => entry.generationId === old.generationId);
      assert.ok(outcome);
      assert.ok(
        outcome.kind === 'deleted' || outcome.kind === 'confirmed_absent',
        `the restart must converge, got ${outcome.kind}`,
      );
      const rowAfter = await readR04GenerationRow(restarted, old.generationId);
      assert.equal(rowAfter.generationState, 'deleted');
    } finally {
      await restarted.close();
    }
    const absent = await store.confirmAbsent({ generationId: old.generationId, key: old.key });
    assert.equal(absent.absent, true, 'the restart leaves the retired key exact absent');
    const activeHead = await store.headExact(
      { generationId: next.generationId, key: next.key },
      { expectedEtag: seeded.etagNext },
    );
    assert.equal(activeHead.class, 'ok', 'the active marker is untouched across the restart');
    assert.equal(store.deleteCountFor(next.key), 0);
  });

  test('lease-steal deleteExact returning a non-{deleted,not_found} class fails closed with the class in the stable-code tail', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new LeaseStealDeleteFaultStore({ kind: 'class', resultClass: 'retryable' });
    await assert.rejects(
      executeR04ReplacementCleanupFinalizeRacesControl(
        controlDeps(executionLedger, isolated, store, 'r04-races-fault-class'),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'r04_races_seed_failed:delete:retryable', 'the provider class is carried in the tail');
        assert.equal(
          stableI16FailureCode(error),
          'r04_races_seed_failed',
          'the stable failure prefix stays recognizable',
        );
        assert.throws(
          () => executionLedger.receiptFor('replacement_cleanup_finalize_races'),
          /negative_control_not_executed/,
          'the executor must never emit a receipt',
        );
        return true;
      },
    );
  });

  test('lease-steal deleteExact throwing a BlobStoreError fails closed with class/code/status in the stable-code tail', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new LeaseStealDeleteFaultStore({
      kind: 'throw',
      failure: { class: 'retryable', code: 'rate_limited', status: 429 },
    });
    await assert.rejects(
      executeR04ReplacementCleanupFinalizeRacesControl(
        controlDeps(executionLedger, isolated, store, 'r04-races-fault-throw'),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          'r04_races_seed_failed:delete:retryable:rate_limited:429',
          'class/code/status are carried in the tail',
        );
        assert.equal(
          stableI16FailureCode(error),
          'r04_races_seed_failed',
          'the stable failure prefix stays recognizable',
        );
        assert.throws(
          () => executionLedger.receiptFor('replacement_cleanup_finalize_races'),
          /negative_control_not_executed/,
          'the executor must never emit a receipt',
        );
        return true;
      },
    );
  });

  test('the in-run control completes the executor contract at the real DB boundary', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new R04ObjectStore();
    const facts: R04RacesControlFacts = await executeR04ReplacementCleanupFinalizeRacesControl(
      controlDeps(executionLedger, isolated, store, 'r04-races-nonce'),
    );
    assert.equal(facts.stableCode, 'winner/loser protection');
    assert.equal(facts.replacementSingleWinner, true);
    assert.equal(facts.finalizeSingleWinner, true);
    assert.equal(facts.rollbackNoSideEffect, true);
    assert.equal(facts.cleanupLeaseFenced, true);
    assert.equal(facts.restartConverged, true);
    assert.equal(facts.noWrongDelete, true);
    assert.equal(facts.singleDbWinner, true);
    const receipt = executionLedger.receiptFor('replacement_cleanup_finalize_races');
    assert.equal(receipt.stableCode, 'winner/loser protection');
    assert.equal(receipt.verificationSource, 'postgres-integration-suite');
    assert.equal(receipt.cleanupReceipt, 'single_db_winner_old_retired_active_preserved');
    assert.equal(receipt.runId, executionLedger.runId);
  });
});

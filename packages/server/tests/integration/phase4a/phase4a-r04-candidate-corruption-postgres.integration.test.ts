/**
 * P4A-R04 PostgreSQL integration suite (part 3): the `candidate_corruption`
 * negative control against the PRODUCTION migration (plan §6 P4A-R04, §4.3
 * mutation control "cleanup 从 current pointer 取 key").
 *
 * The cleanup candidate ALWAYS comes from the claimed generation row (never
 * from the blob current pointer), and the coordinator's conditional HEAD
 * verifies the EXACT claimed identity before any DELETE. Here the candidate
 * HEAD returns an identity inconsistent with the ledger snapshot through the
 * response-loss decorator (which replaces ONLY the provider response — the
 * inner store performs the real side effect):
 *
 *  - generic identity mismatch (same key, different etag/size): quarantine
 *    with ZERO DELETE; the active marker stays byte-identical and the
 *    permanent tombstone survives;
 *  - ACTIVE/RETIRED identity mismatch: the retired candidate key reports the
 *    ACTIVE generation's identity (etag/size of the current marker) —
 *    quarantine with ZERO DELETE, the active marker untouched;
 *  - the ACTIVE generation is never claimable through the production fence
 *    and a batch claim never surfaces it;
 *  - the in-run control completes the R01 executor contract at the real DB
 *    boundary.
 *
 * Anti-false-positive: no mock DELETE, no checking only the database
 * `deleted_at` — the DELETE call log must be EMPTY, the generation must be
 * `quarantined` with `quarantined_reason = candidate_mismatch` and the active
 * marker must be verified byte-for-byte. Anti-false-negative: the corruption
 * is installed at the HEAD boundary and the claim snapshot comes from the
 * PRODUCTION claim SQL, so a missing HEAD override would make this test fail
 * (never a silent pass).
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts, createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { runCleanupBatch } from '../../../src/modules/attachments/index.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';
import {
  createI07MigrationRuntime,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import { I16NegativeControlExecutor } from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  executeR04CandidateCorruptionControl,
  type R04ControlDeps,
  type R04CorruptionControlFacts,
} from '../../../scripts/evidence/phase4a-r04-controls.js';
import {
  R04_COLLECTION,
  R04ObjectStore,
  R04ResponseLossStore,
  generationKeyCount,
  identityFor,
  makeActor,
  makeR04Config,
  r04CleanupBoundaryConfig,
  r04Uow,
  readR04GenerationRow,
  reopenSameSchemaRuntime,
  seedRetiredActivePair,
} from '../../support/phase4a-r04-test-helpers.js';

const CONFIG = makeR04Config();
const ports = createPostgresAttachmentsPorts();

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
    reopenRuntime: () => reopenSameSchemaRuntime(runtime.databaseUrl, 'known-r04-corruption-restart'),
  };
}

describeWithPostgres('P4A-R04 candidate corruption', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r04_corruption', { maxConnections: 16 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('candidate HEAD identity mismatch: quarantine with ZERO DELETE; the active marker and the permanent tombstone survive', async () => {
    const old = identityFor(11);
    const next = identityFor(12);
    const store = new R04ObjectStore();
    const seeded = await seedRetiredActivePair(isolated.runtime, store, old, next);
    // The candidate HEAD reports a DIFFERENT identity for the exact claimed
    // key (same key, different etag/size) while the real object is present.
    const decorated = new R04ResponseLossStore(store, {
      head: { kind: 'identity-mismatch', key: old.key, etag: '"r04-corrupt-etag"', size: 9999 },
    });

    const result = await runCleanupBatch({
      ledger: ports,
      objectStore: decorated,
      config: r04CleanupBoundaryConfig(CONFIG),
      uow: r04Uow(isolated.runtime),
      leaseOwner: 'r04-corruption-mismatch',
    });
    const outcome = result.outcomes.find((entry) => entry.generationId === old.generationId);
    assert.ok(outcome, 'the retired generation must be claimed');
    assert.equal(outcome.kind, 'quarantined');
    if (outcome.kind === 'quarantined') assert.equal(outcome.reason, 'candidate_mismatch');

    // ZERO DELETE: the mismatch short-circuits BEFORE any provider DELETE.
    assert.equal(decorated.deleteCountFor(old.key), 0, 'identity mismatch sends NO DELETE');
    assert.equal(decorated.headCountFor(old.key), 1, 'exactly one conditional HEAD decides the verdict');

    // The DB quarantine fact is recorded, the real object is still present
    // (never deleted), and the active marker is byte-identical.
    const row = await readR04GenerationRow(isolated.runtime, old.generationId);
    assert.equal(row.generationState, 'quarantined');
    assert.equal(row.quarantinedReason, 'candidate_mismatch');
    assert.ok(row.quarantinedAt);
    const stillThere = await store.headExact(
      { generationId: old.generationId, key: old.key },
      { expectedEtag: seeded.etagOld },
    );
    assert.equal(stillThere.class, 'ok', 'the quarantined object is never deleted');
    const activeHead = await store.headExact(
      { generationId: next.generationId, key: next.key },
      { expectedEtag: seeded.etagNext },
    );
    assert.equal(activeHead.class, 'ok', 'the active marker is unchanged');
    if (activeHead.class === 'ok') assert.equal(activeHead.identity.size, seeded.bodyNext.byteLength);
    assert.equal(store.deleteCountFor(next.key), 0);
    assert.equal(await generationKeyCount(isolated.runtime, old.generationId), 1, 'the permanent tombstone survives');
  });

  test('active/retired identity mismatch: the retired key reports the ACTIVE identity -> quarantine, ZERO DELETE, active marker untouched', async () => {
    const old = identityFor(13);
    const next = identityFor(14);
    const store = new R04ObjectStore();
    const seeded = await seedRetiredActivePair(isolated.runtime, store, old, next);
    // The retired candidate key now reports the ACTIVE generation's identity
    // (the exact etag/size of the current marker) — inconsistent with the
    // ledger's retired snapshot.
    const decorated = new R04ResponseLossStore(store, {
      head: {
        kind: 'identity-mismatch',
        key: old.key,
        etag: seeded.etagNext,
        size: seeded.bodyNext.byteLength,
      },
    });

    const result = await runCleanupBatch({
      ledger: ports,
      objectStore: decorated,
      config: r04CleanupBoundaryConfig(CONFIG),
      uow: r04Uow(isolated.runtime),
      leaseOwner: 'r04-corruption-active-identity',
    });
    const outcome = result.outcomes.find((entry) => entry.generationId === old.generationId);
    assert.ok(outcome);
    assert.equal(outcome.kind, 'quarantined');
    assert.equal(decorated.deleteCountFor(old.key), 0, 'the active-identity mismatch sends NO DELETE');

    const row = await readR04GenerationRow(isolated.runtime, old.generationId);
    assert.equal(row.generationState, 'quarantined');
    const activeHead = await store.headExact(
      { generationId: next.generationId, key: next.key },
      { expectedEtag: seeded.etagNext },
    );
    assert.equal(activeHead.class, 'ok', 'the ACTIVE marker is untouched');
    if (activeHead.class === 'ok') assert.equal(activeHead.identity.size, seeded.bodyNext.byteLength);
    assert.equal(store.deleteCountFor(next.key), 0);
  });

  test('the ACTIVE generation is never claimable and a batch claim never surfaces it', async () => {
    const old = identityFor(15);
    const next = identityFor(16);
    const store = new R04ObjectStore();
    await seedRetiredActivePair(isolated.runtime, store, old, next);

    const activeClaim = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.claimCleanup(transaction, {
        leaseOwner: 'r04-corruption-active',
        leaseTtlSeconds: 60,
        generationId: next.generationId,
        retiredRetentionDays: 0,
      }));
    assert.equal(activeClaim.outcome, 'not_claimable', 'the current generation is never a cleanup candidate');

    // The batch claim surfaces ONLY the retired candidate — the candidate
    // always comes from a claimed generation row, never the current pointer.
    const result = await runCleanupBatch({
      ledger: ports,
      objectStore: store,
      config: r04CleanupBoundaryConfig(CONFIG),
      uow: r04Uow(isolated.runtime),
      leaseOwner: 'r04-corruption-batch',
    });
    const claimedIds = new Set(result.outcomes.map((entry) => entry.generationId));
    assert.ok(claimedIds.has(old.generationId));
    assert.ok(!claimedIds.has(next.generationId), 'the active key never appears in a cleanup batch');
    assert.equal(store.deleteCountFor(next.key), 0);
    const outcome = result.outcomes.find((entry) => entry.generationId === old.generationId);
    assert.equal(outcome?.kind, 'deleted');
  });

  test('the in-run control completes the executor contract at the real DB boundary', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new R04ObjectStore();
    const facts: R04CorruptionControlFacts = await executeR04CandidateCorruptionControl(
      controlDeps(executionLedger, isolated, store, 'r04-corruption-nonce'),
    );
    assert.equal(facts.stableCode, 'quarantined');
    assert.equal(facts.deleteCalls, 0);
    assert.equal(facts.quarantined, true);
    assert.equal(facts.activePreserved, true);
    const receipt = executionLedger.receiptFor('candidate_corruption');
    assert.equal(receipt.stableCode, 'quarantined');
    assert.equal(receipt.verificationSource, 'postgres-integration-suite');
    assert.equal(receipt.cleanupReceipt, 'zero_delete_quarantined_active_preserved');
    assert.equal(receipt.runId, executionLedger.runId);
  });
});

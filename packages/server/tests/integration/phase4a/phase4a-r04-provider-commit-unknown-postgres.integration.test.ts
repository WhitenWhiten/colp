/**
 * P4A-R04 PostgreSQL integration suite (part 1): the `provider_commit_unknown`
 * negative control against the PRODUCTION migration (plan §6 P4A-R04, §4.3
 * mutation control "commit error 后直接重做外部副作用").
 *
 * Drives the PRODUCTION cleanup coordinator through the response-loss adapter
 * decorator, which loses the provider response around REAL DELETE/HEAD side
 * effects (the inner store is the real port surface — real R2 in the I16
 * run, this recording store in the focused suites):
 *
 *  - DELETE 2xx lands but the response is lost: the coordinator's repeated
 *    exact-key HEAD converges to absent and commits `deleted` (a DELETE 2xx
 *    alone is never completion; the DB `deleted_at` alone is never enough);
 *  - the request is never determined to have arrived: the outcome stays
 *    `unknown_retryable`, the claim is RELEASED, no success/failure is
 *    asserted prematurely, and a cleanup PROCESS RESTART (a genuinely NEW
 *    pool + fresh attempt token after DB-clock lease expiry) converges;
 *  - the object is initially absent (expired-intent orphan): `confirmed_absent`
 *    with ZERO DELETE;
 *  - unknown handling never treats the ACTIVE key as claimable/retryable and
 *    never clears the permanent tombstone (reissue rejected, SQLSTATE 23505);
 *  - the in-run control completes the R01 executor contract at the real DB
 *    boundary.
 *
 * Anti-false-positive: no mock DELETE, no checking only the database
 * `deleted_at`, no sequential cleanup — every scenario asserts the provider
 * call log (side-effect count, zero DELETE) AND the exact-key absence AND the
 * active marker bytes. Anti-false-negative: a DELETE 2xx with a lost response
 * and an initially absent object both converge via a SECOND HEAD; a provider
 * timeout stays `unknown_retryable` and is never asserted as success or
 * failure.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  executeR04ProviderCommitUnknownControl,
  type R04ControlDeps,
  type R04ProviderUnknownControlFacts,
} from '../../../scripts/evidence/phase4a-r04-controls.js';
import {
  R04_COLLECTION,
  R04ObjectStore,
  R04ResponseLossStore,
  expireCleanupLeaseOnDbClock,
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
    reopenRuntime: () => reopenSameSchemaRuntime(runtime.databaseUrl, 'known-r04-unknown-restart'),
  };
}

describeWithPostgres('P4A-R04 provider commit unknown', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('r04_provider_unknown', { maxConnections: 16 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('DELETE 2xx lands but the response is lost: the coordinator converges through the repeated exact-key HEAD and commits deleted; the active marker and tombstone survive', async () => {
    const old = identityFor(1);
    const next = identityFor(2);
    const store = new R04ObjectStore();
    const seeded = await seedRetiredActivePair(isolated.runtime, store, old, next);
    const decorated = new R04ResponseLossStore(store, { delete: { kind: 'unknown-after-side-effect' } });

    const result = await runCleanupBatch({
      ledger: ports,
      objectStore: decorated,
      config: r04CleanupBoundaryConfig(CONFIG),
      uow: r04Uow(isolated.runtime),
      leaseOwner: 'r04-unknown-response-lost',
    });
    const outcome = result.outcomes.find((entry) => entry.generationId === old.generationId);
    assert.ok(outcome, 'the retired generation must be claimed');
    assert.equal(outcome.kind, 'deleted', 'the lost-response DELETE converges via the second HEAD');

    // The DELETE side effect really reached the store exactly once; the
    // coordinator repeated the exact-key HEAD before committing the evidence.
    assert.equal(decorated.innerDeleteCountFor(old.key), 1, 'exactly one real DELETE side effect');
    assert.ok(decorated.headCountFor(old.key) >= 2, 'the confirm HEAD must reach the boundary');

    // The database fact is not enough on its own, but it must converge.
    const row = await readR04GenerationRow(isolated.runtime, old.generationId);
    assert.equal(row.generationState, 'deleted');
    assert.ok(row.confirmedAbsentAt, 'the deletion evidence (confirmed absent) is committed');
    assert.ok(row.deletedAt);

    // Exact absence through the real store surface + active marker unchanged.
    const absent = await store.confirmAbsent({ generationId: old.generationId, key: old.key });
    assert.equal(absent.absent, true, 'the retired key is exact absent');
    const activeHead = await store.headExact(
      { generationId: next.generationId, key: next.key },
      { expectedEtag: seeded.etagNext },
    );
    assert.equal(activeHead.class, 'ok', 'the active marker is unchanged');
    if (activeHead.class === 'ok') assert.equal(activeHead.identity.size, seeded.bodyNext.byteLength);
    assert.equal(store.deleteCountFor(next.key), 0, 'the active key is never deleted');
    assert.equal(await generationKeyCount(isolated.runtime, old.generationId), 1, 'the permanent tombstone survives');
  });

  test('request never determined to arrive: the outcome stays unknown_retryable with the claim released — never a premature success/failure; a NEW pool + fresh attempt token converges', async () => {
    const old = identityFor(3);
    const next = identityFor(4);
    const store = new R04ObjectStore();
    const seeded = await seedRetiredActivePair(isolated.runtime, store, old, next);
    const decorated = new R04ResponseLossStore(store, { delete: { kind: 'unknown-no-side-effect' } });

    const result = await runCleanupBatch({
      ledger: ports,
      objectStore: decorated,
      config: r04CleanupBoundaryConfig(CONFIG),
      uow: r04Uow(isolated.runtime),
      leaseOwner: 'r04-unknown-not-arrived',
    });
    const outcome = result.outcomes.find((entry) => entry.generationId === old.generationId);
    assert.ok(outcome);
    assert.equal(outcome.kind, 'unknown_retryable', 'the unknown outcome must be held, never asserted as success or failure');
    assert.equal(decorated.innerDeleteCountFor(old.key), 0, 'no provider side effect may be performed');

    // The claim is RELEASED (a later worker converges); no premature DB fact.
    const row = await readR04GenerationRow(isolated.runtime, old.generationId);
    assert.equal(row.generationState, 'deletion_pending');
    assert.equal(row.cleanupLeaseOwner, null, 'unknown_retryable releases the claim lease');
    assert.equal(row.cleanupAttemptToken, null);
    assert.equal(row.deletedAt, null, 'no premature delete evidence');

    // The object is still present: the unknown outcome must not be asserted
    // as deleted or failed.
    const stillPresent = await store.headExact(
      { generationId: old.generationId, key: old.key },
      { expectedEtag: seeded.etagOld },
    );
    assert.equal(stillPresent.class, 'ok');

    // Cleanup PROCESS restart: the crashed worker's lease expires on the
    // DATABASE clock; a genuinely NEW pool + fresh attempt token re-claims
    // through the PRODUCTION fence and converges.
    await expireCleanupLeaseOnDbClock(isolated.runtime, old.generationId);
    const restarted = await reopenSameSchemaRuntime(isolated.databaseUrl, 'known-r04-unknown-restart');
    try {
      const restartResult = await runCleanupBatch({
        ledger: ports,
        objectStore: store,
        config: r04CleanupBoundaryConfig(CONFIG),
        uow: r04Uow(restarted),
        leaseOwner: 'r04-unknown-restart',
      });
      const restartOutcome = restartResult.outcomes.find((entry) => entry.generationId === old.generationId);
      assert.ok(restartOutcome);
      assert.ok(
        restartOutcome.kind === 'deleted' || restartOutcome.kind === 'confirmed_absent',
        `the restart must converge, got ${restartOutcome.kind}`,
      );
      const rowAfter = await readR04GenerationRow(restarted, old.generationId);
      assert.equal(rowAfter.generationState, 'deleted');
    } finally {
      await restarted.close();
    }
    const absentAfter = await store.confirmAbsent({ generationId: old.generationId, key: old.key });
    assert.equal(absentAfter.absent, true, 'the restart leaves the retired key exact absent');
    const activeAfter = await store.headExact(
      { generationId: next.generationId, key: next.key },
      { expectedEtag: seeded.etagNext },
    );
    assert.equal(activeAfter.class, 'ok', 'the active marker is unchanged across the restart');
    assert.equal(store.deleteCountFor(next.key), 0);
  });

  test('object initially absent (expired-intent orphan): confirmed_absent with ZERO DELETE; the permanent tombstone rejects reissue', async () => {
    const orphan = identityFor(5);
    const next = identityFor(6);
    const store = new R04ObjectStore();
    // The orphan is allocated with an intent already expired on the DATABASE
    // clock and is NEVER provisioned (initially absent); the current
    // generation is a real active marker.
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      const allocated = await ports.allocate(transaction, {
        blobId: orphan.blobId,
        intentId: orphan.intentId,
        generationId: orphan.generationId,
        principalId: 'r04-principal',
        collectionId: R04_COLLECTION,
        subjectIdentity: 'r04-subject-owner',
        bucket: 'known-r04-production',
        key: orphan.key,
        keyFingerprint: orphan.fingerprint,
        expectedSize: 1,
        expectedSha256: 'a'.repeat(64),
        mediaHint: 'application/octet-stream',
        policyRevision: 'phase4a-i09-policy-v1',
        idempotencyKey: `r04-idem-${orphan.intentId}`,
        expiresAt: new Date(Date.now() - 3_600_000),
      });
      assert.equal(allocated.outcome, 'issued');
      const bodyNext = new TextEncoder().encode(`r04-active-marker-${next.generationId}`);
      const etagNext = store.seed(next.key, bodyNext);
      const allocatedNext = await ports.allocate(transaction, {
        blobId: orphan.blobId,
        intentId: next.intentId,
        generationId: next.generationId,
        principalId: 'r04-principal',
        collectionId: R04_COLLECTION,
        subjectIdentity: 'r04-subject-owner',
        bucket: 'known-r04-production',
        key: next.key,
        keyFingerprint: next.fingerprint,
        expectedSize: bodyNext.byteLength,
        expectedSha256: createHash('sha256').update(bodyNext).digest('hex'),
        mediaHint: 'application/octet-stream',
        policyRevision: 'phase4a-i09-policy-v1',
        idempotencyKey: `r04-idem-${next.intentId}`,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      });
      assert.equal(allocatedNext.outcome, 'issued');
      const completed = await ports.complete(transaction, {
        intentId: next.intentId,
        generationId: next.generationId,
        blobId: orphan.blobId,
        observedEtag: etagNext,
        observedSize: bodyNext.byteLength,
        observedContentType: 'application/octet-stream',
        observedMetadata: {},
      });
      assert.equal(completed.outcome, 'verified_active');
    });

    // The batch claim reconciles the expired-intent allocated generation to
    // orphaned (DB clock) and confirms absence with ZERO DELETE.
    const result = await runCleanupBatch({
      ledger: ports,
      objectStore: store,
      config: r04CleanupBoundaryConfig(CONFIG),
      uow: r04Uow(isolated.runtime),
      leaseOwner: 'r04-unknown-initial-absent',
    });
    const outcome = result.outcomes.find((entry) => entry.generationId === orphan.generationId);
    assert.ok(outcome, 'the orphan must be claimed after the allocated->orphaned reconcile');
    assert.equal(outcome.kind, 'confirmed_absent');
    assert.equal(store.deleteCountFor(orphan.key), 0, 'an initially absent candidate sends no DELETE');

    const row = await readR04GenerationRow(isolated.runtime, orphan.generationId);
    assert.equal(row.generationState, 'deleted');
    assert.ok(row.confirmedAbsentAt);
    assert.equal(await generationKeyCount(isolated.runtime, orphan.generationId), 1, 'the permanent tombstone survives');

    // The permanent key tombstone rejects reissue (SQLSTATE 23505).
    await assert.rejects(
      isolated.runtime.pool.query(
        `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
         values ($1, $2, $3, $4, 'allocate')`,
        [`reissue-${orphan.generationId}`, orphan.key, orphan.fingerprint, orphan.blobId],
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
      'reissuing the same physical key must be rejected',
    );
    assert.equal(store.deleteCountFor(next.key), 0, 'the active key is never deleted');
  });

  test('unknown handling never makes the ACTIVE key claimable or retryable; the batch claim surfaces only the retired candidate', async () => {
    const old = identityFor(7);
    const next = identityFor(8);
    const store = new R04ObjectStore();
    await seedRetiredActivePair(isolated.runtime, store, old, next);

    // The ACTIVE generation can never be claimed through the production fence.
    const activeClaim = await createUnitOfWork(isolated.runtime.db).execute(({ transaction }) =>
      ports.claimCleanup(transaction, {
        leaseOwner: 'r04-active-claim',
        leaseTtlSeconds: 60,
        generationId: next.generationId,
        retiredRetentionDays: 0,
      }));
    assert.equal(activeClaim.outcome, 'not_claimable', 'the current generation is never a cleanup candidate');

    // A batch claim returns ONLY the retired candidate — never the active key.
    const result = await runCleanupBatch({
      ledger: ports,
      objectStore: store,
      config: r04CleanupBoundaryConfig(CONFIG),
      uow: r04Uow(isolated.runtime),
      leaseOwner: 'r04-unknown-batch',
    });
    const claimedIds = new Set(result.outcomes.map((entry) => entry.generationId));
    assert.ok(claimedIds.has(old.generationId), 'the retired candidate is claimed');
    assert.ok(!claimedIds.has(next.generationId), 'the active key is never a retryable/claimable object');
    assert.equal(store.deleteCountFor(next.key), 0);
    const outcome = result.outcomes.find((entry) => entry.generationId === old.generationId);
    assert.equal(outcome?.kind, 'deleted');
  });

  test('the in-run control completes the executor contract at the real DB boundary', async () => {
    const executionLedger = new I16NegativeControlExecutor();
    const store = new R04ObjectStore();
    const facts: R04ProviderUnknownControlFacts = await executeR04ProviderCommitUnknownControl(
      controlDeps(executionLedger, isolated, store, 'r04-provider-unknown-nonce'),
    );
    assert.equal(facts.stableCode, 'unknown_retryable');
    assert.equal(facts.deleteResponseLostConverged, true);
    assert.equal(facts.unknownOutcomeHeld, true);
    assert.equal(facts.initialAbsentConverged, true);
    assert.equal(facts.allRetiredKeysAbsent, true);
    assert.equal(facts.activePreserved, true);
    const receipt = executionLedger.receiptFor('provider_commit_unknown');
    assert.equal(receipt.stableCode, 'unknown_retryable');
    assert.equal(receipt.verificationSource, 'postgres-integration-suite');
    assert.equal(receipt.cleanupReceipt, 'unknown_converged_absent_active_preserved');
    assert.equal(receipt.runId, executionLedger.runId);
  });
});

/**
 * P4A-I16 PostgreSQL integration suite: the acceptance runner's POST-RUN
 * INDEPENDENT CHECKS against the PRODUCTION migration with a fixture store.
 *
 * CONTRACT / FAIL-CLOSED coverage — this is NOT the real acceptance (real R2
 * evidence is pending). It proves, against real PostgreSQL (production
 * migration chain to latest) and production module ports with an in-memory
 * fixture object store for the R2 side:
 *  - `checkI16DatabaseConvergence` really inspects state: blob logical states
 *    converged, verification lease released, the attachments verification
 *    Outbox converged (zero non-completed rows), and permanent tombstones
 *    preserved (deleted/quarantined generations keep their generation_keys
 *    tombstone rows);
 *  - `checkI16ProbeKeysAbsent` confirms each probe exact key absent;
 *  - `checkI16ActiveMarkerPreserved` confirms the active generation's exact
 *    marker identity (etag/size) is unchanged;
 *  - restart recovery facts at the DB level: a committed finalize binding and
 *    blob state survive a process restart (pool closed, schema kept, runtime
 *    reopened) and the same checks converge after restart.
 */
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  checkI16ActiveMarkerPreserved,
  checkI16DatabaseConvergence,
  checkI16ProbeKeysAbsent,
  collectI16PostRunChecks,
  type I16DatabaseCheckResult,
} from '../../../scripts/evidence/phase4a-i16-acceptance.js';
import {
  createI07MigrationRuntime,
  identityFor,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import {
  finalizeHandoffInTx,
  i13HandoffInput,
  readBlobBinding,
  seedStoredPrivate,
  seedStoredPrivateWithRetired,
} from '../../support/phase4a-i13-test-helpers.js';
import { InMemoryCleanupObjectStore } from '../../support/phase4a-i14-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

async function completeProbeOutbox(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<void> {
  await runtime.pool.query(
    `update outbox_events
     set state = 'completed', completed_at = now(), locked_until = null
     where handler_name = 'attachments_verify_generation' and aggregate_id = $1 and state <> 'completed'`,
    [blobId],
  );
}

describeWithPostgres('P4A-I16 post-run independent checks (contract/fail-closed; real-R2 evidence pending)', () => {
  let isolated: I07MigrationRuntime;
  const active = identityFor(1);
  const retired = identityFor(2);
  const replacement = identityFor(3);
  const deleted = identityFor(4);

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i16_postrun', { maxConnections: 12 });
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('database convergence really inspects state: blob states + lease + Outbox + tombstone', async () => {
    await seedStoredPrivate(isolated.runtime, active);
    await seedStoredPrivateWithRetired(isolated.runtime, retired, replacement);
    // A deleted generation (terminal) keeps its permanent tombstone row.
    await isolated.runtime.pool.query(
      `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
       values ($1, $2, $3, $4, 'allocate')`,
      [deleted.generationId, deleted.key, deleted.fingerprint, deleted.blobId],
    );
    await isolated.runtime.pool.query(
      `insert into blob_records (blob_id, owner_subject_id, logical_state) values ($1, 'subject-owner', 'expired')`,
      [deleted.blobId],
    );
    await isolated.runtime.pool.query(
      `insert into blob_generations
         (generation_id, blob_id, bucket, key, key_fingerprint, generation_state, deleted_at, confirmed_absent_at)
       values ($1, $2, 'known-i16-production', $3, $4, 'deleted', now(), now())`,
      [deleted.generationId, deleted.blobId, deleted.key, deleted.fingerprint],
    );

    const probeBlobs = [active.blobId, retired.blobId, deleted.blobId];
    const probeGenerations = [active.generationId, retired.generationId, replacement.generationId, deleted.generationId];

    // The i13 fixture leaves the verification Outbox row in 'leased'; the check
    // must report not-converged until the Outbox actually completes.
    const before: I16DatabaseCheckResult = await checkI16DatabaseConvergence(isolated.runtime, {
      probeBlobIds: probeBlobs,
      probeGenerationIds: probeGenerations,
    });
    assert.equal(before.blobStatesConverged, true, 'stored_private/expired blobs are terminal');
    assert.equal(before.verificationLeaseReleased, true, 'no active verification lease');
    assert.equal(before.outboxConverged, false, 'the fixture-leased Outbox row must be reported as not converged');
    assert.equal(before.tombstonesPreserved, true, 'the deleted generation keeps its tombstone');

    await completeProbeOutbox(isolated.runtime, active.blobId);
    await completeProbeOutbox(isolated.runtime, retired.blobId);

    const after = await checkI16DatabaseConvergence(isolated.runtime, {
      probeBlobIds: probeBlobs,
      probeGenerationIds: probeGenerations,
    });
    assert.deepEqual(after, {
      blobStatesConverged: true,
      verificationLeaseReleased: true,
      outboxConverged: true,
      tombstonesPreserved: true,
    });
  });

  test('probe keys absent + active marker preserved through a fixture store', async () => {
    const store = new InMemoryCleanupObjectStore();
    // Retired generation object is still present before cleanup.
    store.seed(retired.key, `"etag-${retired.generationId}"`, 11);
    // Active generation marker: exact etag + size.
    store.seed(replacement.key, `"etag-${replacement.generationId}"`, 12);

    const activeHandle = { generationId: replacement.generationId, key: replacement.key };
    const retiredHandle = { generationId: retired.generationId, key: retired.key };

    assert.equal(await checkI16ActiveMarkerPreserved(store, activeHandle, {
      etag: `"etag-${replacement.generationId}"`,
      size: 12,
    }), true, 'the active marker must be preserved with exact identity');
    assert.equal(await checkI16ActiveMarkerPreserved(store, activeHandle, {
      etag: '"etag-wrong"',
      size: 12,
    }), false, 'a changed marker must fail the preserved check');

    assert.equal(await checkI16ProbeKeysAbsent(store, [retiredHandle, activeHandle]), false, 'both keys are still present');
    await store.deleteExact(retiredHandle);
    assert.equal(await checkI16ProbeKeysAbsent(store, [retiredHandle]), true, 'the retired exact key is absent');
    assert.equal(await checkI16ProbeKeysAbsent(store, [activeHandle]), false, 'the active exact key is never absent');

    await completeProbeOutbox(isolated.runtime, active.blobId);
    const checks = await collectI16PostRunChecks({
      runtime: isolated.runtime,
      probeBlobIds: [active.blobId],
      probeGenerationIds: [active.generationId],
      store,
      probeHandles: [retiredHandle],
      activeHandle,
      activeExpected: { etag: `"etag-${replacement.generationId}"`, size: 12 },
      processesClosed: true,
      residualPrefixClean: true,
    });
    assert.equal(checks.databaseConverged, true);
    assert.equal(checks.probeKeysAbsent, true);
    assert.equal(checks.activeMarkerPreserved, true);
    assert.equal(checks.processesClosed, true);
    assert.equal(checks.residualPrefixClean, true);
  });

  test('restart recovery facts: committed binding + blob state survive a process restart and checks converge', async () => {
    const committed = identityFor(5);
    const unbound = identityFor(6);
    await seedStoredPrivate(isolated.runtime, committed);
    await seedStoredPrivate(isolated.runtime, unbound);
    const bindingId = `i16-restart-binding-${committed.generationId}`;
    const handoff = await finalizeHandoffInTx(isolated.runtime, i13HandoffInput(committed, { attachmentBindingId: bindingId }));
    assert.equal(handoff.outcome, 'attached');

    // Simulate a process exit: close the pool but keep the schema.
    await isolated.closeKeepSchema();
    const restarted = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 6,
      applicationName: 'known-i16-restart',
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 1_000,
      statementTimeoutMs: 30_000,
    });
    try {
      const committedRow = await readBlobBinding(restarted, committed.blobId);
      assert.ok(committedRow);
      assert.equal(committedRow.logicalState, 'attached_private');
      assert.equal(committedRow.attachmentBindingId, bindingId);
      assert.equal(committedRow.attachmentBindingGenerationId, committed.generationId);

      const unboundRow = await readBlobBinding(restarted, unbound.blobId);
      assert.ok(unboundRow);
      assert.equal(unboundRow.logicalState, 'stored_private');
      assert.equal(unboundRow.attachmentBindingId, null);

      await completeProbeOutbox(restarted, committed.blobId);
      await completeProbeOutbox(restarted, unbound.blobId);
      const checks = await checkI16DatabaseConvergence(restarted, {
        probeBlobIds: [committed.blobId, unbound.blobId],
        probeGenerationIds: [committed.generationId, unbound.generationId],
      });
      assert.deepEqual(checks, {
        blobStatesConverged: true,
        verificationLeaseReleased: true,
        outboxConverged: true,
        tombstonesPreserved: true,
      });
    } finally {
      await restarted.close();
    }
  });
});


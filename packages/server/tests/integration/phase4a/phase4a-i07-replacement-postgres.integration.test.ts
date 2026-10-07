/**
 * P4A-I07 complete + replacement CAS against the PRODUCTION migration.
 *
 * Covers first complete -> active, old/new complete out of order (both
 * orders), late complete rejection (expired intent orphans, replaced/deleted),
 * the deterministic two-replacement race with BOTH winner orders across two
 * independent connections (event-driven barriers, no sleeps), the stale-CAS
 * loser contract, idempotent replay, and the final unique-active-row proof.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { createPostgresAttachmentsPorts, DatabaseOperationError } from '../../../src/infrastructure/database/index.js';
import type { AllocateGenerationInput, CompleteGenerationInput } from '../../../src/modules/attachments/index.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  i07Uow,
  identityFor,
  makeBucket,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

const ports = createPostgresAttachmentsPorts();

function allocateInput(id: ReturnType<typeof identityFor>, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: 'principal-i07',
    collectionId: 'collection-i07',
    subjectIdentity: 'subject-owner-i07',
    bucket: makeBucket(),
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: 7,
    expectedSha256: 'a'.repeat(64),
    mediaHint: 'application/octet-stream',
    policyRevision: 'policy-rev-1',
    idempotencyKey: `idem-${id.intentId}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

function completeInput(id: ReturnType<typeof identityFor>, overrides: Partial<CompleteGenerationInput> = {}): CompleteGenerationInput {
  return {
    intentId: id.intentId,
    generationId: id.generationId,
    blobId: id.blobId,
    observedEtag: `"etag-${id.generationId}"`,
    observedSize: 7,
    observedContentType: 'application/octet-stream',
    observedMetadata: { probe: 'phase4a-i07' },
    ...overrides,
  };
}

async function stateOf(runtime: I07MigrationRuntime['runtime'], generationId: string): Promise<string> {
  const result = await sql<{ generation_state: string }>`
    select generation_state from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  assert.ok(result.rows[0], `generation ${generationId} must exist`);
  return result.rows[0]!.generation_state;
}

async function blobFacts(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<{ logical_state: string; current_generation_id: string | null }> {
  const result = await sql<{ logical_state: string; current_generation_id: string | null }>`
    select logical_state, current_generation_id from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  assert.ok(result.rows[0], `blob ${blobId} must exist`);
  return result.rows[0]!;
}

async function activeGenerationsOf(runtime: I07MigrationRuntime['runtime'], blobId: string): Promise<string[]> {
  const result = await sql<{ generation_id: string }>`
    select generation_id from blob_generations
    where blob_id = ${blobId} and generation_state = 'active'
  `.execute(runtime.db);
  return result.rows.map((row) => row.generation_id);
}

async function seedActive(runtime: I07MigrationRuntime['runtime'], id: ReturnType<typeof identityFor>) {
  const uow = i07Uow(runtime);
  await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
  const result = await uow.execute((tx) => ports.complete(tx, completeInput(id)));
  assert.equal(result.outcome, 'verified_active');
}

describeWithPostgres('P4A-I07 complete and replacement CAS', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i07_replacement', { maxConnections: 10 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('first complete promotes the generation to active and binds exact ETag/size/metadata', async () => {
    const g1 = identityFor(1);
    await seedActive(isolated.runtime, g1);
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'active');
    const blob = await blobFacts(isolated.runtime, g1.blobId);
    assert.equal(blob.logical_state, 'uploaded');
    assert.equal(blob.current_generation_id, g1.generationId);

    const row = await sql<{ observed_etag: string | null; observed_size: string | null; observed_content_type: string | null; observed_metadata_keys: string[] }>`
      select observed_etag, observed_size::text, observed_content_type, observed_metadata_keys
      from blob_generations where generation_id = ${g1.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(row.rows[0]!.observed_etag, `"etag-${g1.generationId}"`);
    assert.equal(Number(row.rows[0]!.observed_size), 7);
    assert.equal(row.rows[0]!.observed_content_type, 'application/octet-stream');
    assert.deepEqual(row.rows[0]!.observed_metadata_keys, ['probe']);

    // Re-completing the active generation with the same binding is idempotent.
    const replay = await i07Uow(isolated.runtime).execute((tx) => ports.complete(tx, completeInput(g1)));
    assert.equal(replay.outcome, 'idempotent');
  });

  test('old/new complete out of order: new -> observed first, old stays idempotent, then CAS activates new', async () => {
    const g1 = identityFor(2);
    const g2 = identityFor(3);
    const uow = i07Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);

    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId })));
    const newComplete = await uow.execute((tx) => ports.complete(tx, completeInput(g2, { blobId: g1.blobId, observedSize: 8 })));
    assert.equal(newComplete.outcome, 'verified_observed');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'observed');

    const oldCompleteBefore = await uow.execute((tx) => ports.complete(tx, completeInput(g1)));
    assert.equal(oldCompleteBefore.outcome, 'idempotent');

    const cas = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(cas.outcome, 'activated');
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'retired');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'active');
    assert.deepEqual(await activeGenerationsOf(isolated.runtime, g1.blobId), [g2.generationId]);

    // A late complete of the retired generation is rejected as replaced.
    const late = await uow.execute((tx) => ports.complete(tx, completeInput(g1)));
    assert.equal(late.outcome, 'late_rejected');
    assert.equal(late.reason, 'replaced');
  });

  test('late completion after the intent expires orphans the generation and expires the issued blob', async () => {
    const g1 = identityFor(4);
    const uow = i07Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g1)));
    await sql`update upload_intents set expires_at = now() - interval '1 second' where generation_id = ${g1.generationId}`.execute(isolated.runtime.db);

    const late = await uow.execute((tx) => ports.complete(tx, completeInput(g1)));
    assert.equal(late.outcome, 'late_rejected');
    assert.equal(late.reason, 'expired');
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'orphaned');
    const row = await sql<{ retire_reason: string | null }>`
      select retire_reason from blob_generations where generation_id = ${g1.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(row.rows[0]!.retire_reason, 'expired');
    const blob = await blobFacts(isolated.runtime, g1.blobId);
    assert.equal(blob.logical_state, 'expired');
  });

  test('late completion of a deleted generation is rejected', async () => {
    const g1 = identityFor(5);
    const g2 = identityFor(17);
    const uow = i07Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId })));
    await uow.execute((tx) => ports.complete(tx, completeInput(g2, { blobId: g1.blobId, observedSize: 8 })));
    await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    const claim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: g1.generationId }));
    assert.equal(claim.outcome, 'claimed');
    await uow.execute((tx) => ports.completeCleanup(tx, { claim: claim.claim, verdict: 'confirmed_absent' }));
    const late = await uow.execute((tx) => ports.complete(tx, completeInput(g1)));
    assert.equal(late.outcome, 'late_rejected');
    assert.equal(late.reason, 'deleted');
  });

  test('replacement CAS both winner orders: two connections, g2 wins first, g3 wins second', async () => {
    const g1 = identityFor(6);
    const g2 = identityFor(7);
    const g3 = identityFor(8);
    const uow = i07Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    for (const candidate of [g2, g3]) {
      await uow.execute((tx) => ports.allocate(tx, allocateInput(candidate, { blobId: g1.blobId })));
      const completed = await uow.execute((tx) => ports.complete(tx, completeInput(candidate, { blobId: g1.blobId, observedSize: 8 })));
      assert.equal(completed.outcome, 'verified_observed');
    }

    const group = new BarrierGroup();
    const barrierA = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:a`) };
    const barrierB = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:b`) };
    const raceA = uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }, { barrier: barrierA }));
    const raceB = uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g3.generationId,
    }, { barrier: barrierB }));

    // Both pause before the CAS; release A first so g2 deterministically wins.
    await group.waitAllArrived(['replacement_cas:a', 'replacement_cas:b']);
    group.release('replacement_cas:a');
    const aResult = await raceA;
    assert.equal(aResult.outcome, 'activated');

    group.release('replacement_cas:b');
    const bResult = await raceB;
    assert.equal(bResult.outcome, 'stale_cas', 'the second replacement must observe a stale expected active');

    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'active');
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'retired');
    assert.equal(await stateOf(isolated.runtime, g3.generationId), 'observed');
    assert.deepEqual(await activeGenerationsOf(isolated.runtime, g1.blobId), [g2.generationId]);

    // Second winner order completes: the loser replaces the winner.
    const second = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g2.generationId, newGenerationId: g3.generationId,
    }));
    assert.equal(second.outcome, 'activated');
    assert.equal(await stateOf(isolated.runtime, g3.generationId), 'active');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'retired');
    assert.deepEqual(await activeGenerationsOf(isolated.runtime, g1.blobId), [g3.generationId]);
  });

  test('replacement CAS both winner orders: g3 wins first, g2 is stale', async () => {
    const g1 = identityFor(9);
    const g2 = identityFor(10);
    const g3 = identityFor(11);
    const uow = i07Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    for (const candidate of [g2, g3]) {
      await uow.execute((tx) => ports.allocate(tx, allocateInput(candidate, { blobId: g1.blobId })));
      await uow.execute((tx) => ports.complete(tx, completeInput(candidate, { blobId: g1.blobId, observedSize: 8 })));
    }

    const group = new BarrierGroup();
    const barrierA = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:a`) };
    const barrierB = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:b`) };
    const raceA = uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }, { barrier: barrierA }));
    const raceB = uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g3.generationId,
    }, { barrier: barrierB }));

    await group.waitAllArrived(['replacement_cas:a', 'replacement_cas:b']);
    group.release('replacement_cas:b');
    const bResult = await raceB;
    assert.equal(bResult.outcome, 'activated');

    group.release('replacement_cas:a');
    const aResult = await raceA;
    assert.equal(aResult.outcome, 'stale_cas');

    assert.equal(await stateOf(isolated.runtime, g3.generationId), 'active');
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'retired');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'observed');
    assert.deepEqual(await activeGenerationsOf(isolated.runtime, g1.blobId), [g3.generationId]);
  });

  test('replacement CAS is idempotent for an already-activated new generation', async () => {
    const g1 = identityFor(12);
    const g2 = identityFor(13);
    const uow = i07Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId })));
    await uow.execute((tx) => ports.complete(tx, completeInput(g2, { blobId: g1.blobId, observedSize: 8 })));

    const first = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(first.outcome, 'activated');
    const replay = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(replay.outcome, 'idempotent');
    assert.deepEqual(await activeGenerationsOf(isolated.runtime, g1.blobId), [g2.generationId]);
  });

  test('rollback at the complete write point: a CHECK violation leaves the generation untouched', async () => {
    const g1 = identityFor(14);
    const uow = i07Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g1)));
    // Negative observed_size violates the column CHECK mid-complete; the whole
    // transition must roll back so the generation stays allocated with no facts.
    await assert.rejects(
      uow.execute((tx) => ports.complete(tx, completeInput(g1, { observedSize: -1 }))),
      (error: unknown) => error instanceof DatabaseOperationError
        && error.kind === 'database_failure'
        && error.constraint === 'blob_generations_observed_size_check',
    );
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'allocated');
    const row = await sql<{ observed_etag: string | null }>`
      select observed_etag from blob_generations where generation_id = ${g1.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(row.rows[0]!.observed_etag, null, 'no observed facts may survive a failed complete');
    const blob = await blobFacts(isolated.runtime, g1.blobId);
    assert.equal(blob.logical_state, 'issued');
    assert.equal(blob.current_generation_id, null);
  });

  test('rollback at the replacement CAS write point: a commit fault retires nothing', async () => {
    const g1 = identityFor(15);
    const g2 = identityFor(16);
    const uow = i07Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId })));
    await uow.execute((tx) => ports.complete(tx, completeInput(g2, { blobId: g1.blobId, observedSize: 8 })));

    const faultUow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          throw new Error('simulated crash before commit');
        },
      },
    });
    await assert.rejects(
      faultUow.execute(({ transaction }) => ports.activateReplacement(transaction, {
        blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
      })),
      /simulated crash before commit/,
    );
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'active', 'the old generation must stay active');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'observed', 'the new generation must stay observed');
    const blob = await blobFacts(isolated.runtime, g1.blobId);
    assert.equal(blob.current_generation_id, g1.generationId, 'the pointer must not move on a failed CAS');
  });
});

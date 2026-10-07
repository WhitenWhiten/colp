/**
 * P4A-I04 replacement CAS and complete-ordering against isolated PostgreSQL
 * using production `createPostgresAttachmentsPorts` and the real migrated schema.
 *
 * Covers the first complete, old/new complete out of order (both orders), late
 * complete rejection (replaced and expired), the deterministic two-replacement
 * race with both winner orders, and the stale-CAS loser contract.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts } from '../../../src/infrastructure/database/index.js';
import type { AllocateGenerationInput } from '../../../src/modules/attachments/index.js';
import {
  BarrierGroup,
  createI04MigrationRuntime,
  i04Uow,
  identityFor,
  makeBucket,
  type I04MigrationRuntime,
} from '../../support/phase4a-i04-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

const ports = createPostgresAttachmentsPorts();

function allocateInput(id: ReturnType<typeof identityFor>, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: 'principal-i04',
    collectionId: 'collection-i04',
    subjectIdentity: 'subject-owner-i04',
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

function complete(id: ReturnType<typeof identityFor>, size = 7, blobId = id.blobId) {
  return {
    intentId: id.intentId, generationId: id.generationId, blobId,
    observedEtag: `"etag-${size}"`, observedSize: size,
    observedContentType: 'application/octet-stream',
    observedMetadata: { probe: 'i04' },
  };
}

async function stateOf(runtime: I04MigrationRuntime['runtime'], generationId: string): Promise<string> {
  const result = await sql<{ generation_state: string }>`
    select generation_state from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  assert.ok(result.rows[0], `generation ${generationId} must exist`);
  return result.rows[0]!.generation_state;
}

async function blobState(runtime: I04MigrationRuntime['runtime'], blobId: string): Promise<{ logical_state: string; current_generation_id: string | null }> {
  const result = await sql<{ logical_state: string; current_generation_id: string | null }>`
    select logical_state, current_generation_id from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  assert.ok(result.rows[0], `blob ${blobId} must exist`);
  return result.rows[0]!;
}

async function seedActive(runtime: I04MigrationRuntime['runtime'], id: ReturnType<typeof identityFor>, size = 7) {
  const uow = i04Uow(runtime);
  await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
  const result = await uow.execute((tx) => ports.complete(tx, complete(id, size)));
  assert.equal(result.outcome, 'verified_active');
}

describeWithPostgres('P4A-I04 replacement CAS and complete ordering', () => {
  let isolated: I04MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI04MigrationRuntime('i04_replacement', { maxConnections: 10 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('first complete promotes the generation to active and the blob to uploaded', async () => {
    const g1 = identityFor(1);
    await seedActive(isolated.runtime, g1);
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'active');
    const blob = await blobState(isolated.runtime, g1.blobId);
    assert.equal(blob.logical_state, 'uploaded');
    assert.equal(blob.current_generation_id, g1.generationId);

    // Re-completing the active generation with the same binding is idempotent.
    const replay = await i04Uow(isolated.runtime).execute((tx) => ports.complete(tx, complete(g1)));
    assert.equal(replay.outcome, 'idempotent');
  });

  test('old/new complete out of order: new completes to observed before the CAS, then a late old complete is rejected', async () => {
    const g1 = identityFor(2);
    const g2 = identityFor(3);
    const uow = i04Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);

    // New generation completes first while the old one is still active.
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId })));
    const newComplete = await uow.execute((tx) => ports.complete(tx, complete(g2, 8, g1.blobId)));
    assert.equal(newComplete.outcome, 'verified_observed');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'observed');

    // The old generation is still active, so its re-complete stays idempotent.
    const oldCompleteBefore = await uow.execute((tx) => ports.complete(tx, complete(g1)));
    assert.equal(oldCompleteBefore.outcome, 'idempotent');

    // Replacement CAS activates the new and retires the old in one transaction.
    const cas = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(cas.outcome, 'activated');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'active');
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'retired');

    // A late complete for the replaced generation is rejected.
    const late = await uow.execute((tx) => ports.complete(tx, complete(g1)));
    assert.equal(late.outcome, 'late_rejected');
    assert.equal(late.reason, 'replaced');
  });

  test('old/new complete out of order: old complete before new is idempotent and the CAS still requires the new observed', async () => {
    const g1 = identityFor(4);
    const g2 = identityFor(5);
    const uow = i04Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId })));

    // Old generation complete arrives before the new one is observed.
    const oldComplete = await uow.execute((tx) => ports.complete(tx, complete(g1)));
    assert.equal(oldComplete.outcome, 'idempotent');

    // The CAS must not activate an unverified (allocated) new generation.
    const premature = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(premature.outcome, 'new_not_verified');

    const newComplete = await uow.execute((tx) => ports.complete(tx, complete(g2, 8, g1.blobId)));
    assert.equal(newComplete.outcome, 'verified_observed');
    const cas = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(cas.outcome, 'activated');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'active');
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'retired');
  });

  test('late complete after intent expiry rejects and orphans the generation', async () => {
    const g1 = identityFor(6);
    const uow = i04Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g1)));

    // Simulate the intent expiry window closing (database clock).
    await sql`update upload_intents set expires_at = now() - interval '1 second' where generation_id = ${g1.generationId}`.execute(isolated.runtime.db);

    const late = await uow.execute((tx) => ports.complete(tx, complete(g1)));
    assert.equal(late.outcome, 'late_rejected');
    assert.equal(late.reason, 'expired');
    assert.equal(await stateOf(isolated.runtime, g1.generationId), 'orphaned');
    const blob = await blobState(isolated.runtime, g1.blobId);
    assert.equal(blob.logical_state, 'expired');
  });

  test('two replacements racing: winner order 1 (g2 wins, g3 stale, then g3 replaces g2)', async () => {
    const g1 = identityFor(7);
    const g2 = identityFor(8);
    const g3 = identityFor(9);
    const uow = i04Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    for (const candidate of [g2, g3]) {
      await uow.execute((tx) => ports.allocate(tx, allocateInput(candidate, { blobId: g1.blobId })));
      const completed = await uow.execute((tx) => ports.complete(tx, complete(candidate, 8, g1.blobId)));
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

    // Both are paused before the CAS; release A first so g2 deterministically wins.
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

    // Now the loser replaces the winner (second winner order completes).
    const second = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g2.generationId, newGenerationId: g3.generationId,
    }));
    assert.equal(second.outcome, 'activated');
    assert.equal(await stateOf(isolated.runtime, g3.generationId), 'active');
    assert.equal(await stateOf(isolated.runtime, g2.generationId), 'retired');
    const activeRows = await sql<{ generation_id: string }>`
      select generation_id from blob_generations
      where blob_id = ${g1.blobId} and generation_state = 'active'
    `.execute(isolated.runtime.db);
    assert.deepEqual(activeRows.rows.map((row) => row.generation_id), [g3.generationId]);
  });

  test('two replacements racing: winner order 2 (g3 wins first, g2 stale)', async () => {
    const g1 = identityFor(10);
    const g2 = identityFor(11);
    const g3 = identityFor(12);
    const uow = i04Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    for (const candidate of [g2, g3]) {
      await uow.execute((tx) => ports.allocate(tx, allocateInput(candidate, { blobId: g1.blobId })));
      await uow.execute((tx) => ports.complete(tx, complete(candidate, 8, g1.blobId)));
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
  });

  test('replacement CAS is idempotent for an already-activated new generation', async () => {
    const g1 = identityFor(13);
    const g2 = identityFor(14);
    const uow = i04Uow(isolated.runtime);
    await seedActive(isolated.runtime, g1);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId })));
    await uow.execute((tx) => ports.complete(tx, complete(g2, 8, g1.blobId)));

    const first = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(first.outcome, 'activated');
    const replay = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(replay.outcome, 'idempotent');
  });
});

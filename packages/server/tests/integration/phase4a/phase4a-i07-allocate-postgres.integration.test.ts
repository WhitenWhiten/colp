/**
 * P4A-I07 allocate + permanent tombstone against the PRODUCTION migration.
 *
 * Proves ledger-before-grant ordering (generation_keys -> blob_records ->
 * blob_generations -> upload_intents committed atomically), same-key first /
 * concurrent / reissue-after-deleted rejection at the permanent tombstone
 * boundary, identity immutability, and rollback at every allocation write point
 * (both a constraint conflict at the final write and a commit fault injection).
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createUnitOfWork } from '../../../src/infrastructure/database/index.js';
import { createPostgresAttachmentsPorts } from '../../../src/infrastructure/database/index.js';
import { AttachmentsIdentityError } from '../../../src/modules/attachments/index.js';
import {
  classifyAttachmentsLedgerError,
} from '../../../src/modules/attachments/index.js';
import type { AllocateGenerationInput } from '../../../src/modules/attachments/index.js';
import {
  BarrierGroup,
  createI07MigrationRuntime,
  i07Uow,
  identityFor,
  makeBucket,
  type I07MigrationRuntime,
} from '../../support/phase4a-i07-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

const SUBJECT = 'subject-owner-i07';
const COLLECTION = 'collection-i07';
const POLICY = 'policy-rev-1';

const ports = createPostgresAttachmentsPorts();

function allocateInput(id: ReturnType<typeof identityFor>, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: 'principal-i07',
    collectionId: COLLECTION,
    subjectIdentity: SUBJECT,
    bucket: makeBucket(),
    key: id.key,
    keyFingerprint: id.fingerprint,
    expectedSize: 7,
    expectedSha256: 'a'.repeat(64),
    mediaHint: 'application/octet-stream',
    policyRevision: POLICY,
    idempotencyKey: `idem-${id.intentId}`,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

async function keyRowCount(runtime: I07MigrationRuntime['runtime'], key: string): Promise<number> {
  const result = await sql<{ count: string }>`select count(*)::text as count from generation_keys where key = ${key}`.execute(runtime.db);
  return Number(result.rows[0]!.count);
}

async function rowCounts(runtime: I07MigrationRuntime['runtime'], id: { blobId: string; generationId: string }): Promise<{ keys: number; blobs: number; generations: number; intents: number }> {
  const [keys, generations, blobs, intents] = await Promise.all([
    sql<{ count: string }>`select count(*)::text as count from generation_keys where generation_id = ${id.generationId}`.execute(runtime.db),
    sql<{ count: string }>`select count(*)::text as count from blob_generations where generation_id = ${id.generationId}`.execute(runtime.db),
    sql<{ count: string }>`select count(*)::text as count from blob_records where blob_id = ${id.blobId}`.execute(runtime.db),
    sql<{ count: string }>`select count(*)::text as count from upload_intents where generation_id = ${id.generationId}`.execute(runtime.db),
  ]);
  return {
    keys: Number(keys.rows[0]!.count),
    blobs: Number(blobs.rows[0]!.count),
    generations: Number(generations.rows[0]!.count),
    intents: Number(intents.rows[0]!.count),
  };
}

describeWithPostgres('P4A-I07 allocate and permanent tombstone', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('i07_allocate', { maxConnections: 10 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('allocate commits the ledger in order before any grant can be issued', async () => {
    const id = identityFor(1);
    const uow = i07Uow(isolated.runtime);
    const result = await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
    assert.equal(result.outcome, 'issued');

    // All four rows are durable from a fresh connection immediately after
    // allocate resolves: generation_keys first (the permanent authority), then
    // blob_records, blob_generations, and upload_intents.
    assert.equal(await keyRowCount(isolated.runtime, id.key), 1);
    const generation = await sql<{ generation_state: string; blob_id: string }>`
      select generation_state, blob_id from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(generation.rows[0]!.generation_state, 'allocated');
    assert.equal(generation.rows[0]!.blob_id, id.blobId);
    const blob = await sql<{ logical_state: string; current_generation_id: string | null }>`
      select logical_state, current_generation_id from blob_records where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    assert.equal(blob.rows[0]!.logical_state, 'issued');
    assert.equal(blob.rows[0]!.current_generation_id, null);
    const intent = await sql<{ intent_id: string; expires_at: Date }>`
      select intent_id, expires_at from upload_intents where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(intent.rows[0]!.intent_id, id.intentId);
    assert.ok(intent.rows[0]!.expires_at > new Date(Date.now() - 1_000));

    // Replaying the same allocate is an idempotent success, never a re-issue.
    const replay = await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
    assert.equal(replay.outcome, 'already_issued');
    assert.equal(await keyRowCount(isolated.runtime, id.key), 1);
  });

  test('a second allocate with the same key is rejected by the permanent tombstone', async () => {
    const id = identityFor(2);
    const uow = i07Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
    await assert.rejects(
      uow.execute((tx) => ports.allocate(tx, allocateInput(id, {
        intentId: `retry-${id.intentId}`, generationId: `retry-${id.generationId}`, idempotencyKey: 'idem-retry',
      }))),
      (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'key_issued',
    );
    assert.equal(await keyRowCount(isolated.runtime, id.key), 1);
  });

  test('concurrent same-key allocate has exactly one winner and one identity failure', async () => {
    const base = identityFor(3);
    const winner = allocateInput(base, { intentId: `intent-a-${base.intentId}`, generationId: `gen-a-${base.generationId}`, idempotencyKey: 'idem-a' });
    const loser = allocateInput(base, { intentId: `intent-b-${base.intentId}`, generationId: `gen-b-${base.generationId}`, idempotencyKey: 'idem-b' });

    const group = new BarrierGroup();
    const barrierA = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:a`) };
    const barrierB = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:b`) };
    const uow = i07Uow(isolated.runtime);

    const resultA = uow.execute((tx) => ports.allocate(tx, winner, { barrier: barrierA }));
    const resultB = uow.execute((tx) => ports.allocate(tx, loser, { barrier: barrierB }));

    // Both transactions pause at the unique-authority insert, then race.
    await group.waitAllArrived(['allocate_before_key:a', 'allocate_before_key:b']);
    group.releaseAll(['allocate_before_key:a', 'allocate_before_key:b']);

    const [a, b] = await Promise.allSettled([resultA, resultB]);
    const winners = [a, b].filter((outcome) => outcome.status === 'fulfilled');
    const losers = [a, b].filter((outcome) => outcome.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one allocate must win');
    assert.equal(losers.length, 1, 'exactly one allocate must lose');
    const loserError = (losers[0] as PromiseRejectedResult).reason as unknown;
    assert.equal(classifyAttachmentsLedgerError(loserError).class, 'identity_failure');
    assert.equal(classifyAttachmentsLedgerError(loserError).code, 'key_issued');
    assert.equal(await keyRowCount(isolated.runtime, base.key), 1);
  });

  test('reissue of a deleted body is rejected: the tombstone survives cleanup-completed deletion', async () => {
    const id = identityFor(4);
    const next = identityFor(18);
    const uow = i07Uow(isolated.runtime);
    // g1 becomes active, g2 replaces it, then g1 is retired and cleaned: only
    // the permanent key authority survives the body deletion.
    await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
    await uow.execute((tx) => ports.complete(tx, {
      intentId: id.intentId, generationId: id.generationId, blobId: id.blobId,
      observedEtag: '"e4"', observedSize: 7, observedContentType: 'application/octet-stream',
      observedMetadata: { probe: 'phase4a-i07' },
    }));
    await uow.execute((tx) => ports.allocate(tx, allocateInput(next, { blobId: id.blobId })));
    await uow.execute((tx) => ports.complete(tx, {
      intentId: next.intentId, generationId: next.generationId, blobId: id.blobId,
      observedEtag: '"e5"', observedSize: 8, observedContentType: 'application/octet-stream',
      observedMetadata: { probe: 'phase4a-i07' },
    }));
    await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: id.blobId, expectedActiveGenerationId: id.generationId, newGenerationId: next.generationId,
    }));

    const claim = await uow.execute((tx) => ports.claimCleanup(tx, { leaseOwner: 'cleaner', leaseTtlSeconds: 60, generationId: id.generationId }));
    assert.equal(claim.outcome, 'claimed');
    const completed = await uow.execute((tx) => ports.completeCleanup(tx, { claim: claim.claim, verdict: 'confirmed_absent' }));
    assert.equal(completed.outcome, 'completed');
    const row = await sql<{ generation_state: string }>`
      select generation_state from blob_generations where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);
    assert.equal(row.rows[0]!.generation_state, 'deleted');
    assert.equal(await keyRowCount(isolated.runtime, id.key), 1, 'the tombstone must survive body deletion');

    await assert.rejects(
      uow.execute((tx) => ports.allocate(tx, allocateInput(id, {
        blobId: `new-${id.blobId}`, intentId: `new-${id.intentId}`, generationId: `new-${id.generationId}`, idempotencyKey: 'idem-reissue',
      }))),
      (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'key_issued',
    );
    assert.equal(await keyRowCount(isolated.runtime, id.key), 1);
  });

  test('reissue is rejected after the business rows are deleted outright (tombstone-only recovery)', async () => {
    const id = identityFor(5);
    const uow = i07Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));

    // Delete the business rows; only the permanent key authority remains.
    await sql`update blob_records set current_generation_id = null, logical_state = 'expired' where blob_id = ${id.blobId}`.execute(isolated.runtime.db);
    await sql`delete from upload_intents where generation_id = ${id.generationId}`.execute(isolated.runtime.db);
    await sql`delete from blob_generations where generation_id = ${id.generationId}`.execute(isolated.runtime.db);
    await sql`delete from blob_records where blob_id = ${id.blobId}`.execute(isolated.runtime.db);
    assert.equal(await keyRowCount(isolated.runtime, id.key), 1, 'the tombstone authority must survive business-row deletion');

    await assert.rejects(
      uow.execute((tx) => ports.allocate(tx, allocateInput(id, {
        blobId: `new-${id.blobId}`, intentId: `new-${id.intentId}`, generationId: `new-${id.generationId}`, idempotencyKey: 'idem-reissue-2',
      }))),
      (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'key_issued',
    );
    assert.equal(await keyRowCount(isolated.runtime, id.key), 1);
  });

  test('a generation can never be rebound to another key or blob (direct SQL 23514)', async () => {
    const id = identityFor(6);
    await i07Uow(isolated.runtime).execute((tx) => ports.allocate(tx, allocateInput(id)));
    for (const statement of [
      `update blob_generations set key = 'phase4a-i07/rebound' where generation_id = '${id.generationId}'`,
      `update blob_generations set blob_id = 'phase4a-i07/other-blob' where generation_id = '${id.generationId}'`,
    ]) {
      let failure: { code?: string } | undefined;
      try {
        await isolated.runtime.pool.query(statement);
      } catch (error) {
        failure = error as { code?: string };
      }
      assert.ok(failure, `rebind must be rejected: ${statement}`);
      assert.equal(failure.code, '23514', statement);
    }
  });

  test('rollback: a conflict at the final upload_intents write point leaves no partial ledger', async () => {
    const first = identityFor(7);
    const uow = i07Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(first)));

    // Same (blob_id, idempotency_key) but a brand-new generation/key: the
    // generation_keys and blob_generations inserts succeed inside the
    // transaction, then the upload_intents unique constraint fires. The whole
    // allocation must roll back so no orphan key is ever left behind.
    const second = identityFor(8);
    await assert.rejects(
      uow.execute((tx) => ports.allocate(tx, allocateInput(second, {
        blobId: first.blobId, idempotencyKey: `idem-${first.intentId}`,
      }))),
      (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'idempotency_conflict',
    );
    const counts = await rowCounts(isolated.runtime, second);
    assert.deepEqual(counts, { keys: 0, blobs: 0, generations: 0, intents: 0 },
      'no partial ledger rows may survive the failed allocation');
    assert.equal(await keyRowCount(isolated.runtime, second.key), 0);
  });

  test('rollback at every write point: a commit fault leaves no partial allocation', async () => {
    const id = identityFor(9);
    const uow = createUnitOfWork(isolated.runtime.db, {
      faultInjector: {
        afterCallbackBeforeCommit: async () => {
          throw new Error('simulated process crash before commit');
        },
      },
    });
    await assert.rejects(
      uow.execute(({ transaction }) => ports.allocate(transaction, allocateInput(id))),
      /simulated process crash before commit/,
    );
    const counts = await rowCounts(isolated.runtime, id);
    assert.deepEqual(counts, { keys: 0, blobs: 0, generations: 0, intents: 0 },
      'the four-write allocation must be atomic');
    assert.equal(await keyRowCount(isolated.runtime, id.key), 0);
  });
});

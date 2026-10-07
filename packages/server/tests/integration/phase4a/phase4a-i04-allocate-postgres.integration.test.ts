/**
 * P4A-I04 generation ledger + permanent tombstone against isolated PostgreSQL
 * using production `createPostgresAttachmentsPorts` and the real migrated schema.
 *
 * Uses two independent pool connections with test-driven promise barriers for
 * the concurrent same-key allocate. Asserts constraint names/SQLSTATE where
 * relevant, not just repository return values.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createPostgresAttachmentsPorts } from '../../../src/infrastructure/database/index.js';
import {
  AttachmentsIdentityError,
  classifyAttachmentsLedgerError,
  type AllocateGenerationInput,
} from '../../../src/modules/attachments/index.js';
import {
  BarrierGroup,
  createI04MigrationRuntime,
  i04Uow,
  identityFor,
  makeBucket,
  type I04MigrationRuntime,
} from '../../support/phase4a-i04-test-helpers.js';
import { describeWithPostgres } from '../../support/postgres-test-runtime.js';

const SUBJECT = 'subject-owner-i04';
const COLLECTION = 'collection-i04';
const POLICY = 'policy-rev-1';
const ports = createPostgresAttachmentsPorts();

function allocateInput(id: ReturnType<typeof identityFor>, overrides: Partial<AllocateGenerationInput> = {}): AllocateGenerationInput {
  return {
    blobId: id.blobId,
    intentId: id.intentId,
    generationId: id.generationId,
    principalId: 'principal-i04',
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

async function generationRowFor(runtime: I04MigrationRuntime['runtime'], generationId: string) {
  const result = await sql<{
    generation_state: string; blob_id: string; key: string; observed_etag: string | null;
    cleanup_attempt_token: string | null; cleanup_lease_owner: string | null; confirmed_absent_at: Date | null;
  }>`
    select generation_state, blob_id, key, observed_etag, cleanup_attempt_token, cleanup_lease_owner, confirmed_absent_at
    from blob_generations where generation_id = ${generationId}
  `.execute(runtime.db);
  return result.rows[0] ?? null;
}

async function blobRowFor(runtime: I04MigrationRuntime['runtime'], blobId: string) {
  const result = await sql<{ logical_state: string; current_generation_id: string | null }>`
    select logical_state, current_generation_id from blob_records where blob_id = ${blobId}
  `.execute(runtime.db);
  return result.rows[0] ?? null;
}

async function keyRowExists(runtime: I04MigrationRuntime['runtime'], key: string): Promise<boolean> {
  const result = await sql`select 1 from generation_keys where key = ${key}`.execute(runtime.db);
  return result.rows.length > 0;
}

async function countGenerationKeys(runtime: I04MigrationRuntime['runtime'], key: string): Promise<number> {
  const result = await sql<{ count: string }>`select count(*)::text as count from generation_keys where key = ${key}`.execute(runtime.db);
  return Number(result.rows[0]!.count);
}

describeWithPostgres('P4A-I04 allocate and permanent tombstone', () => {
  let isolated: I04MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI04MigrationRuntime('i04_allocate', { maxConnections: 10 });
  });

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('the production schema ships the named constraints and bounded candidate index', async () => {
    const names = [
      'generation_keys_key_unique',
      'generation_keys_key_fingerprint_unique',
      'blob_generations_generation_state_check',
      'blob_records_logical_state_check',
      'blob_records_current_generation_fk',
      'blob_generations_blob_fk',
      'blob_generations_generation_key_fk',
      'upload_intents_generation_fk',
    ];
    const found = await sql<{ conname: string }>`
      select conname from pg_constraint
      where connamespace = current_schema()::regnamespace
        and conname = any(${names}::text[])
    `.execute(isolated.runtime.db);
    assert.deepEqual(new Set(found.rows.map((row) => row.conname)), new Set(names));

    const oneActive = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes
      where schemaname = current_schema() and indexname = 'blob_generations_one_active_per_blob'
    `.execute(isolated.runtime.db);
    assert.equal(oneActive.rows.length, 1);
    assert.match(oneActive.rows[0]!.indexdef, /generation_state/);
    assert.match(oneActive.rows[0]!.indexdef, /'active'/);

    const claimIdx = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes
      where schemaname = current_schema() and indexname = 'blob_generations_cleanup_candidate_idx'
    `.execute(isolated.runtime.db);
    assert.equal(claimIdx.rows.length, 1);
    assert.match(claimIdx.rows[0]!.indexdef, /retired/);
    assert.match(claimIdx.rows[0]!.indexdef, /orphaned/);
    assert.match(claimIdx.rows[0]!.indexdef, /deletion_pending/);
  });

  test('allocate persists the permanent key authority before the grant is issued', async () => {
    const id = identityFor(1);
    const uow = i04Uow(isolated.runtime);
    const result = await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
    assert.equal(result.outcome, 'issued');

    // The key authority, intent, and generation are durable and visible from a
    // fresh connection immediately after allocate resolves (ledger-before-grant).
    assert.equal(await keyRowExists(isolated.runtime, id.key), true);
    const generation = await generationRowFor(isolated.runtime, id.generationId);
    assert.equal(generation?.generation_state, 'allocated');
    const blob = await blobRowFor(isolated.runtime, id.blobId);
    assert.equal(blob?.logical_state, 'issued');
    assert.equal(blob?.current_generation_id, null);

    // Replaying the same allocate is an idempotent success, never a re-issue.
    const replay = await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
    assert.equal(replay.outcome, 'already_issued');
    assert.equal(await countGenerationKeys(isolated.runtime, id.key), 1);
  });

  test('concurrent same-key allocate has exactly one winner and one identity failure', async () => {
    const base = identityFor(2);
    const winner = allocateInput(base, { intentId: `intent-${base.generationId}-a`, generationId: `gen-${base.generationId}-a`, idempotencyKey: 'idem-a' });
    const loser = allocateInput(base, { intentId: `intent-${base.generationId}-b`, generationId: `gen-${base.generationId}-b`, idempotencyKey: 'idem-b' });

    const group = new BarrierGroup();
    const barrierA = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:a`) };
    const barrierB = { arriveAndWait: (name: string) => group.arriveAndWait(`${name}:b`) };
    const uow = i04Uow(isolated.runtime);

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
    assert.ok(loserError instanceof AttachmentsIdentityError);
    assert.equal(classifyAttachmentsLedgerError(loserError).class, 'identity_failure');
    assert.equal(classifyAttachmentsLedgerError(loserError).code, 'key_issued');
    assert.equal(await countGenerationKeys(isolated.runtime, base.key), 1);
  });

  test('reissue of a tombstoned key is rejected after the business rows are deleted', async () => {
    const id = identityFor(3);
    const uow = i04Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));
    await uow.execute((tx) => ports.complete(tx, {
      intentId: id.intentId, generationId: id.generationId, blobId: id.blobId,
      observedEtag: '"e3"', observedSize: 7, observedContentType: 'application/octet-stream',
      observedMetadata: { probe: 'i04' },
    }));

    // Delete the body and the business rows; only the permanent tombstone remains.
    await sql`update blob_records set current_generation_id = null, logical_state = 'expired' where blob_id = ${id.blobId}`.execute(isolated.runtime.db);
    await sql`delete from upload_intents where generation_id = ${id.generationId}`.execute(isolated.runtime.db);
    await sql`delete from blob_generations where generation_id = ${id.generationId}`.execute(isolated.runtime.db);
    await sql`delete from blob_records where blob_id = ${id.blobId}`.execute(isolated.runtime.db);
    assert.equal(await keyRowExists(isolated.runtime, id.key), true, 'the tombstone authority must survive business-row deletion');

    // Reissue the same physical key after deletion: must fail at the unique boundary.
    await assert.rejects(
      uow.execute((tx) => ports.allocate(tx, allocateInput(id, {
        blobId: `new-${id.blobId}`, intentId: `new-${id.intentId}`, generationId: `new-${id.generationId}`, idempotencyKey: 'idem-reissue',
      }))),
      (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'key_issued',
    );
    assert.equal(await countGenerationKeys(isolated.runtime, id.key), 1);
  });

  test('the tombstone still rejects reissue after the business row is compressed', async () => {
    const id = identityFor(4);
    const uow = i04Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));

    // Compress the business row: purge observed facts, keep the identity stub.
    await sql`
      update blob_generations
      set observed_etag = null, observed_metadata_keys = '{}'::text[], observed_metadata_values = '{}'::text[],
          retire_reason = 'orphaned', generation_state = 'orphaned'
      where generation_id = ${id.generationId}
    `.execute(isolated.runtime.db);

    await assert.rejects(
      uow.execute((tx) => ports.allocate(tx, allocateInput(id, { intentId: `retry-${id.intentId}`, generationId: `retry-${id.generationId}`, idempotencyKey: 'idem-retry' }))),
      (error: unknown) => error instanceof AttachmentsIdentityError && error.code === 'key_issued',
    );
  });

  test('generation/key identity is immutable: the no-rebind and tombstone triggers reject writes', async () => {
    const id = identityFor(30);
    const uow = i04Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(id)));

    // The generation ledger row can never be rebound to another key/blob.
    let rebind: { code?: string } | undefined;
    try {
      await sql`update blob_generations set key = 'probe-i04/rebound' where generation_id = ${id.generationId}`.execute(isolated.runtime.db);
    } catch (error) {
      rebind = error as { code?: string };
    }
    assert.ok(rebind, 'rebinding a generation to another key must be rejected');
    assert.equal(rebind.code, '23514');

    // The permanent key authority is append-only: DELETE is rejected.
    let tombstoneDelete: { code?: string } | undefined;
    try {
      await sql`delete from generation_keys where generation_id = ${id.generationId}`.execute(isolated.runtime.db);
    } catch (error) {
      tombstoneDelete = error as { code?: string };
    }
    assert.ok(tombstoneDelete, 'deleting the permanent key authority must be rejected');
    assert.equal(tombstoneDelete.code, '23514');

    let tombstoneUpdate: { code?: string } | undefined;
    try {
      await sql`update generation_keys set key = 'probe-i04/rebound' where generation_id = ${id.generationId}`.execute(isolated.runtime.db);
    } catch (error) {
      tombstoneUpdate = error as { code?: string };
    }
    assert.ok(tombstoneUpdate, 'updating the permanent key authority must be rejected');
    assert.equal(tombstoneUpdate.code, '23514');
  });

  test('the one-active-per-blob partial unique index is enforced by SQLSTATE 23505', async () => {
    const g1 = identityFor(5);
    const g2 = identityFor(6);
    const uow = i04Uow(isolated.runtime);
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g1)));
    await uow.execute((tx) => ports.complete(tx, {
      intentId: g1.intentId, generationId: g1.generationId, blobId: g1.blobId,
      observedEtag: '"e5"', observedSize: 7, observedContentType: 'application/octet-stream',
      observedMetadata: {},
    }));
    await uow.execute((tx) => ports.allocate(tx, allocateInput(g2, { blobId: g1.blobId, idempotencyKey: 'idem-g2' })));
    await uow.execute((tx) => ports.complete(tx, {
      intentId: g2.intentId, generationId: g2.generationId, blobId: g1.blobId,
      observedEtag: '"e6"', observedSize: 8, observedContentType: 'application/octet-stream',
      observedMetadata: {},
    }));

    // Direct SQL attempt to activate a second generation without retiring the first.
    // runtime.db surfaces the raw pg error: SQLSTATE 23505 (unique_violation)
    // with the named constraint.
    let violation: { code?: string; constraint?: string } | undefined;
    try {
      await sql`update blob_generations set generation_state = 'active' where generation_id = ${g2.generationId}`.execute(isolated.runtime.db);
    } catch (error) {
      violation = error as { code?: string; constraint?: string };
    }
    assert.ok(violation, 'the partial unique index must reject a second active generation');
    assert.equal(violation.code, '23505', 'SQLSTATE 23505');
    assert.equal(violation.constraint, 'blob_generations_one_active_per_blob');

    // The port path never produces two active rows: replacement CAS retires first.
    const replacement = await uow.execute((tx) => ports.activateReplacement(tx, {
      blobId: g1.blobId, expectedActiveGenerationId: g1.generationId, newGenerationId: g2.generationId,
    }));
    assert.equal(replacement.outcome, 'activated');
    const active = await sql<{ generation_id: string }>`
      select generation_id from blob_generations
      where blob_id = ${g1.blobId} and generation_state = 'active'
    `.execute(isolated.runtime.db);
    assert.deepEqual(active.rows.map((row) => row.generation_id), [g2.generationId]);
  });
});

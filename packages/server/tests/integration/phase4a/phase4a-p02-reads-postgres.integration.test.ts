/**
 * P4A-P02 read-surface evidence against isolated PostgreSQL.
 *
 * - query plan: the owner-private metadata reads resolve through the unique
 *   indexes (blob_id / attachment_id), never a Seq Scan;
 * - N/N-1: an N-1 binary (the previous migration head, which predates the
 *   `attachments` table) keeps reading the SAME blob/generation/intent facts
 *   across the P02 upgrade — the expand migration is purely additive; the N
 *   binary additionally reads the Attachment metadata rows.
 *
 * Anti-false-positive: the pre-upgrade state is built from the PRODUCTION I13
 * ledger ports (never test SQL writes), and the N-1 read assertions re-run
 * the exact same queries before and after the upgrade.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { createI07MigrationRuntime, type I07MigrationRuntime } from '../../support/phase4a-i07-test-helpers.js';
import {
  readBlobBinding,
} from '../../support/phase4a-i13-test-helpers.js';
import {
  P02_COLLECTION_A,
  createPostgresAttachmentCanonicalMutationPorts,
  finalizeInTx,
  identityFor,
  p02FinalizeInput,
  readAttachmentRow,
  seedP02Collection,
  seedP02StoredPrivate,
} from '../../support/phase4a-p02-test-helpers.js';

const PREVIOUS_HEAD = '202608080400_phase4a_i15_operations';

const assembly = createPostgresAttachmentCanonicalMutationPorts();

describeWithPostgres('P4A-P02 Attachment metadata reads', () => {
  let isolated: I07MigrationRuntime;

  beforeAll(async () => {
    isolated = await createI07MigrationRuntime('p02_reads', { maxConnections: 12 });
    await seedP02Collection(isolated.runtime, P02_COLLECTION_A);
  }, 120_000);

  afterAll(async () => {
    await isolated?.dropSchema();
  });

  test('query plan: the metadata read by blob_id uses the unique blob index (no Seq Scan)', async () => {
    const id = identityFor(300);
    await seedP02StoredPrivate(isolated.runtime, id);
    const result = await finalizeInTx(isolated.runtime, assembly, p02FinalizeInput(id));
    assert.equal(result.outcome, 'finalized');

    const plan = await sql<{ 'QUERY PLAN': string }>`
      explain
      select attachment_id, blob_id, collection_id, owner_subject_id, sanitized_filename,
             media_type, size, logical_state, attached_at, retired_at, deleted_at, created_at, updated_at
      from attachments
      where blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.ok(!/Seq Scan/u.test(text), 'the blob_id metadata read must never Seq Scan');
    assert.match(text, /Index (?:Only )?Scan.*attachments_blob_id_unique/u,
      'the read must resolve through the unique blob binding index');

    const planById = await sql<{ 'QUERY PLAN': string }>`
      explain
      select attachment_id, blob_id, collection_id, owner_subject_id, sanitized_filename,
             media_type, size, logical_state, attached_at, retired_at, deleted_at, created_at, updated_at
      from attachments
      where attachment_id = ${p02FinalizeInput(id).attachmentId}
    `.execute(isolated.runtime.db);
    const textById = planById.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.ok(!/Seq Scan/u.test(textById), 'the attachment_id metadata read must never Seq Scan');
    assert.match(textById, /Index (?:Only )?Scan.*attachments_pkey/u,
      'the read must resolve through the primary key');
  });

  test('query plan: the recovery re-read joins attachments to the blob through indexed paths', async () => {
    const id = identityFor(301);
    await seedP02StoredPrivate(isolated.runtime, id);
    const result = await finalizeInTx(isolated.runtime, assembly, p02FinalizeInput(id));
    assert.equal(result.outcome, 'finalized');

    const plan = await sql<{ 'QUERY PLAN': string }>`
      explain
      select br.logical_state, br.attachment_binding_id,
             a.attachment_id, a.blob_id, a.collection_id, a.owner_subject_id,
             a.sanitized_filename, a.media_type, a.size, a.logical_state, a.attached_at
      from blob_records br
      left join attachments a on a.blob_id = br.blob_id
      where br.blob_id = ${id.blobId}
    `.execute(isolated.runtime.db);
    const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
    assert.ok(!/Seq Scan.*attachments/u.test(text),
      'the recovery join must resolve the attachments side through an index');
  });

  test('N/N-1: an N-1 binary keeps reading identical blob/intent facts across the P02 upgrade; the N binary adds the metadata read', async () => {
    const upgrade: IsolatedPostgresRuntime = await createIsolatedPostgresRuntime('phase4a_p02_nminus1', { maxConnections: 6 });
    try {
      const migrator = createMigrator(upgrade.runtime.db, 'migrations', upgrade.schema);
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;

      // Build the pre-upgrade state through the PRODUCTION I13 ledger ports.
      const id = identityFor(302);
      await seedP02StoredPrivate(upgrade.runtime, id);

      // N-1 read surface: blob binding facts + intent facts.
      const nMinus1Blob = await readBlobBinding(upgrade.runtime, id.blobId);
      assert.ok(nMinus1Blob);
      assert.equal(nMinus1Blob.logicalState, 'stored_private');
      const nMinus1Intent = await sql<{ collection_id: string; policy_revision: string; expected_sha256: string | null }>`
        select collection_id, policy_revision, expected_sha256
        from upload_intents where generation_id = ${id.generationId}
      `.execute(upgrade.runtime.db);
      assert.equal(nMinus1Intent.rows.length, 1);
      const nMinus1Generation = await sql<{ generation_state: string; observed_etag: string | null }>`
        select generation_state, observed_etag from blob_generations where generation_id = ${id.generationId}
      `.execute(upgrade.runtime.db);
      assert.equal(nMinus1Generation.rows.length, 1);

      // Upgrade to the P02 head (N).
      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const tablePresent = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.attachments') is not null as present`,
      );
      assert.equal(tablePresent.rows[0]?.present, true, 'the N head ships the attachments table');

      // The canonical finalize locks/authorizes a REAL Collection (the
      // attachments row carries an FK to collections(id)); the previous head's
      // intent seeding does not create the collections row.
      await seedP02Collection(upgrade.runtime, P02_COLLECTION_A);

      // N-1 binary reads are byte-identical after the upgrade (additive only).
      const nMinus1BlobAfter = await readBlobBinding(upgrade.runtime, id.blobId);
      assert.deepEqual(nMinus1BlobAfter, nMinus1Blob, 'the N-1 blob read surface must not change');
      const nMinus1IntentAfter = await sql<{ collection_id: string; policy_revision: string; expected_sha256: string | null }>`
        select collection_id, policy_revision, expected_sha256
        from upload_intents where generation_id = ${id.generationId}
      `.execute(upgrade.runtime.db);
      assert.deepEqual(nMinus1IntentAfter.rows, nMinus1Intent.rows, 'the N-1 intent read surface must not change');
      const nMinus1GenerationAfter = await sql<{ generation_state: string; observed_etag: string | null }>`
        select generation_state, observed_etag from blob_generations where generation_id = ${id.generationId}
      `.execute(upgrade.runtime.db);
      assert.deepEqual(nMinus1GenerationAfter.rows, nMinus1Generation.rows, 'the N-1 generation read surface must not change');

      // N read: no metadata yet, then the canonical assembly writes and the N
      // reader observes it while the N-1 reads stay stable.
      assert.equal(await readAttachmentRow(upgrade.runtime, id.blobId), null, 'no metadata before finalize');
      const finalized = await finalizeInTx(upgrade.runtime, assembly, p02FinalizeInput(id));
      assert.equal(finalized.outcome, 'finalized');
      const metadata = await readAttachmentRow(upgrade.runtime, id.blobId);
      assert.ok(metadata);
      assert.equal(metadata.attachmentId, p02FinalizeInput(id).attachmentId);
      assert.equal(metadata.collectionId, P02_COLLECTION_A);
      const nMinus1BlobFinal = await readBlobBinding(upgrade.runtime, id.blobId);
      assert.equal(nMinus1BlobFinal?.logicalState, 'attached_private');
      assert.equal(nMinus1BlobFinal?.attachmentBindingId, p02FinalizeInput(id).attachmentId,
        'the N-1 binary sees the binding columns it already knew');
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});

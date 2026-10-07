import { createHistoricalMigrator } from '../../support/historical-migrations.js';
/**
 * P4A-I07 production migration evidence against isolated PostgreSQL.
 *
 * - fresh empty database applies the full production chain and ships the
 *   attachment constraint catalog (named CHECKs/FKs/partial uniques, immutable
 *   tombstone triggers, bounded cleanup-candidate index),
 * - upgrade from the previous stable head + down/up round trip,
 * - direct SQL negatives prove the constraints are real (SQLSTATE + named
 *   constraint), including the permanent key tombstone authority and the
 *   deferred current-generation FK.
 */
import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { afterAll, beforeAll, test } from 'vitest';
import { createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { uuidFor, sha256Hex, keyFor } from '../../support/phase4a-i07-test-helpers.js';

const PREVIOUS_HEAD = '202608061000_mcp_recursive_session_guard';
const I07_MIGRATION = '202608080000_phase4a_attachments';

const CONSTRAINT_NAMES = [
  'generation_keys_pkey',
  'generation_keys_key_unique',
  'generation_keys_key_fingerprint_unique',
  'generation_keys_created_reason_check',
  'blob_records_logical_state_check',
  'blob_records_verified_facts_check',
  'blob_records_current_generation_fk',
  'blob_generations_generation_state_check',
  'blob_generations_deleted_facts_check',
  'blob_generations_contract_corrupt_facts_check',
  'blob_generations_quarantine_facts_check',
  'blob_generations_blob_fk',
  'blob_generations_generation_key_fk',
  'blob_generations_blob_generation_unique',
  'blob_generations_key_unique',
  'blob_generations_key_fingerprint_unique',
  'blob_generations_metadata_allowlist_check',
  'blob_generations_metadata_shape_check',
  'upload_intents_generation_id_unique',
  'upload_intents_blob_fk',
  'upload_intents_generation_fk',
  'upload_intents_blob_idempotency_unique',
];

function fixtureId(slot: number) {
  return {
    blobId: uuidFor(5000 + slot),
    generationId: uuidFor(6000 + slot),
    key: keyFor(uuidFor(7000 + slot)),
  };
}

async function seedKeyAuthority(runtime: IsolatedPostgresRuntime, slot: number, blobIdOverride?: string): Promise<{ blobId: string; generationId: string; key: string; fingerprint: string }> {
  const f = fixtureId(slot);
  const fingerprint = sha256Hex(f.key);
  const blobId = blobIdOverride ?? f.blobId;
  await runtime.runtime.pool.query(
    `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
     values ($1, $2, $3, $4, 'allocate')`,
    [f.generationId, f.key, fingerprint, blobId],
  );
  return { blobId, generationId: f.generationId, key: f.key, fingerprint };
}

async function seedBlobAndGeneration(runtime: IsolatedPostgresRuntime, slot: number, blobIdOverride?: string): Promise<{ blobId: string; generationId: string; key: string }> {
  const f = await seedKeyAuthority(runtime, slot, blobIdOverride);
  if (blobIdOverride === undefined) {
    await runtime.runtime.pool.query(
      `insert into blob_records (blob_id, owner_subject_id) values ($1, $2)`,
      [f.blobId, 'subject-owner'],
    );
  }
  await runtime.runtime.pool.query(
    `insert into blob_generations (generation_id, blob_id, bucket, key, key_fingerprint, generation_state)
     values ($1, $2, 'known-i07', $3, $4, 'allocated')`,
    [f.generationId, f.blobId, f.key, sha256Hex(f.key)],
  );
  return f;
}

describeWithPostgres('P4A-I07 production attachment migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4a_i07_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  /**
   * Runs a failing statement through the raw pg pool (bypassing the port) and
   * asserts the stable SQLSTATE + named constraint. This is the direct-SQL
   * negative proof that the constraints are real, not repository-only checks.
   */
  async function expectSqlState(
    statement: (pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>,
    code: string,
    constraint?: string,
  ): Promise<void> {
    let failure: { code?: string; constraint?: string } | undefined;
    try {
      await statement(isolated.runtime.pool);
    } catch (error) {
      failure = error as { code?: string; constraint?: string };
    }
    assert.ok(failure, 'the statement must be rejected by the database');
    assert.equal(failure.code, code, `expected SQLSTATE ${code}`);
    if (constraint !== undefined) assert.equal(failure.constraint, constraint, 'expected named constraint');
  }

  test('fresh empty database ships the full attachment constraint catalog', async () => {
    const found = await sql<{ conname: string }>`
      select conname from pg_constraint
      where connamespace = current_schema()::regnamespace
        and conname = any(${CONSTRAINT_NAMES}::text[])
    `.execute(isolated.runtime.db);
    assert.deepEqual(new Set(found.rows.map((row) => row.conname)), new Set(CONSTRAINT_NAMES));
  });

  test('the one-active-per-blob partial unique index and bounded cleanup candidate index exist', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }>`
      select indexname, indexdef from pg_indexes
      where schemaname = current_schema() and tablename = 'blob_generations'
    `.execute(isolated.runtime.db);
    const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    const oneActive = byName.get('blob_generations_one_active_per_blob');
    assert.ok(oneActive, 'one-active partial index must exist');
    assert.match(oneActive, /unique/i);
    assert.match(oneActive, /generation_state/);
    assert.match(oneActive, /'active'/);
    const cleanup = byName.get('blob_generations_cleanup_candidate_idx');
    assert.ok(cleanup, 'cleanup candidate index must exist');
    assert.match(cleanup, /retired/);
    assert.match(cleanup, /orphaned/);
    assert.match(cleanup, /deletion_pending/);
    assert.match(cleanup, /created_at/);
  });

  test('immutable tombstone triggers and identity triggers are installed', async () => {
    const triggers = await sql<{ tgname: string }>`
      select tgname from pg_trigger
      where tgrelid = 'generation_keys'::regclass and not tgisinternal
    `.execute(isolated.runtime.db);
    assert.deepEqual(triggers.rows.map((row) => row.tgname), ['generation_keys_immutable']);
    const generationTriggers = await sql<{ tgname: string }>`
      select tgname from pg_trigger
      where tgrelid = 'blob_generations'::regclass and not tgisinternal
    `.execute(isolated.runtime.db);
    assert.deepEqual(
      generationTriggers.rows.map((row) => row.tgname).sort(),
      ['blob_generations_identity_immutable', 'blob_generations_key_binding'],
    );
  });

  test('column types/defaults match the production contract', async () => {
    const columns = await sql<{ table_name: string; column_name: string; data_type: string; column_default: string | null; is_nullable: string }>`
      select table_name, column_name, data_type, column_default, is_nullable
      from information_schema.columns
      where table_schema = current_schema()
        and table_name in ('generation_keys', 'blob_records', 'blob_generations', 'upload_intents')
      order by table_name, ordinal_position
    `.execute(isolated.runtime.db);
    const rows = columns.rows.map((row) => `${row.table_name}.${row.column_name}`);
    const expect = (table: string, column: string) => assert.ok(rows.includes(`${table}.${column}`), `missing ${table}.${column}`);
    for (const table of ['generation_keys', 'blob_records', 'blob_generations', 'upload_intents']) {
      const present = columns.rows.filter((row) => row.table_name === table);
      assert.ok(present.length > 0, `${table} must have columns`);
    }
    const blobDefaults = Object.fromEntries(columns.rows
      .filter((row) => row.table_name === 'blob_records')
      .map((row) => [row.column_name, row]));
    assert.equal(blobDefaults.logical_state?.column_default?.includes("'issued'"), true);
    assert.equal(blobDefaults.logical_state?.data_type, 'text');
    const generationDefaults = Object.fromEntries(columns.rows
      .filter((row) => row.table_name === 'blob_generations')
      .map((row) => [row.column_name, row]));
    assert.equal(generationDefaults.generation_state?.column_default?.includes("'allocated'"), true);
    assert.equal(generationDefaults.cleanup_lease_generation?.data_type, 'bigint');
    assert.equal(generationDefaults.cleanup_lease_generation?.column_default, '0');
    assert.equal(generationDefaults.observed_metadata_keys?.data_type, 'ARRAY');
    assert.equal(generationDefaults.observed_metadata_values?.data_type, 'ARRAY');
    for (const column of ['cleanup_attempt_token', 'cleanup_lease_owner', 'cleanup_lease_expires_at',
      'confirmed_absent_at', 'deleted_at', 'contract_corrupt_at', 'quarantined_at', 'quarantined_reason']) {
      expect('blob_generations', column);
    }
    for (const column of ['retention_deadline', 'finalize_lease_owner', 'finalize_lease_expires_at',
      'verified_size', 'verified_sha256', 'media_type', 'verification_policy_version']) {
      expect('blob_records', column);
    }
    expect('upload_intents', 'idempotency_key');
    expect('upload_intents', 'expires_at');
  });

  test('the current-generation FK is deferrable initially deferred', async () => {
    const fk = await sql<{ condeferrable: boolean; condeferred: boolean }>`
      select condeferrable, condeferred from pg_constraint
      where conname = 'blob_records_current_generation_fk'
        and connamespace = current_schema()::regnamespace
    `.execute(isolated.runtime.db);
    assert.equal(fk.rows.length, 1);
    assert.equal(fk.rows[0]!.condeferrable, true);
    assert.equal(fk.rows[0]!.condeferred, true);
  });

  test('deferred FK allows a forward reference inside one transaction and rejects a dangling pointer', async () => {
    const f = fixtureId(100);
    const client = await isolated.runtime.pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
         values ($1, $2, $3, $4, 'allocate')`,
        [f.generationId, f.key, sha256Hex(f.key), f.blobId],
      );
      await client.query(
        `insert into blob_records (blob_id, owner_subject_id) values ($1, 'subject-owner')`,
        [f.blobId],
      );
      await client.query(
        `insert into blob_generations (generation_id, blob_id, bucket, key, key_fingerprint, generation_state)
         values ($1, $2, 'known-i07', $3, $4, 'allocated')`,
        [f.generationId, f.blobId, f.key, sha256Hex(f.key)],
      );
      await client.query(
        `update blob_records set current_generation_id = $2 where blob_id = $1`,
        [f.blobId, f.generationId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }

    await expectSqlState(async (pool) => pool.query(
      `insert into blob_records (blob_id, owner_subject_id, current_generation_id)
       values ('blob-dangling', 'subject-owner', 'generation-missing')`,
    ), '23503', 'blob_records_current_generation_fk');
  });

  test('direct SQL negatives: generation_keys key uniqueness is SQLSTATE 23505', async () => {
    const a = await seedKeyAuthority(isolated, 1);
    await expectSqlState(async (pool) => pool.query(
      `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
       values ('gen-dup-key', $1, 'fingerprint-other', $2, 'allocate')`,
      [a.key, a.blobId],
    ), '23505', 'generation_keys_key_unique');

    await expectSqlState(async (pool) => pool.query(
      `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
       values ($1, 'other-key', 'other-fingerprint', $2, 'allocate')`,
      [a.generationId, a.blobId],
    ), '23505', 'generation_keys_pkey');
  });

  test('direct SQL negatives: the permanent tombstone is append-only (23514)', async () => {
    const a = await seedKeyAuthority(isolated, 2);
    await expectSqlState(async (pool) => pool.query(
      `delete from generation_keys where generation_id = $1`, [a.generationId],
    ), '23514');
    await expectSqlState(async (pool) => pool.query(
      `update generation_keys set key = 'phase4a-i07/rebound' where generation_id = $1`, [a.generationId],
    ), '23514');
  });

  test('direct SQL negatives: generation identity is immutable and key binding matches the authority', async () => {
    const f = await seedBlobAndGeneration(isolated, 3);
    await expectSqlState(async (pool) => pool.query(
      `update blob_generations set key = 'phase4a-i07/rebound' where generation_id = $1`,
      [f.generationId],
    ), '23514');

    await expectSqlState(async (pool) => pool.query(
      `insert into blob_generations (generation_id, blob_id, bucket, key, key_fingerprint, generation_state)
       values ('gen-mismatch', $1, 'known-i07', 'phase4a-i07/not-the-bound-key', 'fingerprint', 'allocated')`,
      [f.blobId],
    ), '23514');
  });

  test('direct SQL negatives: logical/generation state CHECKs are 23514 with named constraints', async () => {
    const f = await seedBlobAndGeneration(isolated, 4);
    await expectSqlState(async (pool) => pool.query(
      `update blob_generations set generation_state = 'bogus' where generation_id = $1`,
      [f.generationId],
    ), '23514', 'blob_generations_generation_state_check');

    await expectSqlState(async (pool) => pool.query(
      `update blob_records set logical_state = 'bogus' where blob_id = $1`,
      [f.blobId],
    ), '23514', 'blob_records_logical_state_check');
  });

  test('direct SQL negatives: provider metadata is a fixed allowlist, never a raw response', async () => {
    const f = await seedBlobAndGeneration(isolated, 5);
    await expectSqlState(async (pool) => pool.query(
      `update blob_generations set observed_metadata_keys = array['filename'] where generation_id = $1`,
      [f.generationId],
    ), '23514', 'blob_generations_metadata_allowlist_check');

    await expectSqlState(async (pool) => pool.query(
      `update blob_generations set observed_metadata_keys = array['probe'], observed_metadata_values = array[]::text[]
       where generation_id = $1`,
      [f.generationId],
    ), '23514', 'blob_generations_metadata_shape_check');
  });

  test('direct SQL negatives: the one-active-per-blob partial unique index is SQLSTATE 23505', async () => {
    const f1 = await seedBlobAndGeneration(isolated, 6);
    // Same blob as f1: the partial unique index is per (blob_id) where active,
    // so the negative control must target a second active generation on the SAME blob.
    const f2 = await seedBlobAndGeneration(isolated, 7, f1.blobId);
    await isolated.runtime.pool.query(
      `update blob_generations set generation_state = 'active' where generation_id = $1`,
      [f1.generationId],
    );
    await isolated.runtime.pool.query(
      `update blob_generations set generation_state = 'observed' where generation_id = $1`,
      [f2.generationId],
    );
    await expectSqlState(async (pool) => pool.query(
      `update blob_generations set generation_state = 'active' where generation_id = $1`,
      [f2.generationId],
    ), '23505', 'blob_generations_one_active_per_blob');
  });

  test('upgrades from the previous stable head and round-trips down and up', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase4a_i07_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202608080000_phase4a_attachments');
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;
      const absent = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.blob_generations') is not null as present`,
      );
      assert.equal(absent.rows[0]?.present, false, 'attachment tables must not exist before the I07 migration');

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const present = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.blob_generations') is not null as present`,
      );
      assert.equal(present.rows[0]?.present, true, 'upgrade-from-head must create the attachment tables');

      const applied = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [I07_MIGRATION],
      );
      assert.equal(applied.rows.length, 1, 'the I07 migration must be recorded as applied');

      // Seed authority data so the rollback is exercised against populated
      // tables (a rollback that fails partway must not be silently accepted).
      const seeded = fixtureId(200);
      await upgrade.runtime.pool.query(
        `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
         values ($1, $2, $3, $4, 'allocate')`,
        [seeded.generationId, seeded.key, sha256Hex(seeded.key), seeded.blobId],
      );

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      const removed = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.blob_generations') is not null as present`,
      );
      assert.equal(removed.rows[0]?.present, false, 'down must roll back the attachment tables cleanly');

      const upAgain = await migrator.migrateToLatest();
      if (upAgain.error) throw upAgain.error;
      const restored = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.blob_generations') is not null as present`,
      );
      assert.equal(restored.rows[0]?.present, true, 'up again must recreate the attachment tables');
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});

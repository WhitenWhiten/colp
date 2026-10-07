import { createHistoricalMigrator } from '../../support/historical-migrations.js';
/**
 * P4A-I13 future Attachment binding migration evidence against isolated
 * PostgreSQL.
 *
 * - the expand migration ships the binding columns and named constraints;
 * - direct SQL negatives prove the constraints are real (SQLSTATE + named
 *   constraint): an `attached_private` row cannot exist without the full
 *   terminal binding facts, the binding generation snapshot must equal the
 *   current generation, and a duplicate Attachment binding id is a permanent
 *   unique violation;
 * - upgrade from the previous stable head and down/up round trip.
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
import { sha256Hex, uuidFor } from '../../support/phase4a-i07-test-helpers.js';

const PREVIOUS_HEAD = '202608080100_phase4a_i09_verification';
const I13_MIGRATION = '202608080200_phase4a_i13_finalize_binding';

const BINDING_COLUMNS = [
  'attachment_binding_id',
  'attached_at',
  'attachment_binding_generation_id',
  'attachment_binding_etag',
  'attachment_binding_policy_version',
];

async function expectSqlState(
  runtime: IsolatedPostgresRuntime,
  statement: (pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  let failure: { code?: string; constraint?: string } | undefined;
  try {
    await statement(runtime.runtime.pool);
  } catch (error) {
    failure = error as { code?: string; constraint?: string };
  }
  assert.ok(failure, 'the statement must be rejected by the database');
  assert.equal(failure.code, code, `expected SQLSTATE ${code}`);
  if (constraint !== undefined) assert.equal(failure.constraint, constraint, 'expected named constraint');
}

async function seedStoredPrivateRow(runtime: IsolatedPostgresRuntime, blobId: string, generationId: string): Promise<void> {
  // Seed the full identity chain so the deferred current-generation FK holds:
  // permanent key authority -> blob -> generation -> current pointer.
  const key = `key-${generationId}`;
  const fingerprint = sha256Hex(key);
  const pool = runtime.runtime.pool;
  await pool.query(
    `insert into generation_keys (generation_id, key, key_fingerprint, blob_id, created_reason)
     values ($1, $2, $3, $4, 'allocate')`,
    [generationId, key, fingerprint, blobId],
  );
  await pool.query(
    `insert into blob_records
       (blob_id, owner_subject_id, logical_state,
        verified_size, verified_sha256, media_type, verification_policy_version)
     values ($1, $2, 'stored_private', 7, $3, 'image/png', 'policy-v1')`,
    [blobId, 'subject-owner', 'a'.repeat(64)],
  );
  await pool.query(
    `insert into blob_generations
       (generation_id, blob_id, bucket, key, key_fingerprint, generation_state)
     values ($1, $2, 'known-i13', $3, $4, 'active')`,
    [generationId, blobId, key, fingerprint],
  );
  await pool.query(
    `update blob_records set current_generation_id = $2 where blob_id = $1`,
    [blobId, generationId],
  );
}

describeWithPostgres('P4A-I13 future Attachment binding migration', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4a_i13_migration');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('the expand migration ships the binding columns and named constraints', async () => {
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'blob_records'
    `.execute(isolated.runtime.db);
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const column of BINDING_COLUMNS) {
      assert.ok(names.has(column), `missing binding column ${column}`);
    }
    const constraints = await sql<{ conname: string }>`
      select conname from pg_constraint
      where connamespace = current_schema()::regnamespace
        and conname in (
          'blob_records_attachment_binding_id_unique',
          'blob_records_attached_binding_facts_check',
          'blob_records_attached_binding_generation_check'
        )
    `.execute(isolated.runtime.db);
    assert.equal(constraints.rows.length, 3, 'all three named binding constraints must exist');
  });

  test('direct SQL negatives: attached_private without the full binding facts is 23514 with the named CHECK', async () => {
    const blobId = uuidFor(6101);
    const generationId = uuidFor(6201);
    await seedStoredPrivateRow(isolated, blobId, generationId);
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `update blob_records set logical_state = 'attached_private', updated_at = now() where blob_id = $1`,
        [blobId],
      ),
      '23514',
      'blob_records_attached_binding_facts_check',
    );
  });

  test('direct SQL negatives: the binding generation snapshot must equal the current generation (23514)', async () => {
    const blobId = uuidFor(6102);
    const generationId = uuidFor(6202);
    await seedStoredPrivateRow(isolated, blobId, generationId);
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `update blob_records set attachment_binding_generation_id = 'gen-other' where blob_id = $1`,
        [blobId],
      ),
      '23514',
      'blob_records_attached_binding_generation_check',
    );
  });

  test('direct SQL negatives: a duplicate Attachment binding id is 23505 with the named unique constraint', async () => {
    const shared = `i13-migration-binding-${uuidFor(6300)}`;
    await isolated.runtime.pool.query(
      `insert into blob_records (blob_id, owner_subject_id, attachment_binding_id)
       values ($1, 'subject-owner', $2)`,
      [uuidFor(6103), shared],
    );
    await expectSqlState(
      isolated,
      async (pool) => pool.query(
        `insert into blob_records (blob_id, owner_subject_id, attachment_binding_id)
         values ($1, 'subject-owner', $2)`,
        [uuidFor(6104), shared],
      ),
      '23505',
      'blob_records_attachment_binding_id_unique',
    );
  });

  test('upgrades from the previous stable head and round-trips down and up', async () => {
    const upgrade = await createIsolatedPostgresRuntime('phase4a_i13_upgrade');
    try {
      const migrator = createHistoricalMigrator(upgrade, '202608080200_phase4a_i13_finalize_binding');
      const previous = await migrator.migrateTo(PREVIOUS_HEAD);
      if (previous.error) throw previous.error;
      const absentBefore = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select to_regclass(current_schema() || '.blob_records') is not null as present`,
      );
      assert.equal(absentBefore.rows[0]?.present, true, 'blob_records exists at the previous head');
      const columnAbsent = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema = current_schema() and table_name = 'blob_records'
            and column_name = 'attachment_binding_id'`,
      );
      assert.equal(columnAbsent.rows[0]?.present, false, 'binding columns must not exist before the I13 migration');

      const latest = await migrator.migrateToLatest();
      if (latest.error) throw latest.error;
      const applied = await upgrade.runtime.pool.query<{ name: string }>(
        `select name from kysely_migration where name = $1`,
        [I13_MIGRATION],
      );
      assert.equal(applied.rows.length, 1, 'the I13 migration must be recorded as applied');

      const down = await migrator.migrateTo(PREVIOUS_HEAD);
      if (down.error) throw down.error;
      const columnGone = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema = current_schema() and table_name = 'blob_records'
            and column_name = 'attachment_binding_id'`,
      );
      assert.equal(columnGone.rows[0]?.present, false, 'down must remove the binding columns cleanly');

      const upAgain = await migrator.migrateToLatest();
      if (upAgain.error) throw upAgain.error;
      const columnBack = await upgrade.runtime.pool.query<{ present: boolean }>(
        `select count(*)::int > 0 as present from information_schema.columns
          where table_schema = current_schema() and table_name = 'blob_records'
            and column_name = 'attachment_binding_id'`,
      );
      assert.equal(columnBack.rows[0]?.present, true, 'up again must restore the binding columns');
      await migrator.upgradeToCurrentLatest();
    } finally {
      await upgrade.close();
    }
  }, 120_000);
});
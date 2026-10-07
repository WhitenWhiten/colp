import assert from 'node:assert/strict';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sql } from 'kysely';
import { createDatabaseRuntime, createMigrator, runMigrations } from '../../../src/infrastructure/database/index.js';
import { bridgeAuditMigrationHistory } from '../../../src/infrastructure/database/audit-migration-history.js';
import { backendAuditMigrationFixture } from '../../support/backend-audit-migration-fixture.js';
import { createCreditTestDatabase } from '../../support/credit-ledger-fixture.js';
import { describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const oldGuard = '202610100900_digest_owner_membership_guard';
const newGuard = '202610101200_digest_owner_membership_guard';

describeWithPostgres('upgrade both backend audit merge parents without weakening migration history', () => {
  let auditFixture: Awaited<ReturnType<typeof backendAuditMigrationFixture>>;
  let mainFixture: Awaited<ReturnType<typeof backendAuditMigrationFixture>>;
  beforeAll(async () => {
    auditFixture = await backendAuditMigrationFixture('audit');
    mainFixture = await backendAuditMigrationFixture('main');
  });
  afterAll(async () => { await auditFixture?.close(); await mainFixture?.close(); });

  test.each(['audit', 'main'] as const)('%s parent upgrades with one connection and preserves installed guards', async parent => {
    const isolated = await createCreditTestDatabase(`merge_${parent}`, 1);
    try {
      await runMigrations(isolated.runtime.db, 'latest', (parent === 'audit' ? auditFixture : mainFixture).directory);
      const before = await ledger(isolated);
      assert.equal(before.includes(oldGuard), parent === 'audit');
      const outcome = await runMigrations(isolated.runtime.db, 'latest');
      assert.ok(outcome.results.some(row => row.migrationName === newGuard));
      const expected = (await createMigrator(isolated.runtime.db).getMigrations()).map(row => row.name).sort();
      assert.deepEqual(await ledger(isolated), expected);
      const functions = await isolated.runtime.pool.query<{ guard: string; financial: string; audit: string }>(
        `SELECT pg_get_functiondef('validate_digest_series_owner_membership()'::regprocedure) AS guard,
          to_regprocedure('credit_lock_financial_rows(text)')::text AS financial,
          to_regprocedure('credit_audit_account(text,boolean)')::text AS audit`);
      assert.match(functions.rows[0]!.guard, /digest owner membership cannot be revoked/);
      assert.ok(functions.rows[0]!.financial); assert.ok(functions.rows[0]!.audit);
      assert.equal((await runMigrations(isolated.runtime.db, 'latest')).results.length, 0);
    } finally { await isolated.close(); }
  }, 180_000);

  test('concurrent audit upgrades share the migration lock rather than borrowing their own held pool connection', async () => {
    const isolated = await createCreditTestDatabase('merge_concurrent', 1);
    const second = createDatabaseRuntime(isolated.databaseUrl, { maxConnections: 1, applicationName: 'known-audit-upgrade-lock-test' });
    try {
      await runMigrations(isolated.runtime.db, 'latest', auditFixture.directory);
      const owner = await isolated.runtime.pool.connect();
      await owner.query('SELECT pg_advisory_lock(3853314791062309107)');
      const pending = runMigrations(second.db, 'latest');
      try {
        await expect.poll(async () => (await owner.query<{ waiting: number }>(`SELECT count(*)::int AS waiting
          FROM pg_stat_activity WHERE application_name='known-audit-upgrade-lock-test' AND wait_event='advisory'`)).rows[0]!.waiting).toBe(1);
        assert.equal((await owner.query('SELECT name FROM kysely_migration WHERE name=$1', [oldGuard])).rowCount, 1,
          'the bridge must not alter history before acquiring the migration lock');
      } finally { await owner.query('SELECT pg_advisory_unlock(3853314791062309107)'); owner.release(); }
      const outcomes = await Promise.all([runMigrations(isolated.runtime.db, 'latest'), pending]);
      assert.equal(outcomes.flatMap(outcome => outcome.results).filter(row => row.migrationName === newGuard).length, 1);
      assert.ok(!(await ledger(isolated)).includes(oldGuard));
    } finally { await second.close(); await isolated.close(); }
  }, 180_000);

  test('divergent histories are rejected unchanged, while an interrupted exact bridge can resume', async () => {
    const isolated = await createCreditTestDatabase('merge_history', 1);
    try {
      await runMigrations(isolated.runtime.db, 'latest', auditFixture.directory);
      const names = (await createMigrator(isolated.runtime.db).getMigrations()).map(row => row.name);
      const downgrade = await createMigrator(isolated.runtime.db).migrateDown();
      assert.ok(downgrade.error, 'a requested downgrade must not retire the audit marker and undo credits instead');
      assert.ok((await ledger(isolated)).includes(oldGuard));
      for (const mutation of [
        "DELETE FROM kysely_migration WHERE name='202610100600_classification_execution_failure'",
        "INSERT INTO kysely_migration VALUES ('unknown_migration','2000-01-01T00:00:00.000Z')",
        `INSERT INTO kysely_migration VALUES ('${newGuard}','2000-01-01T00:00:00.000Z')`,
        "INSERT INTO kysely_migration VALUES ('202610100800_classification_execution_billing','2000-01-01T00:00:00.000Z')",
      ]) {
        await assert.rejects(isolated.runtime.db.transaction().execute(async tx => {
          await sql.raw(mutation).execute(tx);
          await bridgeAuditMigrationHistory(tx, names, 'public');
        }), /unsupported audit migration history/);
      }
      assert.ok((await ledger(isolated)).includes(oldGuard));
      // A committed marker retirement followed by process failure must not
      // remove the physical guard or cause later credits migrations to be skipped.
      await isolated.runtime.db.connection().execute(async connection => {
        const adapter = connection.getExecutor().adapter;
        const lock = { lockTable: 'kysely_migration_lock', lockRowId: 'migration_lock' };
        await adapter.acquireMigrationLock(connection, lock);
        try { await connection.transaction().execute(tx => bridgeAuditMigrationHistory(tx, names, 'public')); }
        finally { await adapter.releaseMigrationLock(connection, lock); }
      });
      assert.ok(!(await ledger(isolated)).includes(oldGuard));
      const outcome = await runMigrations(isolated.runtime.db, 'latest');
      assert.ok(outcome.results.some(row => row.migrationName === '202610100800_classification_execution_billing'));
      assert.ok(outcome.results.some(row => row.migrationName === newGuard));
    } finally { await isolated.close(); }
  }, 180_000);
});

async function ledger(isolated: IsolatedPostgresRuntime): Promise<string[]> {
  return (await isolated.runtime.pool.query<{ name: string }>('SELECT name FROM kysely_migration ORDER BY name')).rows.map(row => row.name);
}

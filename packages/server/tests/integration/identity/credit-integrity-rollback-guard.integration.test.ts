import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import { createIsolatedPostgresRuntime, describeWithPostgres } from '../../support/postgres-test-runtime.js';

describeWithPostgres('credit integrity rollback policy', () => {
  test('refuses the exact integrity migration down without removing protection, then upgrades forward', async () => {
    const isolated = await createIsolatedPostgresRuntime('credit_integrity_rollback_guard');
    try {
      const target = '202610101000_classification_credit_integrity';
      const migrator = createHistoricalMigrator(isolated, target);
      const up = await migrator.migrateToLatest();
      if (up.error) throw up.error;
      const inspect = async () => (await isolated.runtime.pool.query(`select
        to_regprocedure('credit_integrity_issues(text)')::text as issues,
        to_regprocedure('credit_audit_account(text,boolean)')::text as audit,
        (select pg_get_triggerdef(oid) from pg_trigger where tgrelid='credit_charges'::regclass
          and tgname='credit_new_charge_integrity_guard') as guard,
        (select name from kysely_migration where name=$1) as migration`, [target])).rows[0];
      const before = await inspect();
      assert.ok(before.issues && before.audit && before.guard && before.migration);
      const down = await migrator.migrateDown();
      assert.match(String(down.error), /Retain credit integrity controls during application rollback/);
      assert.deepEqual(await inspect(), before);
      await migrator.upgradeToCurrentLatest();
      assert.ok((await inspect()).guard);
    } finally { await isolated.close(); }
  }, 120000);
});

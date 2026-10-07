import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { Pool } from 'pg';
import { createDatabaseRuntime, databaseNow, runMigrations, type DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  configuredTestDatabaseUrl,
  describeWithPostgres,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('PostgreSQL runtime and migration foundation', () => {
  // evaluated under describe.skip collection; requireTestDatabaseUrl is only for run-time helpers
  const databaseUrl = configuredTestDatabaseUrl();
  const schema = `phase0_${randomUUID().replaceAll('-', '_')}`;
  const fixtureDirectory = resolve(import.meta.dirname, '../../fixtures/migrations');
  let isolatedDatabaseUrl: string;
  let administrator: Pool;
  let runtime: DatabaseRuntime;

  beforeAll(async () => {
    assert.ok(databaseUrl, 'KNOWN_TEST_DATABASE_URL or DATABASE_URL is required');
    administrator = new Pool({ connectionString: databaseUrl, max: 1 });
    await administrator.query(`create schema ${schema}`);

    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    isolatedDatabaseUrl = isolatedUrl.toString();
    runtime = createDatabaseRuntime(isolatedDatabaseUrl, {
      applicationName: 'known-phase0-integration',
      maxConnections: 2,
      connectionTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    await runtime?.close();
    if (administrator) {
      await administrator.query(`drop schema if exists ${schema} cascade`);
      await administrator.end();
    }
  });

  test('obtains PostgreSQL time and applies pool settings', async () => {
    const before = Date.now() - 2_000;
    const now = await databaseNow(runtime.db);
    const after = Date.now() + 2_000;

    assert.ok(now.getTime() >= before && now.getTime() <= after);
    assert.equal(runtime.pool.options.max, 2);
    assert.equal(runtime.pool.options.application_name, 'known-phase0-integration');
  });

  test('fails a saturated pool checkout within the configured backpressure deadline', async () => {
    const saturated = createDatabaseRuntime(isolatedDatabaseUrl, {
      maxConnections: 1,
      connectionTimeoutMs: 150,
      applicationName: 'known-pool-saturation-test',
    });
    const owner = await saturated.pool.connect();
    try {
      const started = performance.now();
      await assert.rejects(
        () => saturated.pool.connect(),
        /timeout exceeded when trying to connect|timeout/i,
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 100, `pool checkout failed before saturation timeout (${elapsed}ms)`);
      assert.ok(elapsed < 2_000, `pool checkout exceeded bounded wait (${elapsed}ms)`);
      assert.equal(saturated.pool.waitingCount, 0);
    } finally {
      owner.release();
      await saturated.close();
    }
  });

  test('FileMigrationProvider applies sortable migrations in order and rolls down one at a time', async () => {
    const latest = await runMigrations(runtime.db, 'latest', fixtureDirectory);
    assert.deepEqual(latest.results.map((result) => result.migrationName), [
      '001_expand_probe',
      '002_expand_probe',
    ]);
    assert.ok(latest.results.every((result) => result.status === 'Success'));

    const rowsAfterUp = await runtime.pool.query<{ ordinal: number }>(
      'select ordinal from phase0_migration_order order by ordinal',
    );
    assert.deepEqual(rowsAfterUp.rows.map((row) => row.ordinal), [1, 2]);

    const firstDown = await runMigrations(runtime.db, 'down', fixtureDirectory);
    assert.deepEqual(firstDown.results.map((result) => result.migrationName), ['002_expand_probe']);
    const rowsAfterFirstDown = await runtime.pool.query<{ ordinal: number }>(
      'select ordinal from phase0_migration_order order by ordinal',
    );
    assert.deepEqual(rowsAfterFirstDown.rows.map((row) => row.ordinal), [1]);

    const secondDown = await runMigrations(runtime.db, 'down', fixtureDirectory);
    assert.deepEqual(secondDown.results.map((result) => result.migrationName), ['001_expand_probe']);
  });

  test('close is idempotent and rejects use after pool shutdown', async () => {
    const lifecycleRuntime = createDatabaseRuntime(isolatedDatabaseUrl, { maxConnections: 1 });
    await lifecycleRuntime.pool.query('select 1');
    const firstClose = lifecycleRuntime.close();
    const secondClose = lifecycleRuntime.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    await assert.rejects(lifecycleRuntime.pool.query('select 1'), /end|closed/i);
  });
});

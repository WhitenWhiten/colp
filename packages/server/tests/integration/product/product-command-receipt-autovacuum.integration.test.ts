import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

describeWithPostgres('product command receipt autovacuum policy', () => {
  let isolated: IsolatedPostgresRuntime;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('product_receipt_autovacuum');
    await runMigrations(isolated.runtime.db, 'latest');
  }, 120_000);

  afterAll(async () => isolated?.close());

  test('uses high-churn vacuum and analyze thresholds', async () => {
    const result = await isolated.runtime.pool.query<{ reloptions: string[] | null }>(`
      SELECT reloptions
        FROM pg_class
       WHERE oid = 'product_command_receipts'::regclass
    `);
    assert.deepEqual(new Set(result.rows[0]?.reloptions ?? []), new Set([
      'autovacuum_vacuum_scale_factor=0.02',
      'autovacuum_analyze_scale_factor=0.01',
    ]));
  });
});

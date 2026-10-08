import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, test } from 'vitest';
import { sql } from 'kysely';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { loadManifest } from '../../../src/infrastructure/seed/manifest.js';
import { writeApplied, registerRows } from '../../../src/infrastructure/seed/state.js';
import { withdrawSeed } from '../../../src/infrastructure/seed/withdrawer.js';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import {
  describeWithPostgres,
  createIsolatedPostgresRuntime,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

/**
 * Demo seed 换版会硬删 accounts。生产演示库里林一晨已有 credit_accounts，
 * 批量 DELETE 会被 credit_account_delete_guard 拒绝。
 */
describeWithPostgres('Seed withdraw with credit ledger', () => {
  let isolated: IsolatedPostgresRuntime;
  let seedDir: string;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('seed_withdraw_credits', {
      maxConnections: 4,
      applicationName: 'known-seed-withdraw-credits',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    seedDir = mkdtempSync(join(tmpdir(), 'seed-withdraw-credits-'));
    writeFileSync(join(seedDir, 'manifest.json'), JSON.stringify({
      key: 'demo',
      name: 'credits withdraw',
      description: 'accounts-only',
      namespace: ['acc-u%'],
      tables: [
        { table: 'accounts', pkColumns: ['id'], prefixSql: "id LIKE 'acc-u%'", expectedRows: 2 },
      ],
      withdrawOrder: ['accounts'],
      postChecks: [],
      referenceChecks: [],
    }), 'utf8');
  }, 60_000);

  afterAll(async () => {
    rmSync(seedDir, { recursive: true, force: true });
    await isolated.close();
  });

  test('withdraw deletes seed accounts that own a credit ledger', async () => {
    const ledgerId = 'acc-u01wWA7gVl069uG0Vg';
    const plainId = 'acc-u02HiNbwPYfWBuXcxw';
    await sql`
      INSERT INTO accounts (id, subject_id, status, email, security_epoch, created_at)
      VALUES
        (${ledgerId}, 'sub-u01', 'active', 'lin.yichen@example.com', 0, '2025-11-02T08:00:00Z'),
        (${plainId}, 'sub-u02', 'active', 'wang.siyuan@example.com', 0, '2025-11-05T08:00:00Z')
    `.execute(isolated.runtime.db);
    await sql`SELECT credit_lock_account(${ledgerId}, true)`.execute(isolated.runtime.db);

    const manifest = loadManifest(seedDir);
    await createUnitOfWork(isolated.runtime.db).execute(async ({ transaction }) => {
      await writeApplied(transaction, 'demo', 'v-credit', 'test', manifest);
      await registerRows(transaction, 'demo', 'v-credit', [
        { table: 'accounts', pk: [ledgerId] },
        { table: 'accounts', pk: [plainId] },
      ]);
    });

    const report = await withdrawSeed(isolated.runtime, manifest, {
      by: 'test',
      allowCascade: false,
      cleanDangling: false,
    });
    assert.equal(report.deletedRows, 2);
    const leftover = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM accounts WHERE id IN (${ledgerId}, ${plainId})
    `.execute(isolated.runtime.db);
    assert.equal(leftover.rows[0]!.n, 0);
    const ledgers = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM credit_accounts WHERE account_id = ${ledgerId}
    `.execute(isolated.runtime.db);
    assert.equal(ledgers.rows[0]!.n, 0);
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeAll, afterAll, test } from 'vitest';
import { createPostgresExportJobEnqueueUnitOfWork } from '../../../src/infrastructure/collections/export-job-postgres.js';
import { createPostgresLinkHealthEnqueueUnitOfWork } from '../../../src/infrastructure/collections/link-health-worker-postgres.js';
import { createPostgresOrganizePlanMutationUnitOfWork } from '../../../src/infrastructure/collections/organize-plan-postgres.js';
import { createPostgresCollectionVersionUnitOfWork } from '../../../src/infrastructure/collections/collection-tree-version-postgres.js';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import type { ProductCommandReceiptPort } from '../../../src/modules/commands/index.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('C-05 request transaction cancellation', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('request_cancellation', { maxConnections: 4 });
    await runMigrations(isolated.runtime.db, 'latest');
  }, 180_000);
  afterAll(async () => isolated?.close());
  const factories = [createPostgresExportJobEnqueueUnitOfWork, createPostgresLinkHealthEnqueueUnitOfWork,
    createPostgresOrganizePlanMutationUnitOfWork, createPostgresCollectionVersionUnitOfWork];
  for (const factory of factories) {
    test(`${factory.name}: pre-abort never enters callback`, async () => {
      let entered = false;
      const reason = new Error('cancel before begin');
      await assert.rejects(factory(isolated.runtime.db).execute(async () => { entered = true; },
        { signal: AbortSignal.abort(reason) }), error => error === reason);
      assert.equal(entered, false);
    });
    test(`${factory.name}: abort cancels blocked SQL and rolls back receipt`, async () => {
      const blocker = await isolated.runtime.pool.connect();
      const controller = new AbortController();
      const reason = new Error('cancel blocked request');
      const commandId = randomUUID();
      try {
        await blocker.query('begin');
        await blocker.query('lock table product_command_receipts in access exclusive mode');
        const pending = factory(isolated.runtime.db).execute(async (ports: { receipts: Pick<ProductCommandReceiptPort, 'claim'> }) => {
          await ports.receipts.claim({ principalId: 'cancel-owner', commandScope: 'cancel-test', commandId }, 'fingerprint');
        }, { signal: controller.signal });
        const rejected = assert.rejects(pending, error => error === reason);
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const result = await isolated.runtime.pool.query(`select 1 from pg_stat_activity
            where wait_event_type = 'Lock' and query like 'insert into "product_command_receipts"%'`);
          if (result.rowCount) { blocked = true; break; }
          await delay(10);
        }
        assert.equal(blocked, true, 'request reached blocked database statement');
        controller.abort(reason);
        await Promise.race([rejected, delay(2_000).then(() => { throw new Error('backend was not cancelled'); })]);
      } finally {
        controller.abort(reason);
        await blocker.query('rollback');
        blocker.release();
      }
      const rows = await isolated.runtime.db.selectFrom('product_command_receipts').select('command_id')
        .where('command_id', '=', commandId).execute();
      assert.equal(rows.length, 0);
    });
  }
});

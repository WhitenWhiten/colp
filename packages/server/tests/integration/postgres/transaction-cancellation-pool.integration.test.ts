import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { sql } from 'kysely';
import { afterAll, beforeAll, test, vi } from 'vitest';
import { PostgresControlClient } from '../../../src/infrastructure/database/postgres-control-client.js';
import { createPostgresLibraryOrderQueryUnitOfWork } from '../../../src/infrastructure/collections/library-order-postgres.js';
import { cancelPostgresBackend, installPostgresTransactionCancellation } from '../../../src/infrastructure/database/postgres-cancellation.js';
import { createIsolatedPostgresRuntime, describeWithPostgres, type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

describeWithPostgres('transaction cancellation with a saturated one-connection pool', () => {
  let isolated: IsolatedPostgresRuntime;
  beforeAll(async () => { isolated = await createIsolatedPostgresRuntime('cancel_pool', { maxConnections: 1 }); });
  afterAll(async () => isolated?.close());

  test('an aborted library callback releases without waiting for pool acquisition timeout', async () => {
    const controller = new AbortController();
    let started = 0;
    const unit = createPostgresLibraryOrderQueryUnitOfWork(isolated.runtime.db);
    await assert.rejects(unit.execute(async () => {
      started = performance.now();
      controller.abort(new Error('caller stopped'));
    }, { signal: controller.signal }), /caller stopped/);
    assert.ok(performance.now() - started < 1_000, 'must not wait for the 2-second pool acquisition timeout');
    assert.equal((await isolated.runtime.pool.query('select 1 as value')).rows[0].value, 1);
  });

  test('Kysely cancels an in-flight statement without borrowing another pooled connection', async () => {
    const connect = vi.spyOn(PostgresControlClient.prototype, 'connect');
    try {
    const started = performance.now();
    await assert.rejects(isolated.runtime.db.transaction().execute(async (tx) => {
      const signal = AbortSignal.timeout(100);
      const dispose = await installPostgresTransactionCancellation(tx, signal);
      try { await sql`select pg_sleep(10)`.execute(tx); }
      finally { await dispose(); }
    }), /canceling statement due to user request/);
    assert.ok(performance.now() - started < 1_500);
    assert.equal((await isolated.runtime.pool.query('select 1 as value')).rows[0].value, 1);
    assert.equal(connect.mock.calls.length, 1, 'production Kysely must use the protected control client');
    } finally { connect.mockRestore(); }
  });

  test('raw pg cancellation also bypasses the saturated pool', async () => {
    const client = await isolated.runtime.pool.connect();
    try {
      const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      const started = performance.now();
      const query = client.query('select pg_sleep(10)');
      const rejected = assert.rejects(query, /canceling statement due to user request/);
      assert.equal(await cancelPostgresBackend(isolated.runtime.pool.options, pid), true);
      await rejected;
      assert.ok(performance.now() - started < 1_500);
    } finally { client.release(); }
  });
});

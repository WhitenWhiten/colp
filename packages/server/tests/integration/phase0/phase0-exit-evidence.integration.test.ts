import { createHistoricalMigrator } from '../../support/historical-migrations.js';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { runMigrations } from '../../../src/infrastructure/database/index.js';
import { runTransactionFaultProbe } from '../../../scripts/evidence/transaction-fault-probe.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';
import { reserveTcpPort, startApiProcess, stopProcess, waitForHttpOk } from '../../support/runtime-process.js';
import type { ChildProcess } from 'node:child_process';

describeWithPostgres('Phase 0 exit evidence on real PostgreSQL', () => {
  let isolated: IsolatedPostgresRuntime;
  let api: ChildProcess | undefined;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase0_evidence', { maxConnections: 8 });
  });

  afterAll(async () => {
    if (api) await stopProcess(api);
    await isolated?.close();
  });

  test('migrates an empty schema, is idempotent, rolls the fixed foundation window down, and rebuilds it', async () => {
    const historical = createHistoricalMigrator(isolated, '202607221500_product_command_receipt_hardening');
    const first = await historical.migrateToLatest();
    if (first.error) throw first.error;
    assert.ok(first.results!.length >= 3);
    assert.ok(first.results!.every((result) => result.status === 'Success'));

    const second = await historical.migrateToLatest();
    assert.deepEqual(second.results!, []);

    for (let index = 0; index < first.results!.length; index += 1) {
      const down = await historical.migrateDown();
      assert.equal(down.results!.length, 1);
      assert.equal(down.results![0]?.status, 'Success');
    }
    const rebuilt = await historical.migrateToLatest();
    assert.equal(rebuilt.results!.length, first.results!.length);
    assert.ok(rebuilt.results!.every((result) => result.status === 'Success'));
    await historical.upgradeToCurrentLatest();
  }, 60_000);

  test('records rollback and unknown commit outcome without callback replay', async () => {
    const evidence = await runTransactionFaultProbe(isolated.databaseUrl);
    assert.deepEqual(evidence, {
      evidence: 'transaction_fault_injection',
      rollbackObserved: true,
      unknownCommitObserved: true,
      realLostAckObserved: true,
      callbackInvocations: 3,
    });
  });

  test('observes PostgreSQL serialization failure and unique violation SQLSTATEs', async () => {
    await isolated.runtime.pool.query('create table phase0_serialization_probe (id integer primary key, value integer not null unique)');
    await isolated.runtime.pool.query('insert into phase0_serialization_probe (id, value) values (1, 1)');
    const first = await isolated.runtime.pool.connect();
    const second = await isolated.runtime.pool.connect();
    try {
      await first.query('begin isolation level serializable');
      await second.query('begin isolation level serializable');
      await first.query('select value from phase0_serialization_probe where id = 1');
      await second.query('select value from phase0_serialization_probe where id = 1');
      await first.query('update phase0_serialization_probe set value = 2 where id = 1');
      await first.query('commit');
      await assert.rejects(
        second.query('update phase0_serialization_probe set value = 3 where id = 1'),
        (error: unknown) => typeof error === 'object' && error !== null
          && (error as { code?: unknown }).code === '40001',
      );
      await second.query('rollback');

      await assert.rejects(
        isolated.runtime.pool.query('insert into phase0_serialization_probe (id, value) values (2, 2)'),
        (error: unknown) => typeof error === 'object' && error !== null
          && (error as { code?: unknown }).code === '23505',
      );
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  test('observes a real deadlock victim and leaves the surviving transaction recoverable', async () => {
    await isolated.runtime.pool.query('create table phase0_deadlock_probe (id integer primary key, value integer not null)');
    await isolated.runtime.pool.query('insert into phase0_deadlock_probe (id, value) values (1, 0), (2, 0)');
    const first = await isolated.runtime.pool.connect();
    const second = await isolated.runtime.pool.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      await first.query('update phase0_deadlock_probe set value = value + 1 where id = 1');
      await second.query('update phase0_deadlock_probe set value = value + 1 where id = 2');

      const firstWait = first.query('update phase0_deadlock_probe set value = value + 1 where id = 2');
      const secondWait = second.query('update phase0_deadlock_probe set value = value + 1 where id = 1');
      const outcomes = await Promise.allSettled([firstWait, secondWait]);
      const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
      assert.equal(rejected.length, 1);
      assert.equal((rejected[0]?.reason as { code?: unknown }).code, '40P01');

      const firstFailed = outcomes[0]?.status === 'rejected';
      await (firstFailed ? second : first).query('commit');
      await (firstFailed ? first : second).query('rollback');
      const rows = await isolated.runtime.pool.query<{ count: string }>('select count(*)::text as count from phase0_deadlock_probe');
      assert.equal(rows.rows[0]?.count, '2');
    } finally {
      await first.query('rollback').catch(() => undefined);
      await second.query('rollback').catch(() => undefined);
      first.release();
      second.release();
    }
  }, 15_000);

  test('starts a real API process and passes health/readiness deployment probes', async () => {
    const port = await reserveTcpPort();
    api = startApiProcess(isolated.databaseUrl, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHttpOk(`${baseUrl}/health`);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const ready = await waitForHttpOk(`${baseUrl}/ready`);
    assert.deepEqual(await ready.json(), { status: 'ready' });
  }, 30_000);
});

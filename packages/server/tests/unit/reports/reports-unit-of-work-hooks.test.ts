import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Kysely } from 'kysely';
import { createPostgresReportsUnitOfWork } from '../../../src/infrastructure/reports/index.js';
import type { DatabaseSchema, DatabaseTransaction } from '../../../src/infrastructure/database/index.js';

function fakeReportsDb(transaction: DatabaseTransaction): Kysely<DatabaseSchema> {
  return {
    transaction: () => ({
      setIsolationLevel: () => ({
        execute: async (work: (tx: DatabaseTransaction) => Promise<unknown>) => work(transaction),
      }),
    }),
  } as unknown as Kysely<DatabaseSchema>;
}

test('reports UoW hooks run in the same execute as work', async () => {
  const transaction = { id: 'tx-1' } as unknown as DatabaseTransaction;
  const order: string[] = [];
  let beforeTx: DatabaseTransaction | undefined;
  let workTx: DatabaseTransaction | undefined;
  let afterTx: DatabaseTransaction | undefined;
  const uow = createPostgresReportsUnitOfWork(fakeReportsDb(transaction), {
    beforeExecute: async (tx) => {
      order.push('before');
      beforeTx = tx;
      (tx as { seenByWork?: DatabaseTransaction }).seenByWork = tx;
    },
    afterExecute: async (tx) => {
      order.push('after');
      afterTx = tx;
    },
  });
  const result = await uow.execute(async (ports) => {
    order.push('work');
    workTx = (beforeTx as { seenByWork?: DatabaseTransaction } | undefined)?.seenByWork;
    assert.equal(typeof ports.ids.nextResourceId(), 'string');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(order, ['before', 'work', 'after']);
  assert.equal(beforeTx, transaction);
  assert.equal(workTx, transaction);
  assert.equal(afterTx, transaction);
});

test('reports UoW afterExecute does not run when work throws', async () => {
  const transaction = { id: 'tx-2' } as unknown as DatabaseTransaction;
  const order: string[] = [];
  const uow = createPostgresReportsUnitOfWork(fakeReportsDb(transaction), {
    beforeExecute: async (tx) => {
      order.push('before');
      assert.equal(tx, transaction);
    },
    afterExecute: async () => {
      order.push('after');
    },
  });
  await assert.rejects(
    () => uow.execute(async () => {
      order.push('work');
      throw new Error('work failed');
    }),
    /work failed/,
  );
  assert.deepEqual(order, ['before', 'work']);
});

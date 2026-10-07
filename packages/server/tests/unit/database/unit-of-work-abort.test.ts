import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Kysely } from 'kysely';
import { createUnitOfWork } from '../../../src/infrastructure/database/unit-of-work.js';
import type { DatabaseSchema } from '../../../src/infrastructure/database/index.js';
import { fakeKyselyDatabase } from '../../support/fake-kysely-database.js';

test('an aborted signal stops the unit of work before the transaction opens', async () => {
  const controller = new AbortController();
  const reason = new Error('caller gave up');
  controller.abort(reason);
  let opened = false;
  const db = { transaction: () => { opened = true; throw new Error('must not open'); } } as unknown as Kysely<DatabaseSchema>;
  const uow = createUnitOfWork(db, { signal: controller.signal, cancelBackend: async () => true });
  await assert.rejects(() => uow.execute(async () => 'never'), /caller gave up/);
  assert.equal(opened, false, 'an already-aborted signal must not open a transaction');
});

test('aborting mid-flight cancels the PostgreSQL backend and reports the signal reason', async () => {
  const controller = new AbortController();
  const reason = new Error('request timed out');
  const cancelled: number[] = [];
  const uow = createUnitOfWork(fakeKyselyDatabase(4_242), {
    signal: controller.signal,
    cancelBackend: async (pid) => { cancelled.push(pid); return true; },
  });
  const work = uow.execute(async () => {
    controller.abort(reason);
    // The server-side work keeps running until it observes the cancellation.
    return 'finished anyway';
  });
  await assert.rejects(() => work, /request timed out/);
  assert.deepEqual(cancelled, [4_242], 'the running backend must be cancelled by PID');
});

test('connection is retained until delayed cancellation finishes, before another request can borrow it', async () => {
  const controller = new AbortController();
  let resolveCancel: ((value: boolean) => void) | undefined;
  const cancelled: number[] = [];
  const events: string[] = [];
  const uow = createUnitOfWork(fakeKyselyDatabase(77, undefined, () => events.push('released')), {
    signal: controller.signal,
    cancelBackend: (pid) => {
      cancelled.push(pid);
      return new Promise<boolean>((resolve) => {
        resolveCancel = value => { events.push('cancelled'); resolve(value); };
      });
    },
  });
  const work = uow.execute(async () => {
    controller.abort(new Error('client disconnected'));
    return 'value';
  });
  // Give the abort listener a turn, then let the cancellation settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cancelled, [77]);
  assert.deepEqual(events, [], 'the PID must not be available to another transaction yet');
  resolveCancel?.(true);
  await assert.rejects(() => work, /client disconnected/);
  assert.deepEqual(events, ['cancelled', 'released']);
});

test('backend cancellation failure preserves the abort reason and then releases the connection', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const uow = createUnitOfWork(fakeKyselyDatabase(78, undefined, () => events.push('released')), {
    signal: controller.signal,
    cancelBackend: async () => { events.push('cancel-failed'); throw new Error('cancellation transport failed'); },
  });
  const work = uow.execute(async () => {
    controller.abort(new Error('client disconnected'));
    return 'value';
  });

  await assert.rejects(() => work, /client disconnected/);
  assert.deepEqual(events, ['cancel-failed', 'released']);
});

test('without a cancelBackend the signal still reports its reason and never eats the error', async () => {
  const controller = new AbortController();
  const uow = createUnitOfWork(fakeKyselyDatabase(1), { signal: controller.signal });
  await assert.rejects(
    () => uow.execute(async () => { controller.abort(new Error('stopped')); return 1; }),
    /stopped/,
  );
  const fails = createUnitOfWork(fakeKyselyDatabase(1), {
    signal: new AbortController().signal,
  });
  await assert.rejects(() => fails.execute(async () => { throw new Error('domain failure'); }), /domain failure/);
});

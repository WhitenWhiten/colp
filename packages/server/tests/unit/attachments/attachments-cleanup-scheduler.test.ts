import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAttachmentsCleanupScheduler } from '../../../src/bootstrap/attachments-worker-composition.js';
import type {
  DatabaseTransaction,
  UnitOfWork,
} from '../../../src/infrastructure/database/index.js';
import type {
  AttachmentsLedgerPort,
  GenerationObjectStorePort,
} from '../../../src/modules/attachments/index.js';
import { makeP05Config } from '../../support/phase4a-p05-test-helpers.js';

test('attachment scheduler stop reports a failed in-flight cleanup batch', async () => {
  const expected = new Error('cleanup claim failed');
  let rejectExecute: ((reason: unknown) => void) | undefined;
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectExecute = reject;
  });
  const uow: UnitOfWork = {
    execute: <Result>(): Promise<Result> => blocked,
  };
  const scheduler = createAttachmentsCleanupScheduler({
    ledger: {} as AttachmentsLedgerPort<DatabaseTransaction>,
    objectStore: {} as GenerationObjectStorePort,
    config: makeP05Config(),
    uow,
    leaseOwner: 'worker-test',
    intervalMs: 100,
  });

  const runFailure = assert.rejects(scheduler.runOnce(), (error: unknown) => error === expected);
  const stopFailure = assert.rejects(scheduler.stop(), (error: unknown) => error === expected);
  assert.ok(rejectExecute !== undefined);
  rejectExecute(expected);

  await Promise.all([runFailure, stopFailure]);
});

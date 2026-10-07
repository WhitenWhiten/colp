import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rollbackTransaction } from '../../../src/infrastructure/database/index.js';

test('transaction rollback preserves the original error when rollback succeeds', async () => {
  const operationError = new Error('operation failed');
  let rollbacks = 0;
  await rollbackTransaction(operationError, async () => { rollbacks += 1; }, 'Test operation');
  assert.equal(rollbacks, 1);
});

test('transaction rollback aggregates operation and rollback failures', async () => {
  const operationError = new Error('operation failed');
  const rollbackError = new Error('connection lost');
  let reported: unknown;
  try {
    await rollbackTransaction(
      operationError,
      async () => { throw rollbackError; },
      'Test operation',
    );
  } catch (error: unknown) {
    reported = error;
  }
  assert.ok(reported instanceof AggregateError);
  assert.deepEqual(reported.errors, [operationError, rollbackError]);
  assert.equal(reported.message, 'Test operation failed and transaction rollback also failed');
});

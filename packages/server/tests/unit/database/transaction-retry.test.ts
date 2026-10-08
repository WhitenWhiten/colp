import assert from 'node:assert/strict';
import { test } from 'vitest';
import { DatabaseOperationError } from '../../../src/infrastructure/database/errors.js';
import {
  TRANSACTION_RETRY_MAX_ATTEMPTS,
  isRetryableTransactionError,
  withTransactionRetry,
} from '../../../src/infrastructure/database/transaction-retry.js';

const noSleep = async (): Promise<void> => undefined;

test('T-10 retry only classifies database-aborted outcomes as retryable', () => {
  assert.equal(isRetryableTransactionError(new DatabaseOperationError('deadlock', { code: '40P01' })), true);
  assert.equal(isRetryableTransactionError(new DatabaseOperationError('serialization_failure', { code: '40001' })), true);
  assert.equal(isRetryableTransactionError(new DatabaseOperationError('lock_timeout', { code: '55P03' })), true);
  assert.equal(isRetryableTransactionError(new DatabaseOperationError('unavailable', { code: '08006' })), true);
  // A commit whose acknowledgement was lost may already be durable.
  assert.equal(isRetryableTransactionError(new DatabaseOperationError('commit_outcome_unknown', {})), false);
  assert.equal(isRetryableTransactionError(new DatabaseOperationError('unique_violation', { code: '23505' })), false);
  assert.equal(isRetryableTransactionError(new Error('domain failure')), false);
});

test('T-10 retry reapplies the operation and returns the successful attempt', async () => {
  let attempts = 0;
  const retries: number[] = [];
  const result = await withTransactionRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new DatabaseOperationError('deadlock', { code: '40P01' });
    return `attempt-${attempts}`;
  }, { maxAttempts: 4, sleep: noSleep, onRetry: ({ attempt }) => retries.push(attempt) });

  assert.equal(result, 'attempt-3');
  assert.deepEqual(retries, [1, 2]);
});

test('T-10 retry fails closed after the attempt bound instead of looping', async () => {
  let attempts = 0;
  await assert.rejects(
    withTransactionRetry(async () => {
      attempts += 1;
      throw new DatabaseOperationError('deadlock', { code: '40P01' });
    }, { maxAttempts: 3, sleep: noSleep }),
    (error: unknown) => error instanceof DatabaseOperationError && error.kind === 'deadlock',
  );
  assert.equal(attempts, 3);
});

test('T-10 retry never retries an unknown commit outcome or a domain error', async () => {
  let unknownAttempts = 0;
  await assert.rejects(
    withTransactionRetry(async () => {
      unknownAttempts += 1;
      throw new DatabaseOperationError('commit_outcome_unknown', {});
    }, { maxAttempts: 4, sleep: noSleep }),
    (error: unknown) => error instanceof DatabaseOperationError
      && error.kind === 'commit_outcome_unknown',
  );
  assert.equal(unknownAttempts, 1);

  let domainAttempts = 0;
  await assert.rejects(
    withTransactionRetry(async () => {
      domainAttempts += 1;
      throw new Error('collection not found');
    }, { maxAttempts: 4, sleep: noSleep }),
    /collection not found/,
  );
  assert.equal(domainAttempts, 1);
});

test('T-10 retry rejects an unbounded or invalid attempt configuration', async () => {
  for (const maxAttempts of [0, 1, TRANSACTION_RETRY_MAX_ATTEMPTS + 1, 2.5]) {
    await assert.rejects(
      withTransactionRetry(async () => 'unreachable', { maxAttempts, sleep: noSleep }),
      TypeError,
    );
  }
  await assert.rejects(
    withTransactionRetry(async () => 'unreachable', { baseDelayMs: -1, sleep: noSleep }),
    TypeError,
  );
});

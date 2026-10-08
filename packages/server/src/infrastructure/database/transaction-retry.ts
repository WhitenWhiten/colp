import { DatabaseOperationError } from './errors.js';

/**
 * T-10 bounded retry for database transactions that were aborted by the
 * database itself (40P01 deadlock, 40001 serialization failure, 55P03 lock
 * timeout, transient unavailability).
 *
 * Contract:
 * - Only `DatabaseOperationError.retryableAtCommandBoundary` is retried. A
 *   `commit_outcome_unknown` outcome is never retried: the mutation may have
 *   been committed, so re-running could double-apply it.
 * - The whole transaction is rolled back before the error surfaces, so each
 *   attempt starts from a clean transaction. Callers must therefore pass an
 *   operation whose only durable effects are inside that transaction.
 * - Attempts are bounded. A persistent deadlock fails closed after the last
 *   attempt instead of being swallowed by an unbounded loop.
 * - Domain, authorization, and validation errors are never retried.
 *
 * See docs/adr/0027-sync-transaction-lock-order.md for the lock order these
 * retries are a safety net for (the order, not the retry, is the fix).
 */
export interface TransactionRetryOptions {
  /** Total attempts, including the first. Bounded to 2..5. */
  readonly maxAttempts?: number;
  /** Base backoff in milliseconds; grows linearly per retry. */
  readonly baseDelayMs?: number;
  /** Test seam: observes each retry before the backoff delay. */
  readonly onRetry?: (info: { readonly attempt: number; readonly error: DatabaseOperationError }) => void;
  /** Test seam: replaces the timer used between attempts. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export const TRANSACTION_RETRY_MAX_ATTEMPTS = 5;

export function isRetryableTransactionError(error: unknown): error is DatabaseOperationError {
  return error instanceof DatabaseOperationError && error.retryableAtCommandBoundary;
}

export async function withTransactionRetry<Result>(
  operation: () => Promise<Result>,
  options: TransactionRetryOptions = {},
): Promise<Result> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 2 || maxAttempts > TRANSACTION_RETRY_MAX_ATTEMPTS) {
    throw new TypeError(`Transaction retry attempts must be an integer between 2 and ${TRANSACTION_RETRY_MAX_ATTEMPTS}.`);
  }
  const baseDelayMs = options.baseDelayMs ?? 10;
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0) {
    throw new TypeError('Transaction retry base delay must be a non-negative integer.');
  }
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (!isRetryableTransactionError(error) || attempt >= maxAttempts) throw error;
      options.onRetry?.({ attempt, error });
      await sleep(baseDelayMs * attempt);
    }
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

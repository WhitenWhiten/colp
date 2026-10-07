import { sql, type Kysely, type Transaction } from 'kysely';
import { classifyDatabaseError, DatabaseOperationError } from './errors.js';
import { installTransactionCancellation } from './transaction-cancellation.js';
import type { DatabaseSchema } from './runtime.js';
import {
  isCommitOutcomeUnknownError,
  isConnectionTransportError,
  isPostgresSqlStateError,
} from './transaction-phase-driver.js';

export type DatabaseTransaction = Transaction<DatabaseSchema>;
export type TransactionIsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionContext {
  /**
   * The sole transaction object for every port participating in this unit of work.
   * Implementations invoked here must perform database or in-process work only;
   * external network side effects belong behind a post-commit Outbox handler.
   */
  readonly transaction: DatabaseTransaction;
}

export interface TransactionFaultInjector {
  beforeCallback?(transaction: DatabaseTransaction): void | Promise<void>;
  afterCallbackBeforeCommit?(transaction: DatabaseTransaction): void | Promise<void>;
  /** Simulates a lost commit acknowledgement. The transaction is already committed. */
  afterCommitAcknowledged?(): void | Promise<void>;
}

export interface UnitOfWork {
  execute<Result>(callback: (context: TransactionContext) => Promise<Result>): Promise<Result>;
}

export interface UnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: TransactionFaultInjector;
  /**
   * Cancels a PostgreSQL backend by PID. Required for `signal` to have any
   * effect on the server: without it a client-side timeout only stops the
   * caller from waiting while the statement keeps running and keeps holding its
   * pool connection.
   */
  readonly cancelBackend?: (backendPid: number) => Promise<boolean>;
  /**
   * Cancels the unit of work. The signal reason is authoritative: it is thrown
   * even when cancellation itself fails, and `pg_cancel_backend` is asked to
   * stop the running statement so the connection is not pinned until the
   * statement finishes on its own.
   */
  readonly signal?: AbortSignal;
}

/**
 * Classify only real database/driver failures. Domain, application, and intentional
 * fault-injection errors must propagate unchanged so callers can branch on type/code.
 *
 * An error tagged by the transaction-phase driver wrapper means COMMIT was sent and
 * the acknowledgement was lost: the server may have applied the mutation, so the
 * outcome is unknown and must never be reported as a provable rollback.
 */
function rethrowUnitOfWorkError(error: unknown, committed: boolean): never {
  if (committed || isCommitOutcomeUnknownError(error)) {
    throw classifyDatabaseError(error, true);
  }
  if (error instanceof DatabaseOperationError) {
    throw error;
  }
  if (isPostgresSqlStateError(error) || isConnectionTransportError(error)) {
    throw classifyDatabaseError(error, false);
  }
  throw error;
}

export function createUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: UnitOfWorkOptions = {},
): UnitOfWork {
  return {
    async execute<Result>(callback: (context: TransactionContext) => Promise<Result>): Promise<Result> {
      const { signal } = options;
      if (signal?.aborted) throw signal.reason;
      let callbackInvoked = false;
      let committed = false;
      try {
        const transactionResult = await db.transaction()
          .setIsolationLevel(options.isolationLevel ?? 'read committed')
          .execute(async (transaction) => {
            if (callbackInvoked) throw new Error('Unit of Work callback re-entry is forbidden');
            callbackInvoked = true;
            // Registered inside the transaction so the PID belongs to the
            // connection actually running this unit of work.
            let disposeCancellation: (() => Promise<void>) | undefined;
            if (signal !== undefined && options.cancelBackend !== undefined) {
              const pid = await backendPid(transaction);
              disposeCancellation = installTransactionCancellation(signal, () => options.cancelBackend!(pid));
            }
            try {
              if (signal?.aborted) throw signal.reason;
              await options.faultInjector?.beforeCallback?.(transaction);
              const result = await callback({ transaction });
              await options.faultInjector?.afterCallbackBeforeCommit?.(transaction);
              if (signal?.aborted) throw signal.reason;
              return result;
            } finally {
              await disposeCancellation?.();
            }
          });
        committed = true;
        await options.faultInjector?.afterCommitAcknowledged?.();
        return transactionResult;
      } catch (error: unknown) {
        // The caller asked to stop: report its reason, not whatever the driver
        // surfaced while the statement was being cancelled.
        if (signal?.aborted) throw signal.reason;
        rethrowUnitOfWorkError(error, committed);
      }
    },
  };
}

async function backendPid(transaction: DatabaseTransaction): Promise<number> {
  const result = await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(transaction);
  return result.rows[0]!.pid;
}

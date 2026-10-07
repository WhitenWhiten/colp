import type { Kysely } from 'kysely';
import type { DatabaseSchema } from './runtime.js';
import { createUnitOfWork, type TransactionContext, type UnitOfWorkOptions } from './unit-of-work.js';
import { installPostgresTransactionCancellation } from './postgres-cancellation.js';

export interface RequestTransactionOptions { readonly signal?: AbortSignal }

/** Request cancellation owns the transaction, including backend cancellation and rollback. */
export function createRequestUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: Omit<UnitOfWorkOptions, 'signal'> = {},
) {
  return {
    execute<Result>(
      work: (context: TransactionContext) => Promise<Result>,
      request: RequestTransactionOptions = {},
    ): Promise<Result> {
      const { signal } = request;
      return createUnitOfWork(db, { ...options, signal }).execute(async context => {
        const dispose = signal && !options.cancelBackend
          ? await installPostgresTransactionCancellation(context.transaction, signal)
          : undefined;
        try {
          signal?.throwIfAborted();
          return await work(context);
        } finally {
          await dispose?.();
        }
      });
    },
  };
}

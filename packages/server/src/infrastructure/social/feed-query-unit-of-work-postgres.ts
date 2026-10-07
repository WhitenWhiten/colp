import { sql, type Kysely } from 'kysely';
import type { FeedCursorKeyring, FeedQueryPorts } from '../../modules/social/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseRuntime, DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import { createPostgresFeedPageReadPort } from './feed-query-postgres.js';

export interface PostgresFeedQueryUnitOfWork {
  execute<Result>(
    work: (ports: FeedQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export interface PostgresFeedQueryUnitOfWorkOptions {
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
  readonly includeCollectionFollowers?: boolean;
}

export function createPostgresFeedQueryUnitOfWork(
  runtime: Pick<DatabaseRuntime, 'db' | 'cancelBackend'>,
  cursors: FeedCursorKeyring,
  options: PostgresFeedQueryUnitOfWorkOptions = {},
): PostgresFeedQueryUnitOfWork {
  const { db } = runtime;
  return Object.freeze({
    execute<Result>(
      work: (ports: FeedQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeAbortable(runtime, cursors, options, work, execution.signal);
      }
      return createUnitOfWork(db, {
        isolationLevel: 'repeatable read',
        ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
      }).execute(({ transaction }) => work(Object.freeze({
        reads: createPostgresFeedPageReadPort(transaction, {
          includeCollectionFollowers: options.includeCollectionFollowers,
        }),
        cursors,
        clock: { now: () => databaseNow(transaction) },
      })));
    },
  });
}

/**
 * Cancellation uses DatabaseRuntime's independent PostgreSQL connection. The cancellation
 * promise settles before the transaction releases its backend PID for pool reuse.
 */
async function executeAbortable<Result>(
  runtime: Pick<DatabaseRuntime, 'db' | 'cancelBackend'>,
  cursors: FeedCursorKeyring,
  options: PostgresFeedQueryUnitOfWorkOptions,
  work: (ports: FeedQueryPorts) => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  const { db } = runtime;
  return db.transaction().setIsolationLevel('repeatable read').execute(async (transaction) => {
    const pid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(transaction)).rows[0]!.pid;
    let cancellation: Promise<boolean> | undefined;
    const cancel = () => {
      cancellation ??= runtime.cancelBackend(pid).catch(() => false);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      try {
        if (signal.aborted) throw signal.reason;
        await options.faultInjector?.beforeCallback?.(transaction);
        const result = await work(Object.freeze({
          reads: createPostgresFeedPageReadPort(transaction, {
            includeCollectionFollowers: options.includeCollectionFollowers,
          }),
          cursors,
          clock: { now: () => databaseNow(transaction) },
        }));
        await options.faultInjector?.afterCallbackBeforeCommit?.(transaction);
        if (signal.aborted) throw signal.reason;
        return result;
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        throw error;
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      await cancellation;
    }
  });
}

import { sql } from 'kysely';
import type { PublicActivityCursorKeyring, PublicActivityQueryPorts } from '../../modules/social/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseRuntime } from '../database/runtime.js';
import {
  createUnitOfWork,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import { createPostgresPublicActivityPageReadPort } from './public-activity-query-postgres.js';

export interface PostgresPublicActivityQueryUnitOfWork {
  execute<Result>(
    work: (ports: PublicActivityQueryPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

export interface PostgresPublicActivityQueryUnitOfWorkOptions {
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
}

export function createPostgresPublicActivityQueryUnitOfWork(
  runtime: Pick<DatabaseRuntime, 'db' | 'cancelBackend'>,
  cursors: PublicActivityCursorKeyring,
  options: PostgresPublicActivityQueryUnitOfWorkOptions = {},
): PostgresPublicActivityQueryUnitOfWork {
  const { db } = runtime;
  return Object.freeze({
    execute<Result>(
      work: (ports: PublicActivityQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {},
    ): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeAbortable(runtime, cursors, options, work, execution.signal);
      }
      return createUnitOfWork(db, {
        isolationLevel: 'repeatable read',
        ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
      }).execute(({ transaction }) => work(Object.freeze({
        reads: createPostgresPublicActivityPageReadPort(transaction),
        cursors,
        clock: { now: () => databaseNow(transaction) },
      })));
    },
  });
}

async function executeAbortable<Result>(
  runtime: Pick<DatabaseRuntime, 'db' | 'cancelBackend'>,
  cursors: PublicActivityCursorKeyring,
  options: PostgresPublicActivityQueryUnitOfWorkOptions,
  work: (ports: PublicActivityQueryPorts) => Promise<Result>,
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
          reads: createPostgresPublicActivityPageReadPort(transaction),
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

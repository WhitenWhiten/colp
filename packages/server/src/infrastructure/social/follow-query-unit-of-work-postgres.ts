import type { Kysely } from 'kysely';
import type { FollowCursorKeyring, FollowQueryPorts } from '../../modules/social/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import { createPostgresFollowPageReadPort } from './follow-query-postgres.js';

export interface PostgresFollowQueryUnitOfWork {
  execute<Result>(work: (ports: FollowQueryPorts) => Promise<Result>): Promise<Result>;
}

export interface PostgresFollowQueryUnitOfWorkOptions {
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
}

export function createPostgresFollowQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
  cursors: FollowCursorKeyring,
  options: PostgresFollowQueryUnitOfWorkOptions = {},
): PostgresFollowQueryUnitOfWork {
  const unit = createUnitOfWork(db, {
    isolationLevel: 'repeatable read',
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  return Object.freeze({
    execute<Result>(work: (ports: FollowQueryPorts) => Promise<Result>): Promise<Result> {
      return unit.execute(({ transaction }) => work(Object.freeze({
        reads: createPostgresFollowPageReadPort(transaction),
        cursors,
        clock: { now: () => databaseNow(transaction) },
      })));
    },
  });
}

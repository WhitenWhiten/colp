import type { Kysely } from 'kysely';
import type {
  NotificationInboxCursorKeyring,
  NotificationInboxQueryPorts,
} from '../../modules/notifications/index.js';
import { databaseNow } from '../database/time.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  createUnitOfWork,
  type UnitOfWorkOptions,
} from '../database/unit-of-work.js';
import { createPostgresNotificationInboxReadPort } from './notification-inbox-query-postgres.js';

export interface PostgresNotificationInboxQueryUnitOfWork {
  execute<Result>(work: (ports: NotificationInboxQueryPorts) => Promise<Result>): Promise<Result>;
}

export interface PostgresNotificationInboxQueryUnitOfWorkOptions {
  readonly faultInjector?: UnitOfWorkOptions['faultInjector'];
}

export function createPostgresNotificationInboxQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
  cursors: NotificationInboxCursorKeyring,
  options: PostgresNotificationInboxQueryUnitOfWorkOptions = {},
): PostgresNotificationInboxQueryUnitOfWork {
  const unit = createUnitOfWork(db, {
    isolationLevel: 'repeatable read',
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
  return Object.freeze({
    execute<Result>(work: (ports: NotificationInboxQueryPorts) => Promise<Result>): Promise<Result> {
      return unit.execute(({ transaction }) => work(Object.freeze({
        reads: createPostgresNotificationInboxReadPort(transaction),
        cursors,
        clock: { now: () => databaseNow(transaction) },
      })));
    },
  });
}

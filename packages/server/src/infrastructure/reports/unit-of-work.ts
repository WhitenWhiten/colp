import { createPostgresBookmarkSubscriptionExitPort } from '../bookmark-subscriptions/unit-of-work.js';
import { createPostgresTransactionPublicProfileFactsReadPort } from '../identity/postgres-public-profile-read.js';
import type { Kysely } from 'kysely';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionFaultInjector,
  type TransactionIsolationLevel,
} from '../database/unit-of-work.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { databaseNow } from '../database/time.js';
import { generateRevisionToken, strongEntityTag } from '../../modules/collections/index.js';
import type { ReportTransactionPorts, ReportUnitOfWork } from '../../modules/reports/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { createPostgresResourceIdLedgerPort } from '../database/resource-id-ledger.js';
import { createPostgresReportAuditPort, createPostgresReportEditionWritePort, createPostgresReportFollowWritePort, createPostgresReportMemberWritePort, createPostgresReportSeriesWritePort, createPostgresReportSourceReadPort, createPostgresReportScheduleWritePort, createPostgresReportRunLedgerPort, generateReportOpaqueId } from './repositories.js';
import { createPostgresModerationActionMethods } from '../governance/postgres-moderation-actions.js';
import { appendReportOutboxEvent } from '../outbox/reports-events.js';

export interface PostgresReportsUnitOfWorkOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly faultInjector?: TransactionFaultInjector;
  readonly idGenerator?: () => string;
  readonly revisionGenerator?: () => string;
  readonly publicSurfacePurgeEnabled?: boolean;
  /** After the transaction opens and before `work`. */
  readonly beforeExecute?: (transaction: DatabaseTransaction) => Promise<void>;
  /** After `work` returns and before COMMIT. Skipped when `work` throws. */
  readonly afterExecute?: (transaction: DatabaseTransaction, result: unknown) => Promise<void>;
}

export function createPostgresReportsUnitOfWork(db: Kysely<DatabaseSchema>, options: PostgresReportsUnitOfWorkOptions = {}): ReportUnitOfWork {
  // A public report projection reads series, editions, and source facts as one
  // snapshot.  Repeatable-read is the safe default; callers that explicitly
  // need a weaker/stronger mutation isolation level can still override it.
  const base = createUnitOfWork(db, {
    isolationLevel: options.isolationLevel ?? 'repeatable read',
    faultInjector: options.faultInjector,
  });
  const nextId = options.idGenerator ?? generateReportOpaqueId;
  const nextRevision = options.revisionGenerator ?? generateRevisionToken;
  return {
    execute: (work, execution) => (execution?.isolationLevel ? createUnitOfWork(db, {isolationLevel:execution.isolationLevel,faultInjector:options.faultInjector}) : base).execute(async ({ transaction }) => {
      await options.beforeExecute?.(transaction);
      const ledger = createPostgresResourceIdLedgerPort(transaction);
      const outbox = { append: (event: Parameters<ReportTransactionPorts['outbox']['append']>[0]) => appendReportOutboxEvent(transaction, event, { ledger }) };
      const digestActions = createPostgresModerationActionMethods(transaction);
      const ports: ReportTransactionPorts = {
        subscriptionExit: createPostgresBookmarkSubscriptionExitPort(transaction),
        receipts: createPostgresProductCommandReceiptPort(transaction),
        series: createPostgresReportSeriesWritePort(transaction, ledger),
        editions: createPostgresReportEditionWritePort(transaction, ledger),
        members: createPostgresReportMemberWritePort(transaction),
        follows: createPostgresReportFollowWritePort(transaction),
        source: createPostgresReportSourceReadPort(transaction),
        digestControl: {
          seriesControls: (seriesIds) => digestActions.digestSeriesControls(seriesIds),
          editionControls: (editionIds) => digestActions.digestEditionControls(editionIds),
        },
        revision: { next: nextRevision, etag: strongEntityTag, matches: (revision, etag) => etag === strongEntityTag(revision) },
        audit: createPostgresReportAuditPort(transaction), outbox,
        schedules: createPostgresReportScheduleWritePort(transaction, nextRevision),
        runs: createPostgresReportRunLedgerPort(transaction, nextId),
        ids: { nextResourceId: () => nextId(), nextEventId: () => nextId(), nextOutboxId: () => nextId() },
        clock: { now: () => databaseNow(transaction) },
        ...(options.publicSurfacePurgeEnabled === true ? { publicSurfacePurgeEnabled: true } : {}),
        ownerProfiles: createPostgresTransactionPublicProfileFactsReadPort(transaction),
      };
      const result = await work(ports);
      await options.afterExecute?.(transaction, result);
      return result;
    }),
  };
}

export const createPostgresReportUnitOfWork = createPostgresReportsUnitOfWork;

import { sql, type Kysely } from 'kysely';
import type { NotificationReadCommandPorts, NotificationReadAuditEvent }
  from '../../modules/notifications/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { appendAuditEvent, createPostgresProductCommandReceiptPort, createUnitOfWork,
  type DatabaseSchema, type DatabaseTransaction,
  type TransactionFaultInjector } from '../database/index.js';

export type NotificationReadCommandWritePhase = 'receipt' | 'authority' | 'audit' | 'complete';
export interface NotificationReadCommandFaultInjector {
  afterPhase?(phase: NotificationReadCommandWritePhase): void | Promise<void>;
}
export interface PostgresNotificationReadCommandUnitOfWorkOptions {
  readonly faultInjector?: NotificationReadCommandFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
}
export interface PostgresNotificationReadCommandUnitOfWork {
  execute<Result>(work: (ports: NotificationReadCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal }): Promise<Result>;
}

export function createPostgresNotificationReadCommandUnitOfWork(db: Kysely<DatabaseSchema>,
  options: PostgresNotificationReadCommandUnitOfWorkOptions = {}):
  PostgresNotificationReadCommandUnitOfWork {
  return Object.freeze({
    execute<Result>(work: (ports: NotificationReadCommandPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {}): Promise<Result> {
      if (execution.signal !== undefined) return executeAbortable(db, options, work, execution.signal);
      return createUnitOfWork(db, { isolationLevel: 'read committed',
        ...(options.transactionFaultInjector ? { faultInjector: options.transactionFaultInjector } : {}) })
        .execute(({ transaction }) => work(createPorts(transaction, options)));
    },
  });
}

async function executeAbortable<Result>(db: Kysely<DatabaseSchema>,
  options: PostgresNotificationReadCommandUnitOfWorkOptions,
  work: (ports: NotificationReadCommandPorts) => Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
    const disposeCancellation = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      await options.transactionFaultInjector?.beforeCallback?.(transaction);
      const result = await work(createPorts(transaction, options));
      await options.transactionFaultInjector?.afterCallbackBeforeCommit?.(transaction);
      if (signal.aborted) throw signal.reason;
      return result;
    } finally { await disposeCancellation(); }
  });
}

function createPorts(transaction: DatabaseTransaction,
  options: PostgresNotificationReadCommandUnitOfWorkOptions): NotificationReadCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const ports: NotificationReadCommandPorts = {
    receipts: {
      async claim(binding, fingerprint) {
        const claim = await receipts.claim(binding, fingerprint);
        if (claim.kind === 'claimed') await options.faultInjector?.afterPhase?.('receipt');
        return claim;
      },
      async complete(binding, fingerprint, result) {
        await receipts.complete(binding, fingerprint, result);
        await options.faultInjector?.afterPhase?.('complete');
      },
      purgeExpired: receipts.purgeExpired.bind(receipts),
      deletePrincipalReceipts: receipts.deletePrincipalReceipts.bind(receipts),
    },
    authority: {
      async markOne(input) {
        // CS-05: the legacy read command may only transition legacy kinds;
        // community comment_reply ids resolve to not_found here and are read
        // through /api/v1/me/community-notifications/read.
        const row = (await sql<{ state: 'unread' | 'read'; state_revision: string; read_at: Date | null }>`
          select state,state_revision,read_at from notifications
          where recipient_account_id=${input.principalId}
            and notification_id=${input.notificationId}
            and notification_type in ('collection_change','follow_activity')
          for update
        `.execute(transaction)).rows[0];
        if (!row) { await options.faultInjector?.afterPhase?.('authority'); return { kind: 'not_found' }; }
        if (row.state === 'read') {
          if (!row.read_at) throw new Error('invalid read Notification authority row');
          await options.faultInjector?.afterPhase?.('authority');
          return { kind: 'already_read', stateRevision: BigInt(row.state_revision), readAt: row.read_at };
        }
        if (BigInt(row.state_revision) !== input.expectedStateRevision) {
          await options.faultInjector?.afterPhase?.('authority'); return { kind: 'stale' };
        }
        const updated = (await sql<{ state_revision: string; read_at: Date }>`
          update notifications set state='read',read_at=current_timestamp,
            retain_until=least(retain_until,current_timestamp + interval '90 days'),
            state_revision=state_revision+1
          where recipient_account_id=${input.principalId}
            and notification_id=${input.notificationId} and state='unread'
            and state_revision=${input.expectedStateRevision}
          returning state_revision,read_at
        `.execute(transaction)).rows[0];
        if (!updated) throw new Error('Notification read CAS lost while row lock was held');
        await options.faultInjector?.afterPhase?.('authority');
        return { kind: 'marked', stateRevision: BigInt(updated.state_revision), readAt: updated.read_at };
      },
      async markMany(input) {
        // CS-05: bulk legacy read ignores community comment_reply ids.
        const locked = await sql<{ notification_id: string }>`
          select notification_id from notifications
          where recipient_account_id=${input.principalId}
            and notification_type in ('collection_change','follow_activity')
            and notification_id = any(${sql.val(input.notificationIds)}::text[])
          order by notification_id for update
        `.execute(transaction);
        const ownedIds = locked.rows.map((row) => row.notification_id);
        let markedCount = 0;
        if (ownedIds.length > 0) {
          const updated = await sql`
            update notifications set state='read',read_at=current_timestamp,
              retain_until=least(retain_until,current_timestamp + interval '90 days'),
              state_revision=state_revision+1
            where recipient_account_id=${input.principalId}
              and notification_id = any(${sql.val(ownedIds)}::text[]) and state='unread'
          `.execute(transaction);
          markedCount = Number(updated.numAffectedRows ?? 0n);
        }
        await options.faultInjector?.afterPhase?.('authority');
        return { requestedCount: input.notificationIds.length, markedCount };
      },
    },
    audit: { async append(event: NotificationReadAuditEvent): Promise<void> {
      await appendAuditEvent(transaction, { operationId: null, collectionId: null,
        principalId: event.principalId, eventType: 'notification.read_state_command',
        details: { mode: event.mode, requestedCount: event.requestedCount,
          changedCount: event.changedCount, outcome: event.outcome }, createdAt: event.createdAt });
      await options.faultInjector?.afterPhase?.('audit');
    } },
    clock: { async now() {
      return (await sql<{ now: Date }>`select current_timestamp now`.execute(transaction)).rows[0]!.now;
    } },
  };
  return Object.freeze(ports);
}

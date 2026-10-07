import { sql, type Kysely } from 'kysely';
import type {
  NotificationPreferenceAuditEvent,
  NotificationPreferenceCommandPorts,
  NotificationPreferenceReadPort,
} from '../../modules/notifications/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { appendAuditEvent, createPostgresProductCommandReceiptPort, createUnitOfWork,
  type DatabaseSchema, type DatabaseTransaction,
  type TransactionFaultInjector } from '../database/index.js';

export type NotificationPreferenceCommandWritePhase =
  'receipt' | 'authority' | 'audit' | 'complete';
export interface NotificationPreferenceCommandFaultInjector {
  afterPhase?(phase: NotificationPreferenceCommandWritePhase): void | Promise<void>;
}
export interface PostgresNotificationPreferenceCommandUnitOfWorkOptions {
  readonly faultInjector?: NotificationPreferenceCommandFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
}
export interface PostgresNotificationPreferenceCommandUnitOfWork {
  execute<Result>(work: (ports: NotificationPreferenceCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal }): Promise<Result>;
}

export function getPostgresNotificationPreferences(
  db: Kysely<DatabaseSchema>): NotificationPreferenceReadPort {
  const port: NotificationPreferenceReadPort = {
    getForPrincipal(principalId, options = {}) {
      const work = async (transaction: DatabaseTransaction) => {
          await ensureDefaults(transaction, principalId);
          const rows = (await sql<PreferenceRow>`select channel,enabled,state_revision,updated_at
            from notification_preferences preference
            join accounts account on account.id=preference.recipient_account_id
            where preference.recipient_account_id=${principalId}
              and preference.channel in ('in_app','email')
              and account.status='active' and account.deleted_at is null
            order by preference.channel
          `.execute(transaction)).rows;
          if (rows.length !== 2) throw new Error('Notification preferences require an active account');
          const byChannel = new Map(rows.map((row) => [row.channel, row]));
          const inApp = byChannel.get('in_app');
          const email = byChannel.get('email');
          if (!inApp || !email) throw new Error('Notification preferences require an active account');
          const suppression = (await sql<SuppressionRow>`select source
            from notification_email_suppressions
            where recipient_account_id=${principalId}
          `.execute(transaction)).rows[0];
          return { inApp: mapPreference(inApp), email: mapPreference(email),
            emailSuppressed: suppression?.source != null };
        };
      return options.signal === undefined
        ? createUnitOfWork(db, { isolationLevel: 'read committed' }).execute(({ transaction }) => work(transaction))
        : executeAbortableRead(db, work, options.signal);
    },
  };
  return Object.freeze(port);
}

export function createPostgresNotificationPreferenceCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresNotificationPreferenceCommandUnitOfWorkOptions = {},
): PostgresNotificationPreferenceCommandUnitOfWork {
  return Object.freeze({
    execute<Result>(work: (ports: NotificationPreferenceCommandPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {}): Promise<Result> {
      if (execution.signal !== undefined) return executeAbortableCommand(db, options, work, execution.signal);
      return createUnitOfWork(db, { isolationLevel: 'read committed',
        ...(options.transactionFaultInjector
          ? { faultInjector: options.transactionFaultInjector } : {}) })
        .execute(({ transaction }) => work(createPorts(transaction, options)));
    },
  });
}

async function executeAbortableRead<Result>(db: Kysely<DatabaseSchema>,
  work: (transaction: DatabaseTransaction) => Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
    const remove = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      const result = await work(transaction);
      if (signal.aborted) throw signal.reason;
      return result;
    } finally { await remove(); }
  });
}

async function executeAbortableCommand<Result>(db: Kysely<DatabaseSchema>,
  options: PostgresNotificationPreferenceCommandUnitOfWorkOptions,
  work: (ports: NotificationPreferenceCommandPorts) => Promise<Result>, signal: AbortSignal): Promise<Result> {
  if (signal.aborted) throw signal.reason;
  return db.transaction().setIsolationLevel('read committed').execute(async (transaction) => {
    const remove = await installPostgresTransactionCancellation(transaction, signal);
    try {
      if (signal.aborted) throw signal.reason;
      await options.transactionFaultInjector?.beforeCallback?.(transaction);
      const result = await work(createPorts(transaction, options));
      await options.transactionFaultInjector?.afterCallbackBeforeCommit?.(transaction);
      if (signal.aborted) throw signal.reason;
      return result;
    } finally { await remove(); }
  });
}

interface PreferenceRow { channel: 'in_app' | 'email'; enabled: boolean; state_revision: string; updated_at: Date }
interface SuppressionRow { source: string }

function createPorts(transaction: DatabaseTransaction,
  options: PostgresNotificationPreferenceCommandUnitOfWorkOptions):
  NotificationPreferenceCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  const ports: NotificationPreferenceCommandPorts = {
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
      async update(input) {
        await ensureDefaults(transaction, input.principalId);
        const current = (await sql<PreferenceRow>`select channel,enabled,state_revision,updated_at
          from notification_preferences preference
          join accounts account on account.id=preference.recipient_account_id
          where preference.recipient_account_id=${input.principalId}
            and preference.channel=${input.channel}
            and account.status='active' and account.deleted_at is null
          for update of preference
        `.execute(transaction)).rows[0];
        if (!current) throw new Error('Notification preferences require an active account');
        if (BigInt(current.state_revision) !== input.expectedRevision) {
          await options.faultInjector?.afterPhase?.('authority');
          return { kind: 'stale' as const };
        }
        if (current.enabled === input.enabled) {
          await options.faultInjector?.afterPhase?.('authority');
          return { ...mapPreference(current), changed: false };
        }
        const updated = (await sql<PreferenceRow>`update notification_preferences
          set enabled=${input.enabled},state_revision=state_revision+1,
            updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
          where recipient_account_id=${input.principalId} and channel=${input.channel}
            and state_revision=${input.expectedRevision}
          returning channel,enabled,state_revision,updated_at
        `.execute(transaction)).rows[0];
        if (!updated) throw new Error('Notification preference CAS lost while row lock was held');
        await options.faultInjector?.afterPhase?.('authority');
        return { ...mapPreference(updated), changed: true };
      },
    },
    audit: { async append(event: NotificationPreferenceAuditEvent): Promise<void> {
      await appendAuditEvent(transaction, { operationId: null,
        collectionId: null, principalId: event.principalId,
        eventType: 'notification.preference_command', details: { mode: event.mode,
          channel: event.channel, changed: event.changed, outcome: event.outcome },
        createdAt: event.createdAt });
      await options.faultInjector?.afterPhase?.('audit');
    } },
    clock: { async now() {
      return (await sql<{ now: Date }>`select current_timestamp now`
        .execute(transaction)).rows[0]!.now;
    } },
  };
  return Object.freeze(ports);
}

async function ensureDefaults(transaction: DatabaseTransaction,
  principalId: string): Promise<void> {
  await sql`insert into notification_preferences(recipient_account_id,channel,enabled)
    select account.id,defaults.channel,defaults.enabled
      from accounts account
      cross join (values ('in_app',true),('email',false)) defaults(channel,enabled)
      where account.id=${principalId} and account.status='active' and account.deleted_at is null
    on conflict (recipient_account_id,channel) do nothing`.execute(transaction);
}

function mapPreference(row: PreferenceRow): {
  readonly enabled: boolean; readonly stateRevision: bigint; readonly updatedAt: Date;
} {
  return Object.freeze({ enabled: row.enabled, stateRevision: BigInt(row.state_revision),
    updatedAt: row.updated_at });
}

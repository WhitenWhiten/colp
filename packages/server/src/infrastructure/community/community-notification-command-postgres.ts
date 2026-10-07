import { sql, type Kysely } from 'kysely';
import {
  COMMUNITY_NOTIFICATION_CHANNEL,
  COMMUNITY_NOTIFICATION_KIND,
  communityNotificationPreferenceEtag,
  type CommunityNotificationAuditEvent,
  type CommunityNotificationCommandPorts,
  type CommunityNotificationPreferenceRecord,
} from '../../modules/community/index.js';
import { installPostgresTransactionCancellation } from '../database/postgres-cancellation.js';
import { appendAuditEvent } from '../database/audit-event-payload.js';
import { createPostgresProductCommandReceiptPort } from '../database/product-command-receipt.js';
import { databaseNow } from '../database/time.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionFaultInjector,
} from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import { loadCommunityCommentRecords } from './community-comment-shared-postgres.js';
import { resolveCommunityTargetRow } from './community-target-shared-postgres.js';
import { communityNotificationUnreadGroupsSql } from './community-notification-query-postgres.js';

export type CommunityNotificationCommandWritePhase = 'receipt' | 'authority' | 'audit' | 'complete';

export interface CommunityNotificationCommandFaultInjector {
  afterPhase?(phase: CommunityNotificationCommandWritePhase): void | Promise<void>;
}

export interface PostgresCommunityNotificationCommandUnitOfWorkOptions {
  /** COMMUNITY_CURSOR_HMAC_KEY — derives the strong opaque preference ETag. */
  readonly etagHmacKey: Buffer;
  readonly faultInjector?: CommunityNotificationCommandFaultInjector;
  readonly transactionFaultInjector?: TransactionFaultInjector;
}

export interface PostgresCommunityNotificationCommandUnitOfWork {
  execute<Result>(
    work: (ports: CommunityNotificationCommandPorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

interface NotificationRow {
  readonly notification_id: string;
  readonly actor_profile_id: string | null;
  readonly subject_id: string;
  readonly state: 'unread' | 'read';
  readonly read_at: Date | null;
  readonly occurred_at: Date;
}

interface PreferenceRow {
  readonly enabled: boolean;
  readonly state_revision: string;
  readonly updated_at: Date;
}

/**
 * CS-05 write ports for markCommunityNotificationsRead +
 * putCommunityNotificationPreference. One transaction holds the receipt
 * claim, the FOR SHARE account lock, the preference row lock/CAS, the
 * notification row locks + mark, the audit event, and the durable result.
 */
export function createPostgresCommunityNotificationCommandUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityNotificationCommandUnitOfWorkOptions,
): PostgresCommunityNotificationCommandUnitOfWork {
  if (!(options.etagHmacKey instanceof Buffer) || options.etagHmacKey.length < 16) {
    throw new TypeError('community notification command requires a configured ETag HMAC key');
  }
  return Object.freeze<PostgresCommunityNotificationCommandUnitOfWork>({
    execute<Result>(work: (ports: CommunityNotificationCommandPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {}): Promise<Result> {
      if (execution.signal !== undefined) {
        return executeAbortable(db, options, work, execution.signal);
      }
      return createUnitOfWork(db, {
        isolationLevel: 'read committed',
        ...(options.transactionFaultInjector
          ? { faultInjector: options.transactionFaultInjector }
          : {}),
      }).execute(({ transaction }) => work(createPorts(transaction, options)));
    },
  });
}

async function executeAbortable<Result>(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityNotificationCommandUnitOfWorkOptions,
  work: (ports: CommunityNotificationCommandPorts) => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
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
    } finally {
      await disposeCancellation();
    }
  });
}

function toPreferenceRecord(row: PreferenceRow): CommunityNotificationPreferenceRecord {
  return Object.freeze<CommunityNotificationPreferenceRecord>({
    enabled: row.enabled,
    revision: BigInt(row.state_revision),
    updatedAt: row.updated_at,
  });
}

function createPorts(
  transaction: DatabaseTransaction,
  options: PostgresCommunityNotificationCommandUnitOfWorkOptions,
): CommunityNotificationCommandPorts {
  const receipts = createPostgresProductCommandReceiptPort(transaction);
  return Object.freeze<CommunityNotificationCommandPorts>({
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
    actor: {
      async lockActiveAccount(accountId) {
        const result = await sql<{ subject_id: string; created_at: Date }>`
          select account.subject_id, account.created_at
          from accounts account
          where account.id = ${accountId}
            and account.status = 'active'
            and account.deleted_at is null
          for share of account
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : Object.freeze({
          subjectId: row.subject_id, createdAt: row.created_at,
        });
      },
    },
    preferences: {
      async findCommunity(recipientAccountId) {
        const result = await sql<PreferenceRow>`
          select enabled, state_revision::text, updated_at from notification_preferences
          where recipient_account_id = ${recipientAccountId}
            and channel = ${COMMUNITY_NOTIFICATION_CHANNEL}
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : toPreferenceRecord(row);
      },
      async lockCommunity(recipientAccountId) {
        const result = await sql<PreferenceRow>`
          select enabled, state_revision::text, updated_at from notification_preferences
          where recipient_account_id = ${recipientAccountId}
            and channel = ${COMMUNITY_NOTIFICATION_CHANNEL}
          for update
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : toPreferenceRecord(row);
      },
      async insertCommunity(recipientAccountId, write) {
        const result = await sql<PreferenceRow>`
          insert into notification_preferences(recipient_account_id, channel, enabled,
            state_revision, updated_at)
          values (${recipientAccountId}, ${COMMUNITY_NOTIFICATION_CHANNEL}, ${write.enabled},
            ${write.revision}, ${write.updatedAt})
          returning enabled, state_revision::text, updated_at
        `.execute(transaction);
        const row = result.rows[0];
        if (row === undefined) throw new Error('community notification preference insert returned no row');
        await options.faultInjector?.afterPhase?.('authority');
        return toPreferenceRecord(row);
      },
      async updateCommunity(recipientAccountId, enabled, expectedRevision, updatedAt) {
        const result = await sql<PreferenceRow>`
          update notification_preferences
          set enabled = ${enabled},
            state_revision = state_revision + 1,
            updated_at = ${updatedAt}
          where recipient_account_id = ${recipientAccountId}
            and channel = ${COMMUNITY_NOTIFICATION_CHANNEL}
            and state_revision = ${expectedRevision}
          returning enabled, state_revision::text, updated_at
        `.execute(transaction);
        const row = result.rows[0];
        await options.faultInjector?.afterPhase?.('authority');
        return row === undefined ? null : toPreferenceRecord(row);
      },
    },
    notifications: {
      async lockForRead(recipientAccountId, notificationIds) {
        const result = await sql<NotificationRow>`
          select notification_id, actor_profile_id, subject_id, state, read_at, occurred_at
          from notifications
          where recipient_account_id = ${recipientAccountId}
            and notification_type = ${COMMUNITY_NOTIFICATION_KIND}
            and notification_id = any(${[...notificationIds]}::text[])
          order by notification_id
          for update
        `.execute(transaction);
        return Object.freeze(result.rows.map((row) => Object.freeze({
          notificationId: row.notification_id,
          actorProfileId: row.actor_profile_id,
          subjectId: row.subject_id,
          state: row.state,
          readAt: row.read_at,
          occurredAt: row.occurred_at,
        })));
      },
      async markRead(recipientAccountId, notificationIds, readAt) {
        const result = await sql<{ notification_id: string }>`
          update notifications
          set state = 'read',
            read_at = ${readAt},
            retain_until = least(retain_until, ${readAt}::timestamptz + interval '90 days'),
            state_revision = state_revision + 1
          where recipient_account_id = ${recipientAccountId}
            and notification_type = ${COMMUNITY_NOTIFICATION_KIND}
            and notification_id = any(${[...notificationIds]}::text[])
            and state = 'unread'
          returning notification_id
        `.execute(transaction);
        await options.faultInjector?.afterPhase?.('authority');
        return Object.freeze(result.rows.map((row) => row.notification_id));
      },
      async unreadGroups(recipientAccountId) {
        const result = await communityNotificationUnreadGroupsSql(recipientAccountId)
          .execute(transaction);
        return Object.freeze(result.rows.map((row) => Object.freeze({
          target: Object.freeze({
            kind: row.target_kind,
            id: row.target_id,
            collectionId: row.target_collection_id,
            seriesId: row.target_series_id,
          }),
          targetGeneration: row.target_generation,
          count: Number(row.n),
        })));
      },
    },
    comments: {
      findMany: (commentIds) => loadCommunityCommentRecords(transaction, commentIds),
    },
    targets: {
      resolve: (query) => resolveCommunityTargetRow(transaction, query, 'none'),
    },
    etags: {
      preference: (input) => communityNotificationPreferenceEtag(input, options.etagHmacKey),
    },
    audit: {
      async append(event: CommunityNotificationAuditEvent): Promise<void> {
        await appendAuditEvent(transaction, {
          operationId: null,
          collectionId: null,
          principalId: event.principalId,
          eventType: event.eventType,
          details: event.details,
          createdAt: event.createdAt,
        });
        await options.faultInjector?.afterPhase?.('audit');
      },
    },
    clock: {
      now: () => databaseNow(transaction),
    },
  });
}

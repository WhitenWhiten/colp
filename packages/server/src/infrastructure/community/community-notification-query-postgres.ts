import { sql, type Kysely } from 'kysely';
import {
  COMMUNITY_NOTIFICATION_CHANNEL,
  COMMUNITY_NOTIFICATION_KIND,
  type CommunityNotificationKeysetPosition,
  type CommunityNotificationPreferenceRecord,
  type CommunityNotificationQueryPorts,
  type CommunityNotificationRow,
  type CommunityNotificationUnreadGroup,
} from '../../modules/community/index.js';
import type { CommunityTargetIdentity, CommunityTargetKind } from '../../modules/community/index.js';
import { databaseNow } from '../database/time.js';
import {
  createUnitOfWork,
  type DatabaseTransaction,
  type TransactionFaultInjector,
} from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';
import {
  loadCommunityCommentAuthors,
  loadCommunityCommentRecords,
} from './community-comment-shared-postgres.js';
import { resolveCommunityTargetRows } from './community-target-batch-postgres.js';
import { resolveCommunityTargetRow } from './community-target-shared-postgres.js';

export interface PostgresCommunityNotificationQueryUnitOfWorkOptions {
  readonly transactionFaultInjector?: TransactionFaultInjector;
}

export interface PostgresCommunityNotificationQueryUnitOfWork {
  execute<Result>(
    work: (ports: CommunityNotificationQueryPorts) => Promise<Result>,
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

interface UnreadGroupRow {
  readonly target_kind: CommunityTargetKind;
  readonly target_id: string;
  readonly target_collection_id: string | null;
  readonly target_series_id: string | null;
  readonly target_generation: string;
  readonly n: string;
}

interface PreferenceRow {
  readonly enabled: boolean;
  readonly state_revision: string;
  readonly updated_at: Date;
}

/**
 * CS-05 read ports for listCommunityNotifications +
 * getCommunityNotificationPreference. Every page row is re-proven against
 * the comment + resolved target authority in the application layer; the
 * SQL here only narrows to the recipient's `comment_reply` rows in the
 * fixed keyset order.
 */
export function createPostgresCommunityNotificationQueryUnitOfWork(
  db: Kysely<DatabaseSchema>,
  options: PostgresCommunityNotificationQueryUnitOfWorkOptions = {},
  cancelBackend?: (backendPid: number) => Promise<boolean>,
): PostgresCommunityNotificationQueryUnitOfWork {
  return Object.freeze<PostgresCommunityNotificationQueryUnitOfWork>({
    execute<Result>(work: (ports: CommunityNotificationQueryPorts) => Promise<Result>,
      execution: { readonly signal?: AbortSignal } = {}): Promise<Result> {
      return createUnitOfWork(db, {
        isolationLevel: 'read committed',
        signal: execution.signal,
        cancelBackend,
        ...(options.transactionFaultInjector
          ? { faultInjector: options.transactionFaultInjector }
          : {}),
      }).execute(({ transaction }) => work(createPorts(transaction)));
    },
  });
}

function toNotificationRow(row: NotificationRow): CommunityNotificationRow {
  return Object.freeze<CommunityNotificationRow>({
    notificationId: row.notification_id,
    actorProfileId: row.actor_profile_id,
    subjectId: row.subject_id,
    state: row.state,
    readAt: row.read_at,
    occurredAt: row.occurred_at,
  });
}

function toPreferenceRecord(row: PreferenceRow): CommunityNotificationPreferenceRecord {
  return Object.freeze<CommunityNotificationPreferenceRecord>({
    enabled: row.enabled,
    revision: BigInt(row.state_revision),
    updatedAt: row.updated_at,
  });
}

/**
 * The shared page SELECT: recipient's comment_reply rows, keyset DESC.
 *
 * The cursor position only carries `pos.t` at millisecond precision
 * (RFC3339 `toISOString`) while `occurred_at` is a microsecond
 * `timestamptz` from the inserting transaction's `current_timestamp`.
 * Comparing against the truncated value would permanently skip
 * unconsumed rows that share the boundary millisecond but carry smaller
 * microsecond values (their stored micros exceed the truncated millis).
 * `after.notificationId` re-reads the boundary row's exact stored
 * `occurred_at`; the carried position is the fallback should that row
 * ever vanish. See keysetBoundaryStamp in community-comment-shared-postgres.ts.
 */
export function communityNotificationPageSql(
  recipientAccountId: string,
  state: 'unread' | undefined,
  after: CommunityNotificationKeysetPosition | null,
  limit: number,
) {
  return sql<NotificationRow>`
    select notification_id, actor_profile_id, subject_id, state, read_at, occurred_at
    from notifications
    where recipient_account_id = ${recipientAccountId}
      and notification_type = ${COMMUNITY_NOTIFICATION_KIND}
      ${state === 'unread' ? sql`and state = 'unread'` : sql``}
      ${after === null ? sql`` : sql`
        and (occurred_at, notification_id) < (
          coalesce(
            (select b.occurred_at from notifications b
              where b.notification_id = ${after.notificationId}),
            ${after.occurredAt}::timestamptz),
          ${after.notificationId}::text)`}
    order by occurred_at desc, notification_id desc
    limit ${limit}
  `;
}

/** The unread count grouped by the reply comment's pinned target identity. */
export function communityNotificationUnreadGroupsSql(recipientAccountId: string) {
  return sql<UnreadGroupRow>`
    select c.target_kind, c.target_id, c.target_collection_id, c.target_series_id,
      c.target_generation, count(*)::text as n
    from notifications n
    join community_comments c on c.comment_id = n.subject_id
    where n.recipient_account_id = ${recipientAccountId}
      and n.notification_type = ${COMMUNITY_NOTIFICATION_KIND}
      and n.state = 'unread'
    group by c.target_kind, c.target_id, c.target_collection_id, c.target_series_id,
      c.target_generation
  `;
}

function toUnreadGroup(row: UnreadGroupRow): CommunityNotificationUnreadGroup {
  return Object.freeze<CommunityNotificationUnreadGroup>({
    target: Object.freeze<CommunityTargetIdentity>({
      kind: row.target_kind,
      id: row.target_id,
      collectionId: row.target_collection_id,
      seriesId: row.target_series_id,
    }),
    targetGeneration: row.target_generation,
    count: Number(row.n),
  });
}

function createPorts(transaction: DatabaseTransaction): CommunityNotificationQueryPorts {
  return Object.freeze<CommunityNotificationQueryPorts>({
    account: {
      async findActive(accountId) {
        const result = await sql<{ id: string; subject_id: string; created_at: Date }>`
          select id, subject_id, created_at from accounts
          where id = ${accountId} and status = 'active' and deleted_at is null
        `.execute(transaction);
        const row = result.rows[0];
        return row === undefined ? null : Object.freeze({
          accountId: row.id, subjectId: row.subject_id, createdAt: row.created_at,
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
    },
    notifications: {
      async page(recipientAccountId, state, after, limit) {
        const result = await communityNotificationPageSql(
          recipientAccountId, state, after, limit,
        ).execute(transaction);
        return Object.freeze(result.rows.map(toNotificationRow));
      },
      async unreadGroups(recipientAccountId) {
        const result = await communityNotificationUnreadGroupsSql(recipientAccountId)
          .execute(transaction);
        return Object.freeze(result.rows.map(toUnreadGroup));
      },
    },
    comments: {
      findMany: (commentIds) => loadCommunityCommentRecords(transaction, commentIds),
    },
    targets: {
      resolve: (query) => resolveCommunityTargetRow(transaction, query, 'none'),
      // One statement per kind for the whole page: an unread backlog can carry
      // hundreds of distinct groups.
      resolveMany: (queries) => resolveCommunityTargetRows(transaction, queries),
    },
    authors: {
      publicActors: (accountIds) => loadCommunityCommentAuthors(transaction, accountIds),
    },
    clock: {
      now: () => databaseNow(transaction),
    },
  });
}

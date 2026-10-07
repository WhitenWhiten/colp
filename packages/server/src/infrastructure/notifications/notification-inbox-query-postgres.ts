import { CompiledQuery, type Kysely } from 'kysely';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type NotificationInboxPageReadInput, type NotificationInboxQueryFact, type NotificationInboxReadPort,
  type NotificationUnreadCountInput,
} from '../../modules/notifications/index.js';
import {
  collectionHidePublicControlSql,
  collectionHidePublicExistsSql,
} from '../governance/collection-control-sql.js';

interface NotificationInboxRow {
  notification_id: string; notification_type: NotificationInboxQueryFact['notificationType'];
  actor_profile_id: string | null; actor_handle: string | null; actor_display_name: string | null;
  subject_type: NotificationInboxQueryFact['subjectType'];
  subject_id: string; collection_title: string | null; publication_slug: string | null;
  state: NotificationInboxQueryFact['state']; state_revision: string;
  read_at: Date | null; occurred_at: Date;
}
interface UnreadCountRow { count: string; }
export interface NotificationInboxStatement {
  readonly text: string; readonly values: readonly unknown[];
}

export function createPostgresNotificationInboxReadPort<Database>(
  database: Pick<Kysely<Database>, 'executeQuery'>,
): NotificationInboxReadPort {
  return Object.freeze({
    async loadPage(input: NotificationInboxPageReadInput) {
      const statement = buildNotificationInboxPageStatement(input);
      const result = await database.executeQuery<NotificationInboxRow>(
        CompiledQuery.raw(statement.text, [...statement.values]), options(input.signal));
      return Object.freeze(result.rows.map((row) => Object.freeze({
        notificationId: row.notification_id, notificationType: row.notification_type,
        actorProfileId: row.actor_profile_id, actorHandle: row.actor_handle ?? null,
        actorDisplayName: row.actor_display_name ?? null, subjectType: row.subject_type,
        subjectId: row.subject_id, collectionTitle: row.collection_title ?? null,
        publicationSlug: row.publication_slug ?? null, summary: null,
        state: row.state, stateRevision: BigInt(row.state_revision), readAt: row.read_at, occurredAt: row.occurred_at,
      })));
    },
    async countUnread(input: NotificationUnreadCountInput) {
      validatePrincipal(input.principalId);
      const statement = buildNotificationUnreadCountStatement(input.principalId);
      const result = await database.executeQuery<UnreadCountRow>(
        CompiledQuery.raw(statement.text, [...statement.values]), options(input.signal));
      const count = Number(result.rows[0]?.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid Notification unread count row');
      return count;
    },
  });
}

/** Exact Notification-only authority SELECT used by the application and query-plan evidence. */
export function buildNotificationInboxPageStatement(
  input: NotificationInboxPageReadInput,
): NotificationInboxStatement {
  validatePageInput(input); const values: unknown[] = [input.principalId];
  const parameter = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  // CS-05: the legacy inbox serves only legacy notification kinds. Community
  // comment_reply rows share the table/authority but are concealed here and
  // served through /api/v1/me/community-notifications. CG-03: collection_change
  // rows for a hide_public collection are concealed too.
  const filters = [
    'notification.recipient_account_id=$1',
    `notification.notification_type in ('collection_change','follow_activity')`,
    `not (notification.notification_type='collection_change' and ${collectionHidePublicExistsSql('notification.subject_id')})`,
  ];
  if (input.state) filters.push(`notification.state=${parameter(input.state)}`);
  if (input.after) {
    const occurredAt = parameter(input.after.occurredAt);
    const notificationId = parameter(input.after.notificationId);
    filters.push(`(notification.occurred_at,notification.notification_id)<(${occurredAt}::timestamptz,${notificationId}::text)`);
  }
  const limit = parameter(input.limit + 1);
  return Object.freeze({ text: `select notification.notification_id,notification.notification_type,
        notification.actor_profile_id,actor_locator.handle actor_handle,
        actor_locator.display_name actor_display_name,notification.subject_type,notification.subject_id,
        collection_locator.title collection_title,collection_locator.publication_slug publication_slug,
        notification.state,notification.state_revision,notification.read_at,
        notification.occurred_at
      from notifications notification
      left join lateral (
        select lower(actor_handle.handle) handle,nullif(actor_profile.display_name,'') display_name
          from profiles actor_profile
          join accounts actor_account on actor_account.id=actor_profile.account_id
            and actor_account.status='active' and actor_account.deleted_at is null
          join profile_handles actor_handle on actor_handle.account_id=actor_profile.account_id
         where actor_profile.account_id=notification.actor_profile_id
         limit 1
      ) actor_locator on true
      left join lateral (
        select collection.title,collection.publication_slug
          from collections collection
         where notification.notification_type='collection_change'
           and notification.subject_type='collection'
           and collection.id=notification.subject_id
           and collection.deleted_at is null and collection.visibility='public'
           and collection.publication_slug is not null and collection.published_at is not null
           and ${collectionHidePublicControlSql('collection')}
         limit 1
      ) collection_locator on true
      where ${filters.join(' and ')}
      order by notification.occurred_at desc,notification.notification_id desc
      limit ${limit}`, values: Object.freeze(values) });
}

/** Independent authority count; it is intentionally not derived from the current page. */
export function buildNotificationUnreadCountStatement(principalId: string): NotificationInboxStatement {
  validatePrincipal(principalId);
  // CS-05: the legacy unread badge counts only legacy kinds.
  return Object.freeze({ text: `select count(*)::bigint count from notifications
    where recipient_account_id=$1 and state='unread'
      and notification_type in ('collection_change','follow_activity')
      and not (notifications.notification_type='collection_change' and ${collectionHidePublicExistsSql('notifications.subject_id')})`, values: Object.freeze([principalId]) });
}

function validatePageInput(input: NotificationInboxPageReadInput): void {
  if (!input || typeof input !== 'object') throw new TypeError('invalid Notification inbox page input');
  validatePrincipal(input.principalId);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || (input.state !== undefined && input.state !== 'read' && input.state !== 'unread')
    || (input.after !== undefined && (!(input.after.occurredAt instanceof Date)
      || !Number.isFinite(input.after.occurredAt.getTime())
      || !validIdentity(input.after.notificationId)))) {
    throw new TypeError('invalid Notification inbox page input');
  }
}
function validatePrincipal(value: unknown): asserts value is string {
  if (!validIdentity(value)) throw new TypeError('invalid Notification inbox principal');
}
function validIdentity(value: unknown): value is string { return typeof value === 'string'
  && value.length > 0 && value.length <= SOCIAL_IDENTITY_MAX_LENGTH && value.trim() === value; }
function options(signal?: AbortSignal) { return signal ? { signal,
  inflightQueryAbortStrategy: 'cancel query' as const } : undefined; }

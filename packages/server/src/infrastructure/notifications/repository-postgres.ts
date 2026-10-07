import type { Pool } from 'pg';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type NotificationAuthorityRepository,
  type NotificationDeliveryInput,
  type NotificationDeliveryRecord,
  type NotificationDeliveryStateCas,
  type NotificationInput,
  type NotificationPreferences,
  type NotificationRecord,
  type NotificationStateCas,
  type PurgeExpiredNotificationsInput,
  type PurgedNotifications,
  type PurgeExpiredDeliveriesInput,
  type PurgedDeliveries,
  type SavedNotification,
  type SavedNotificationDelivery,
} from '../../modules/notifications/index.js';

interface PreferenceRow {
  recipient_account_id: string;
  channel: 'in_app' | 'email';
  enabled: boolean;
  state_revision: string;
  updated_at: Date;
}

interface NotificationRow {
  notification_id: string;
  recipient_account_id: string;
  source_event_id: string;
  notification_type: 'collection_change' | 'follow_activity';
  actor_profile_id: string | null;
  subject_type: 'collection' | 'profile';
  subject_id: string;
  state: 'unread' | 'read';
  read_at: Date | null;
  state_revision: string;
  occurred_at: Date;
  retain_until: Date;
  created_at: Date;
}

interface DeliveryRow {
  delivery_id: string;
  notification_id: string;
  recipient_account_id: string;
  channel: 'email';
  state: 'pending' | 'leased' | 'retryable' | 'delivered' | 'suppressed' | 'dead_letter';
  attempt_count: number;
  state_revision: string;
  next_attempt_at: Date;
  leased_until: Date | null;
  delivered_at: Date | null;
  suppressed_at: Date | null;
  dead_lettered_at: Date | null;
  provider_message_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const MAX_IDENTITY = SOCIAL_IDENTITY_MAX_LENGTH;

export function createPostgresNotificationAuthorityRepository(
  pool: Pool,
): NotificationAuthorityRepository {
  return Object.freeze({
    async getPreferences(recipientAccountId: string): Promise<NotificationPreferences> {
      assertText(recipientAccountId, 'recipientAccountId', MAX_IDENTITY);
      await pool.query(`insert into notification_preferences(
          recipient_account_id,channel,enabled)
        select account.id,defaults.channel,defaults.enabled
          from accounts account
          cross join (values ('in_app',true),('email',false)) defaults(channel,enabled)
         where account.id=$1 and account.status='active' and account.deleted_at is null
        on conflict (recipient_account_id,channel) do nothing`, [recipientAccountId]);
      const result = await pool.query<PreferenceRow>(`select preference.*
        from notification_preferences preference
        join accounts account on account.id=preference.recipient_account_id
        where preference.recipient_account_id=$1
          and account.status='active' and account.deleted_at is null
        order by preference.channel`, [recipientAccountId]);
      const byChannel = new Map(result.rows.map((row) => [row.channel, row]));
      const inApp = byChannel.get('in_app');
      const email = byChannel.get('email');
      if (!inApp || !email) throw new Error('Notification preferences require an active account');
      return mapPreferences(inApp, email);
    },

    async saveNotification(input: NotificationInput): Promise<SavedNotification> {
      assertNotification(input);
      const inserted = await pool.query<NotificationRow>(`insert into notifications(
          notification_id,recipient_account_id,source_event_id,notification_type,
          actor_profile_id,subject_type,subject_id,occurred_at,retain_until)
        values($1,$2,$3,$4,$5,$6,$7,$8,$8::timestamptz + interval '365 days')
        on conflict (recipient_account_id,source_event_id,notification_type) do nothing
        returning *`, [
        input.notificationId, input.recipientAccountId, input.sourceEventId,
        input.notificationType, input.actorProfileId, input.subjectType, input.subjectId,
        input.occurredAt,
      ]);
      if (inserted.rows[0]) {
        return Object.freeze({ notification: mapNotification(inserted.rows[0]), inserted: true });
      }
      const winner = await pool.query<NotificationRow>(`select * from notifications
        where recipient_account_id=$1 and source_event_id=$2 and notification_type=$3`, [
        input.recipientAccountId, input.sourceEventId, input.notificationType,
      ]);
      if (!winner.rows[0]) {
        throw new Error('Notification uniqueness conflict has no durable recipient/event/type winner');
      }
      assertNotificationWinner(winner.rows[0], input);
      return Object.freeze({ notification: mapNotification(winner.rows[0]), inserted: false });
    },

    async saveDelivery(input: NotificationDeliveryInput): Promise<SavedNotificationDelivery> {
      assertDelivery(input);
      const inserted = await pool.query<DeliveryRow>(`insert into notification_deliveries(
          delivery_id,notification_id,recipient_account_id,channel)
        values($1,$2,$3,$4)
        on conflict (notification_id,channel) do nothing returning *`, [
        input.deliveryId, input.notificationId, input.recipientAccountId, input.channel,
      ]);
      if (inserted.rows[0]) {
        return Object.freeze({ delivery: mapDelivery(inserted.rows[0]), inserted: true });
      }
      const winner = await pool.query<DeliveryRow>(`select * from notification_deliveries
        where notification_id=$1 and channel=$2`, [input.notificationId, input.channel]);
      if (!winner.rows[0]) {
        throw new Error('Notification delivery uniqueness conflict has no durable winner');
      }
      if (winner.rows[0].recipient_account_id !== input.recipientAccountId) {
        throw new Error('Notification delivery winner conflicts with immutable owner facts');
      }
      return Object.freeze({ delivery: mapDelivery(winner.rows[0]), inserted: false });
    },

    async markRead(input: NotificationStateCas): Promise<NotificationRecord | null> {
      assertText(input.recipientAccountId, 'recipientAccountId', MAX_IDENTITY);
      assertText(input.notificationId, 'notificationId', 128);
      assertRevision(input.expectedStateRevision);
      const result = await pool.query<NotificationRow>(`update notifications
        set state='read',read_at=current_timestamp,
            retain_until=least(retain_until,current_timestamp + interval '90 days'),
            state_revision=state_revision+1
        where recipient_account_id=$1 and notification_id=$2 and state='unread'
          and state_revision=$3 returning *`, [
        input.recipientAccountId, input.notificationId, input.expectedStateRevision.toString(),
      ]);
      return result.rows[0] ? mapNotification(result.rows[0]) : null;
    },

    async transitionDelivery(
      input: NotificationDeliveryStateCas,
    ): Promise<NotificationDeliveryRecord | null> {
      assertText(input.recipientAccountId, 'recipientAccountId', MAX_IDENTITY);
      assertText(input.deliveryId, 'deliveryId', 128);
      assertRevision(input.expectedStateRevision);
      const states = ['pending', 'leased', 'retryable', 'delivered', 'suppressed', 'dead_letter'];
      const nextStates: readonly string[] = [
        'leased', 'retryable', 'delivered', 'suppressed', 'dead_letter',
      ];
      if (!states.includes(input.expectedState) || !nextStates.includes(input.nextState)) {
        throw new TypeError('Notification delivery state is invalid');
      }
      const errorCategories = ['unknown_future_version', 'invalid_contract', 'retry_exhausted',
        'dependency', 'provider_unavailable', 'other'];
      if (input.errorCategory !== undefined && !errorCategories.includes(input.errorCategory)) {
        throw new TypeError('Notification delivery error category is invalid');
      }
      const result = await pool.query<DeliveryRow>(`update notification_deliveries
        set state=$5,
            attempt_count=case when $5='leased' then attempt_count+1 else attempt_count end,
            leased_until=case when $5='leased' then current_timestamp+interval '5 minutes' else null end,
            delivered_at=case when $5='delivered' then current_timestamp else null end,
            suppressed_at=case when $5='suppressed' then current_timestamp else null end,
            dead_lettered_at=case when $5='dead_letter' then current_timestamp else null end,
            next_attempt_at=case when $5='retryable' then current_timestamp else next_attempt_at end,
            last_error_category=case when $5='dead_letter'
              then coalesce($6::text,'retry_exhausted') else last_error_category end,
            state_revision=state_revision+1,updated_at=current_timestamp
        where recipient_account_id=$1 and delivery_id=$2 and state_revision=$3 and state=$4
          and (($4 in ('pending','retryable') and $5 in ('leased','suppressed'))
            or ($4='leased' and $5 in ('retryable','delivered','suppressed','dead_letter')))
        returning *`, [input.recipientAccountId, input.deliveryId,
        input.expectedStateRevision.toString(), input.expectedState, input.nextState,
        input.errorCategory ?? null]);
      return result.rows[0] ? mapDelivery(result.rows[0]) : null;
    },

    async purgeExpiredNotifications(
      input: PurgeExpiredNotificationsInput,
    ): Promise<PurgedNotifications> {
      if (!(input.cutoff instanceof Date) || !Number.isFinite(input.cutoff.getTime())) {
        throw new TypeError('Notification retention cutoff must be a finite Date');
      }
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
        throw new TypeError('Notification retention batch limit must be between 1 and 10000');
      }
      if (input.recipientAccountId !== undefined) {
        assertText(input.recipientAccountId, 'recipientAccountId', MAX_IDENTITY);
      }
      const result = await pool.query<{ notification_id: string }>(`with victims as (
          select notification_id from notifications
           where retain_until <= least($1::timestamptz,current_timestamp)
             and ((state='unread'
                 and occurred_at + interval '365 days' <= least($1::timestamptz,current_timestamp))
               or (state='read'
                 and least(occurred_at + interval '365 days', read_at + interval '90 days')
                   <= least($1::timestamptz,current_timestamp)))
             and ($3::text is null or recipient_account_id=$3)
           order by retain_until,notification_id for update skip locked limit $2
        )
        delete from notifications notification using victims
         where notification.notification_id=victims.notification_id
        returning notification.notification_id`, [input.cutoff, input.limit,
        input.recipientAccountId ?? null]);
      const notificationIds = Object.freeze(result.rows.map((row) => row.notification_id));
      return Object.freeze({ deletedCount: notificationIds.length, notificationIds });
    },

    async purgeExpiredDeliveries(input: PurgeExpiredDeliveriesInput): Promise<PurgedDeliveries> {
      if (!(input.cutoff instanceof Date) || !Number.isFinite(input.cutoff.getTime())) {
        throw new TypeError('Notification delivery retention cutoff must be a finite Date');
      }
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
        throw new TypeError('Notification delivery retention batch limit must be between 1 and 10000');
      }
      if (input.recipientAccountId !== undefined) {
        assertText(input.recipientAccountId, 'recipientAccountId', MAX_IDENTITY);
      }
      // Independent 30-day delivery-attempt purge: only RESOLVED terminal
      // rows (delivered/suppressed). Active rows (pending/leased/retryable)
      // belong to the worker and unresolved dead letters must stay for
      // operator replay, so neither is ever purged here.
      const result = await pool.query<{ delivery_id: string }>(`with victims as (
          select delivery_id from notification_deliveries
           where state in ('delivered','suppressed')
             and retain_until <= least($1::timestamptz,current_timestamp)
             and ($3::text is null or recipient_account_id=$3)
           order by retain_until,delivery_id for update skip locked limit $2
        )
        delete from notification_deliveries delivery using victims
         where delivery.delivery_id=victims.delivery_id
        returning delivery.delivery_id`, [input.cutoff, input.limit,
        input.recipientAccountId ?? null]);
      const deliveryIds = Object.freeze(result.rows.map((row) => row.delivery_id));
      return Object.freeze({ deletedCount: deliveryIds.length, deliveryIds });
    },
  });
}

function assertNotification(input: NotificationInput): void {
  assertText(input.notificationId, 'notificationId', 128);
  assertText(input.recipientAccountId, 'recipientAccountId', MAX_IDENTITY);
  assertText(input.sourceEventId, 'sourceEventId', 128);
  if (!['collection_change', 'follow_activity'].includes(input.notificationType)) {
    throw new TypeError('notificationType is not an MVP social type');
  }
  if (input.actorProfileId !== null) assertText(input.actorProfileId, 'actorProfileId', MAX_IDENTITY);
  if (!['collection', 'profile'].includes(input.subjectType)) {
    throw new TypeError('subjectType is invalid');
  }
  assertText(input.subjectId, 'subjectId', MAX_IDENTITY);
  if (!(input.occurredAt instanceof Date) || !Number.isFinite(input.occurredAt.getTime())) {
    throw new TypeError('occurredAt must be a finite Date');
  }
}

function assertDelivery(input: NotificationDeliveryInput): void {
  assertText(input.deliveryId, 'deliveryId', 128);
  assertText(input.notificationId, 'notificationId', 128);
  assertText(input.recipientAccountId, 'recipientAccountId', MAX_IDENTITY);
  if (input.channel !== 'email') throw new TypeError('Notification delivery channel is invalid');
}

function assertNotificationWinner(row: NotificationRow, input: NotificationInput): void {
  if (row.actor_profile_id !== input.actorProfileId || row.subject_type !== input.subjectType
      || row.subject_id !== input.subjectId
      || row.occurred_at.getTime() !== input.occurredAt.getTime()) {
    throw new Error('Notification recipient/event/type winner conflicts with immutable facts');
  }
}

function assertText(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
}

function assertRevision(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError('expectedStateRevision must be a non-negative bigint');
  }
}

function mapPreferences(inApp: PreferenceRow, email: PreferenceRow): NotificationPreferences {
  return Object.freeze({ recipientAccountId: inApp.recipient_account_id,
    inAppEnabled: inApp.enabled, emailEnabled: email.enabled,
    inAppStateRevision: BigInt(inApp.state_revision),
    emailStateRevision: BigInt(email.state_revision),
    inAppUpdatedAt: inApp.updated_at, emailUpdatedAt: email.updated_at });
}

function mapNotification(row: NotificationRow): NotificationRecord {
  return Object.freeze({ notificationId: row.notification_id,
    recipientAccountId: row.recipient_account_id, sourceEventId: row.source_event_id,
    notificationType: row.notification_type, actorProfileId: row.actor_profile_id,
    subjectType: row.subject_type, subjectId: row.subject_id, state: row.state,
    readAt: row.read_at, stateRevision: BigInt(row.state_revision),
    occurredAt: row.occurred_at, retainUntil: row.retain_until, createdAt: row.created_at });
}

function mapDelivery(row: DeliveryRow): NotificationDeliveryRecord {
  return Object.freeze({ deliveryId: row.delivery_id, notificationId: row.notification_id,
    recipientAccountId: row.recipient_account_id, channel: row.channel, state: row.state,
    attemptCount: row.attempt_count, stateRevision: BigInt(row.state_revision),
    nextAttemptAt: row.next_attempt_at, leasedUntil: row.leased_until,
    deliveredAt: row.delivered_at, suppressedAt: row.suppressed_at,
    deadLetteredAt: row.dead_lettered_at, providerMessageId: row.provider_message_id,
    createdAt: row.created_at, updatedAt: row.updated_at });
}

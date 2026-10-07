import type { Pool } from 'pg';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type NotificationAccountEvidence, type NotificationOperationsRepository,
  type NotificationOperationsStatus,
} from '../../modules/notifications/index.js';
import { SOCIAL_FEED_ITEM_NOTIFICATION_HANDLER,
  SOCIAL_FOLLOW_NOTIFICATION_HANDLER } from './social-notification-worker-route.js';

const HANDLERS = [SOCIAL_FOLLOW_NOTIFICATION_HANDLER,
  SOCIAL_FEED_ITEM_NOTIFICATION_HANDLER] as const;
// FIX-L-063: the account-scoped dead-letter replay also covers the Feed
// withdrawal handler. The withdrawal outbox row keeps its aggregate_scope on
// the follow TARGET (the envelope identity bound by the social_feed_withdrawal
// route), while the withdrawal actually updates the actor's Feed rows, so the
// replay resolves the affected recipient from the closed payload
// actorProfileId for this handler only; every other handler keeps its
// aggregate_scope=recipient semantics and no cross-account read is widened.
export const SOCIAL_FEED_WITHDRAWAL_HANDLER = 'social_feed_withdrawal' as const;
const DEAD_LETTER_REPLAY_HANDLERS = [...HANDLERS, SOCIAL_FEED_WITHDRAWAL_HANDLER] as const;

export function createPostgresNotificationOperationsRepository(
  pool: Pool,
): NotificationOperationsRepository {
  return Object.freeze({
    async inspectStatus(): Promise<NotificationOperationsStatus> {
      try {
        const [queue, queueErrors, lag, delivery] = await Promise.all([
          pool.query<{ state: string; count: string; oldest_ms: string }>(`select state,
            count(*)::text,coalesce(extract(epoch from (current_timestamp-min(case
              when state='dead_letter' then dead_lettered_at else available_at end)))*1000,
              0)::bigint::text oldest_ms from outbox_events
            where handler_name=any($1::text[]) and (state in ('pending','retryable','leased','dead_letter')
              or (state='completed' and completed_at >= current_timestamp-interval '2 minutes'))
            group by state`, [HANDLERS]),
          pool.query<ErrorCountRow>(`select
            count(*) filter (where category='unknown_future_version')::text unknown_future_version,
            count(*) filter (where category='invalid_contract')::text invalid_contract,
            count(*) filter (where category='retry_exhausted')::text retry_exhausted,
            count(*) filter (where category='dependency')::text dependency,
            count(*) filter (where category='provider_unavailable')::text provider_unavailable,
            count(*) filter (where category='other')::text other from (select case
              when last_error ilike '%unknown%version%' then 'unknown_future_version'
              when last_error ilike '%invalid%event%' then 'invalid_contract'
              when last_error ilike '%attempt%' or last_error ilike '%retry%' then 'retry_exhausted'
              when last_error ilike '%database%' or last_error ilike '%dependency%' then 'dependency'
              when last_error ilike '%provider%unavailable%' then 'provider_unavailable'
              else 'other' end category from outbox_events
              where handler_name=any($1::text[]) and state='dead_letter') classified`, [HANDLERS]),
          pool.query<{ source_count: string; processed_count: string; maximum_lag: string }>(`with scoped as (
            select aggregate_scope,count(*) source_count,
              count(*) filter (where state='completed') processed_count
            from outbox_events where handler_name=any($1::text[]) group by aggregate_scope)
            select coalesce(sum(source_count),0)::text source_count,
              coalesce(sum(processed_count),0)::text processed_count,
              coalesce(max(greatest(source_count-processed_count,0)),0)::text maximum_lag from scoped`,
          [HANDLERS]),
          pool.query<{ state: string; error_category: string | null; count: string; oldest_ms: string }>(`select state,
            last_error_category error_category,
            count(*)::text,coalesce(extract(epoch from (current_timestamp-min(case
              when state='dead_letter' then dead_lettered_at else created_at end)))*1000,
              0)::bigint::text oldest_ms from notification_deliveries group by state,last_error_category`),
        ]);
        const queueStates = new Map(queue.rows.map((row) => [row.state, row]));
        // last_error_category is meaningful ONLY for retryable/dead_letter rows
        // (claim/suppress/deliver clear it on every other state, m1): the error
        // tally must never count a stale category left on a suppressed (or
        // pending/leased/delivered) row, even for rows written before the m1 fix.
        const deliveryError = (category: string) => delivery.rows
          .filter((row) => (row.state === 'retryable' || row.state === 'dead_letter')
            && row.error_category === category)
          .reduce((sum, row) => sum + Number(row.count), 0);
        const count = (rows: Map<string, { count: string }>, state: string) =>
          Number(rows.get(state)?.count ?? 0);
        const age = (rows: Map<string, { oldest_ms: string }>, state: string) =>
          Math.max(0, Number(rows.get(state)?.oldest_ms ?? 0));
        const deliveryCount = (state: string) => delivery.rows.filter((row) => row.state === state)
          .reduce((sum, row) => sum + Number(row.count), 0);
        const deliveryAge = (state: string) => Math.max(0, ...delivery.rows
          .filter((row) => row.state === state).map((row) => Number(row.oldest_ms)));
        const active = count(queueStates, 'pending') + count(queueStates, 'retryable')
          + count(queueStates, 'dead_letter');
        const worker = count(queueStates, 'leased') > 0 || count(queueStates, 'completed') > 0
          ? 'running' : active === 0 ? 'idle' : 'stopped';
        const deadDeliveries = deliveryCount('dead_letter');
        const lagRow = lag.rows[0];
        return Object.freeze({ dependency: 'available', worker,
          readyCount: count(queueStates, 'pending'), retryCount: count(queueStates, 'retryable'),
          leasedCount: count(queueStates, 'leased'),
          deadLetterCount: count(queueStates, 'dead_letter'),
          oldestEligibleAgeMs: Math.max(age(queueStates, 'pending'), age(queueStates, 'retryable')),
          oldestDeadLetterAgeMs: age(queueStates, 'dead_letter'),
          sourceEventCount: lagRow?.source_count ?? '0',
          processedEventCount: lagRow?.processed_count ?? '0',
          maximumEventLag: lagRow?.maximum_lag ?? '0',
          queueErrors: mapErrors(queueErrors.rows[0]),
          delivery: Object.freeze({ pendingCount: deliveryCount('pending'),
            retryCount: deliveryCount('retryable'), leasedCount: deliveryCount('leased'),
            deliveredCount: deliveryCount('delivered'),
            suppressedCount: deliveryCount('suppressed'), deadLetterCount: deadDeliveries,
            oldestEligibleAgeMs: Math.max(deliveryAge('pending'), deliveryAge('retryable')),
            oldestDeadLetterAgeMs: deliveryAge('dead_letter'),
            errors: Object.freeze({ unknownFutureVersion: deliveryError('unknown_future_version'),
              invalidContract: deliveryError('invalid_contract'),
              retryExhausted: deliveryError('retry_exhausted'),
              dependency: deliveryError('dependency'),
              providerUnavailable: deliveryError('provider_unavailable'),
              other: deliveryError('other') + delivery.rows.filter((row) =>
                row.state === 'dead_letter' && row.error_category === null)
                .reduce((sum, row) => sum + Number(row.count), 0) }) }) });
      } catch {
        return unavailableStatus();
      }
    },

    async captureAccount(recipientAccountId: string): Promise<NotificationAccountEvidence> {
      assertAccount(recipientAccountId);
      const client = await pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const preferences = await client.query<PreferenceRow>(`select channel,enabled,state_revision::text,updated_at
            from notification_preferences where recipient_account_id=$1 order by channel`,
        [recipientAccountId]);
        const notifications = await client.query<NotificationRow>(`select notification_id,source_event_id,state,
            state_revision::text,read_at,retain_until from notifications
            where recipient_account_id=$1 order by notification_id`, [recipientAccountId]);
        const deliveries = await client.query<DeliveryRow>(`select delivery_id,notification_id,state,attempt_count,
            state_revision::text,next_attempt_at,leased_until,dead_lettered_at,last_error_category
            from notification_deliveries where recipient_account_id=$1 order by delivery_id`,
        [recipientAccountId]);
        await client.query('commit');
        return Object.freeze({ preferences: Object.freeze(preferences.rows.map((row) =>
          Object.freeze({ channel: row.channel, enabled: row.enabled,
            stateRevision: row.state_revision, updatedAt: row.updated_at }))),
        notifications: Object.freeze(notifications.rows.map((row) => Object.freeze({
          notificationId: row.notification_id, sourceEventId: row.source_event_id,
          state: row.state, stateRevision: row.state_revision, readAt: row.read_at,
          retainUntil: row.retain_until }))),
        deliveries: Object.freeze(deliveries.rows.map((row) => Object.freeze({
          deliveryId: row.delivery_id, notificationId: row.notification_id, state: row.state,
          attemptCount: row.attempt_count, stateRevision: row.state_revision,
          nextAttemptAt: row.next_attempt_at, leasedUntil: row.leased_until,
          deadLetteredAt: row.dead_lettered_at,
          errorCategory: row.last_error_category }))) });
      } catch (error: unknown) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Notification operations inspection');
        throw error;
      } finally { client.release(); }
    },

    async replayDeadLetters(input: { readonly recipientAccountId: string;
      readonly limit: number; readonly allowUnknownFutureVersion?: boolean }) {
      assertAccount(input.recipientAccountId);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new RangeError('Notification dead-letter replay limit must be between 1 and 1000');
      }
      const result = await pool.query<{ outbox_id: string }>(`with candidates as (
        select outbox_id from outbox_events where handler_name=any($1::text[])
          and state='dead_letter'
          and (
            (handler_name<>$4 and aggregate_scope=$2)
            or (handler_name=$4 and payload_json->>'actorProfileId'=$2)
          )
          and ($5::boolean or last_error not ilike '%unknown%version%')
          order by dead_lettered_at,outbox_id for update skip locked limit $3)
        update outbox_events event set state='retryable',available_at=current_timestamp,
          dead_lettered_at=null,locked_until=null from candidates
        where event.outbox_id=candidates.outbox_id and event.state='dead_letter'
        returning event.outbox_id`, [DEAD_LETTER_REPLAY_HANDLERS, input.recipientAccountId,
        input.limit, SOCIAL_FEED_WITHDRAWAL_HANDLER, input.allowUnknownFutureVersion === true]);
      const remaining = input.limit - result.rows.length;
      const deliveries = remaining > 0 ? await pool.query<{ delivery_id: string }>(`with candidates as (
        select delivery_id from notification_deliveries where recipient_account_id=$1
          and state='dead_letter'
          and ($3::boolean or last_error_category is distinct from 'unknown_future_version')
          order by dead_lettered_at,delivery_id for update skip locked limit $2)
        update notification_deliveries delivery set state='retryable',
          next_attempt_at=current_timestamp,dead_lettered_at=null,
          state_revision=state_revision+1,updated_at=current_timestamp
        from candidates where delivery.delivery_id=candidates.delivery_id
          and delivery.state='dead_letter' returning delivery.delivery_id`,
      [input.recipientAccountId, remaining, input.allowUnknownFutureVersion === true]) : { rows: [] };
      return Object.freeze({ outboxIds: Object.freeze(result.rows.map((row) => row.outbox_id)),
        deliveryIds: Object.freeze(deliveries.rows.map((row) => row.delivery_id)) });
    },

    async recoverMissingSources(input: { readonly recipientAccountId: string;
      readonly limit: number }) {
      assertAccount(input.recipientAccountId);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new RangeError('Notification recovery limit must be between 1 and 1000');
      }
      const result = await pool.query<{ outbox_id: string }>(`with candidates as (
        select event.outbox_id from outbox_events event
        where event.handler_name=any($1::text[]) and event.state='completed'
          and event.aggregate_scope=$2 and event.event_version=1
          and not exists (select 1 from notifications notification
            where notification.recipient_account_id=$2
              and notification.source_event_id=case
                when event.handler_name=$4 then event.domain_event_id
                else event.payload_json->>'sourceEventId' end
              and notification.notification_type=case
                when event.handler_name=$4 then 'follow_activity' else 'collection_change' end)
        order by event.completed_at,event.outbox_id for update skip locked limit $3)
        update outbox_events event set state='retryable',available_at=current_timestamp,
          locked_until=null from candidates where event.outbox_id=candidates.outbox_id
          and event.state='completed' returning event.outbox_id`,
      [HANDLERS, input.recipientAccountId, input.limit, SOCIAL_FOLLOW_NOTIFICATION_HANDLER]);
      return Object.freeze({ outboxIds: Object.freeze(result.rows.map((row) => row.outbox_id)) });
    },
  });
}

interface PreferenceRow { channel: 'email' | 'in_app'; enabled: boolean;
  state_revision: string; updated_at: Date }
interface NotificationRow { notification_id: string; source_event_id: string;
  state: 'read' | 'unread'; state_revision: string; read_at: Date | null; retain_until: Date }
interface DeliveryRow { delivery_id: string; notification_id: string; state: string;
  attempt_count: number; state_revision: string; next_attempt_at: Date;
  leased_until: Date | null; dead_lettered_at: Date | null; last_error_category: string | null }

function unavailableStatus(): NotificationOperationsStatus {
  return Object.freeze({ dependency: 'unavailable', worker: 'unknown', readyCount: 0,
    retryCount: 0, leasedCount: 0, deadLetterCount: 0, oldestEligibleAgeMs: 0,
    oldestDeadLetterAgeMs: 0, sourceEventCount: '0', processedEventCount: '0',
    maximumEventLag: '0', queueErrors: mapErrors(),
    delivery: Object.freeze({ pendingCount: 0, retryCount: 0,
      leasedCount: 0, deliveredCount: 0, suppressedCount: 0, deadLetterCount: 0,
      oldestEligibleAgeMs: 0, oldestDeadLetterAgeMs: 0,
      errors: Object.freeze({ unknownFutureVersion: 0, invalidContract: 0,
        retryExhausted: 0, dependency: 0, providerUnavailable: 0, other: 0 }) }) });
}
function assertAccount(value: string): void {
  if (value.length < 1 || value.length > SOCIAL_IDENTITY_MAX_LENGTH || value.trim() !== value) {
    throw new TypeError('Notification operations recipient account is invalid');
  }
}
interface ErrorCountRow { unknown_future_version: string; invalid_contract: string;
  retry_exhausted: string; dependency: string; provider_unavailable: string; other: string }
function mapErrors(row?: ErrorCountRow): NotificationOperationsStatus['queueErrors'] {
  return Object.freeze({ unknownFutureVersion: Number(row?.unknown_future_version ?? 0),
    invalidContract: Number(row?.invalid_contract ?? 0),
    retryExhausted: Number(row?.retry_exhausted ?? 0), dependency: Number(row?.dependency ?? 0),
    providerUnavailable: Number(row?.provider_unavailable ?? 0), other: Number(row?.other ?? 0) });
}

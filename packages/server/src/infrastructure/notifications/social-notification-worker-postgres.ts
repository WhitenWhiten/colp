import { fenceOutboxLease } from '../outbox/lease-fence.js';
import { cancelPostgresBackend } from '../database/postgres-cancellation.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { installTransactionCancellation } from '../database/transaction-cancellation.js';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import { collectionHidePublicControlSql } from '../governance/collection-control-sql.js';
import type {
  ProjectSocialNotificationInput,
  ProjectSocialNotificationResult,
  SocialFeedItemNotificationEvent,
  SocialFollowNotificationEvent,
  SocialNotificationWorkerRepository,
} from '../../modules/notifications/index.js';

interface EligibleNotification {
  readonly recipientAccountId: string;
  readonly sourceEventId: string;
  readonly notificationType: 'collection_change' | 'follow_activity';
  readonly actorProfileId: string;
  readonly subjectType: 'collection' | 'profile';
  readonly subjectId: string;
  readonly occurredAt: Date;
}

interface PreferenceRow { channel: 'in_app' | 'email'; enabled: boolean }

export interface SocialNotificationWorkerFaultInjector {
  afterAuthorityWrite?(): void | Promise<void>;
  beforeAttemptFence?(): void | Promise<void>;
}

export function createPostgresSocialNotificationWorkerRepository(
  pool: Pool,
  options: { readonly faultInjector?: SocialNotificationWorkerFaultInjector } = {},
): SocialNotificationWorkerRepository {
  return Object.freeze({
    async project(input: ProjectSocialNotificationInput): Promise<ProjectSocialNotificationResult> {
      const client = await pool.connect();
      let removeAbort: (() => Promise<void>) | undefined;
      try {
        await client.query('begin');
        const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]?.pid;
        if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0) {
          removeAbort = installTransactionCancellation(input.signal,
            () => cancelPostgresBackend(pool.options, pid));
          input.signal.throwIfAborted();
        }
        const result = await project(client, input, options.faultInjector);
        if (input.signal.aborted) throw input.signal.reason;
        await client.query('commit');
        return result;
      } catch (error: unknown) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Social notification projection');
        if (error instanceof LeaseFenceRollbackError) {
          return { disposition: 'lease_lost', notificationCreated: false,
            deliveryIntentCreated: false };
        }
        throw error;
      } finally {
        await removeAbort?.();
        client.release();
      }
    },
  });
}

async function project(client: PoolClient, input: ProjectSocialNotificationInput,
  faultInjector?: SocialNotificationWorkerFaultInjector): Promise<ProjectSocialNotificationResult> {
  input.signal.throwIfAborted();
  if (!await ownsAttempt(client, input)) throw new LeaseFenceRollbackError();
  const eligible = input.event.kind === 'feed_item_published'
    ? await readFeedAuthority(client, input.event)
    : await readFollowAuthority(client, input.event);
  if (!eligible) {
    await fenceAttempt(client, input, faultInjector);
    return { disposition: 'ineligible', notificationCreated: false,
      deliveryIntentCreated: false };
  }
  const preferences = await readPreferences(client, eligible.recipientAccountId);
  if (!preferences.inApp) {
    await fenceAttempt(client, input, faultInjector);
    return { disposition: 'preference_disabled', notificationCreated: false,
      deliveryIntentCreated: false };
  }

  input.signal.throwIfAborted();
  const notificationId = stableId('notification', eligible.recipientAccountId,
    eligible.sourceEventId, eligible.notificationType);
  const inserted = await client.query(`insert into notifications(notification_id,
      recipient_account_id,source_event_id,notification_type,actor_profile_id,
      subject_type,subject_id,occurred_at,retain_until)
    values($1,$2,$3,$4,$5,$6,$7,$8,$8::timestamptz + interval '365 days')
    on conflict(recipient_account_id,source_event_id,notification_type) do nothing`, [
    notificationId, eligible.recipientAccountId, eligible.sourceEventId,
    eligible.notificationType, eligible.actorProfileId, eligible.subjectType,
    eligible.subjectId, eligible.occurredAt,
  ]);
  let authorityNotificationId = notificationId;
  if (inserted.rowCount !== 1) {
    const winner = await client.query<{ notification_id: string; matches: boolean }>(`select
        notification_id,
        actor_profile_id=$4 and subject_type=$5 and subject_id=$6
          and occurred_at=$7::timestamptz as matches
      from notifications where recipient_account_id=$1 and source_event_id=$2
        and notification_type=$3`, [eligible.recipientAccountId, eligible.sourceEventId,
      eligible.notificationType, eligible.actorProfileId, eligible.subjectType,
      eligible.subjectId, eligible.occurredAt]);
    if (winner.rows[0]?.matches !== true) {
      throw new Error('social Notification deduplication winner conflicts with authority facts');
    }
    authorityNotificationId = winner.rows[0].notification_id;
  }

  let deliveryIntentCreated = false;
  if (preferences.email) {
    const deliveryId = stableId('notification-delivery', authorityNotificationId, 'email');
    const delivery = await client.query(`insert into notification_deliveries(delivery_id,
        notification_id,recipient_account_id,channel)
      values($1,$2,$3,'email') on conflict(notification_id,channel) do nothing`,
    [deliveryId, authorityNotificationId, eligible.recipientAccountId]);
    deliveryIntentCreated = delivery.rowCount === 1;
  }
  await faultInjector?.afterAuthorityWrite?.();
  await fenceAttempt(client, input, faultInjector);
  return { disposition: inserted.rowCount === 1 ? 'applied' : 'duplicate',
    notificationCreated: inserted.rowCount === 1, deliveryIntentCreated };
}

async function readFollowAuthority(client: PoolClient,
  event: SocialFollowNotificationEvent): Promise<EligibleNotification | null> {
  if (event.kind === 'follow_removed') return null;
  const result = await client.query<{ actor_profile_id: string; recipient_account_id: string }>(`
    select follow.actor_profile_id,follow.target_profile_id recipient_account_id
    from follows follow
    join accounts actor on actor.id=follow.actor_profile_id
    join profiles actor_profile on actor_profile.account_id=actor.id
    join accounts recipient on recipient.id=follow.target_profile_id
    join profiles recipient_profile on recipient_profile.account_id=recipient.id
    where follow.actor_profile_id=$1 and follow.target_profile_id=$2
      and date_trunc('milliseconds',follow.followed_at) <= $3
      and actor.status='active' and actor.deleted_at is null
      and recipient.status='active' and recipient.deleted_at is null
    for share of follow,actor,actor_profile,recipient,recipient_profile`,
  [event.actorProfileId, event.recipientProfileId, event.occurredAt]);
  const row = result.rows[0];
  return row ? { recipientAccountId: row.recipient_account_id, sourceEventId: event.eventId,
    notificationType: 'follow_activity', actorProfileId: row.actor_profile_id,
    subjectType: 'profile', subjectId: row.actor_profile_id, occurredAt: event.occurredAt } : null;
}

async function readFeedAuthority(client: PoolClient,
  event: SocialFeedItemNotificationEvent): Promise<EligibleNotification | null> {
  const result = await client.query<{ recipient_account_id: string; actor_profile_id: string;
    collection_id: string; published_at: Date }>(`
    select item.recipient_profile_id recipient_account_id,item.actor_profile_id,
      item.collection_id,item.published_at
    from social_feed_items item
    join accounts recipient on recipient.id=item.recipient_profile_id
    join profiles recipient_profile on recipient_profile.account_id=recipient.id
    join accounts actor on actor.id=item.actor_profile_id
    join profiles actor_profile on actor_profile.account_id=actor.id
    join collections collection on collection.id=item.collection_id
    join accounts owner on owner.subject_id=collection.owner_subject_id
    join profiles owner_profile on owner_profile.account_id=owner.id
    join follows follow on follow.actor_profile_id=item.recipient_profile_id
      and follow.target_profile_id=item.actor_profile_id
    where item.feed_item_id=$1 and item.recipient_profile_id=$2 and item.source_event_id=$3
      and item.collection_id=$4 and item.discoverability_recheck_key=$5 and item.state='visible'
      and follow.followed_at <= item.published_at
      and collection.deleted_at is null and collection.visibility='public'
      and collection.publication_slug is not null and collection.published_at is not null
      and ${collectionHidePublicControlSql('collection')}
      and owner.id=item.actor_profile_id
      and recipient.status='active' and recipient.deleted_at is null
      and actor.status='active' and actor.deleted_at is null
      and owner.status='active' and owner.deleted_at is null
    for share of item,recipient,recipient_profile,actor,actor_profile,
      collection,owner,owner_profile,follow`, [event.feedItemId,
    event.recipientProfileId, event.sourceEventId, event.collectionId,
    event.discoverabilityRecheckKey]);
  const row = result.rows[0];
  return row ? { recipientAccountId: row.recipient_account_id,
    sourceEventId: event.sourceEventId, notificationType: 'collection_change',
    actorProfileId: row.actor_profile_id, subjectType: 'collection',
    subjectId: row.collection_id, occurredAt: row.published_at } : null;
}

async function readPreferences(client: PoolClient, recipientAccountId: string):
Promise<{ inApp: boolean; email: boolean }> {
  await client.query(`insert into notification_preferences(recipient_account_id,channel,enabled)
    values($1,'in_app',true),($1,'email',false) on conflict do nothing`, [recipientAccountId]);
  const result = await client.query<PreferenceRow>(`select channel,enabled
    from notification_preferences where recipient_account_id=$1 for share`, [recipientAccountId]);
  const values = new Map(result.rows.map((row) => [row.channel, row.enabled]));
  if (!values.has('in_app') || !values.has('email')) {
    throw new Error('social Notification preferences are incomplete');
  }
  return { inApp: values.get('in_app')!, email: values.get('email')! };
}

async function ownsAttempt(client: PoolClient,
  input: ProjectSocialNotificationInput): Promise<boolean> {
  const expected = expectedRoute(input);
  const result = await client.query<{ owned: boolean }>(`select state='leased'
      and lease_generation=$2 and locked_until > clock_timestamp()
      and domain_event_id=$3 and event_type=$4 and event_version=$5
      and handler_name=$6 and handler_mode='delivery_each_event' as owned
    from outbox_events where outbox_id=$1`, [input.attempt.outboxId,
    input.attempt.leaseGeneration, input.event.eventId, expected.eventType,
    input.event.eventVersion, expected.handlerName]);
  return result.rows[0]?.owned === true;
}

async function fenceAttempt(client: PoolClient, input: ProjectSocialNotificationInput,
  faultInjector?: SocialNotificationWorkerFaultInjector): Promise<void> {
  input.signal.throwIfAborted();
  await faultInjector?.beforeAttemptFence?.();
  const owned = await fenceOutboxLease(
    (statement, parameters) => client.query(statement, parameters), input.attempt, input.signal);
  if (!owned) throw new LeaseFenceRollbackError();
}

function expectedRoute(input: ProjectSocialNotificationInput):
{ eventType: string; handlerName: string } {
  if (input.event.kind === 'feed_item_published') {
    return { eventType: 'social.feed-item-published', handlerName: 'social_feed_item_notification' };
  }
  return { eventType: input.event.kind === 'follow_created'
    ? 'social.follow-created' : 'social.follow-removed', handlerName: 'social_follow_activity' };
}

function stableId(namespace: string, ...parts: readonly string[]): string {
  return createHash('sha256').update([namespace, ...parts].join('\0'), 'utf8').digest('base64url');
}

class LeaseFenceRollbackError extends Error {}

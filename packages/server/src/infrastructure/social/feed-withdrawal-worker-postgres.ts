import { fenceOutboxLease } from '../outbox/lease-fence.js';
import type { Pool, PoolClient } from 'pg';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import type {
  ProjectSocialFeedWithdrawalInput,
  ProjectSocialFeedWithdrawalResult,
  SocialFeedWithdrawalWorkerRepository,
} from '../../modules/social/index.js';
import { SOCIAL_FEED_WITHDRAWAL_HANDLER } from './feed-withdrawal-worker-route.js';

export interface SocialFeedWithdrawalWorkerFaultInjector {
  afterWithdrawBeforeFence?(): void | Promise<void>;
  beforeAttemptFence?(): void | Promise<void>;
}

/** Canonical unfollow page: lock-safe SELECT … LIMIT then UPDATE the selected ids. */
export function unfollowWithdrawalUpdateSql(): string {
  return `with selected as (
      select feed_item_id
        from social_feed_items
       where published_at <= $3::timestamptz
         and state='visible'
         and (
           (recipient_profile_id=$1 and actor_profile_id=$2
             and kind='collection_change')
           or
           (recipient_profile_id=$2 and actor_profile_id=$1
             and kind='follow_activity')
         )
       order by published_at asc, feed_item_id asc
       for update skip locked
       limit $4
    )
    update social_feed_items item
       set state='withdrawn',
           withdrawn_at=current_timestamp,
           withdrawal_reason='unfollowed'
      from selected
     where item.feed_item_id=selected.feed_item_id`;
}

export function createPostgresSocialFeedWithdrawalWorkerRepository(
  pool: Pool,
  options: {
    readonly faultInjector?: SocialFeedWithdrawalWorkerFaultInjector;
    /** Test seam; production always passes `maxRecipients` on `project()` input. */
    readonly maxRecipients?: number;
  } = {},
): SocialFeedWithdrawalWorkerRepository {
  return Object.freeze({
    async project(
      input: ProjectSocialFeedWithdrawalInput,
    ): Promise<ProjectSocialFeedWithdrawalResult> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await project(client, input, options);
        await client.query('commit');
        return result;
      } catch (error: unknown) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Social feed withdrawal projection');
        if (error instanceof LeaseFenceRollbackError) {
          return { disposition: 'lease_lost', withdrawnCount: 0 };
        }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}

async function project(
  client: PoolClient,
  input: ProjectSocialFeedWithdrawalInput,
  options: {
    readonly faultInjector?: SocialFeedWithdrawalWorkerFaultInjector;
    readonly maxRecipients?: number;
  },
): Promise<ProjectSocialFeedWithdrawalResult> {
  input.signal.throwIfAborted();
  if (!await ownsAttempt(client, input)) throw new LeaseFenceRollbackError();

  const maxRecipients = options.maxRecipients ?? input.maxRecipients;
  const withdrawn = await client.query(unfollowWithdrawalUpdateSql(), [
    input.event.actorProfileId,
    input.event.targetProfileId,
    input.event.occurredAt,
    maxRecipients,
  ]);
  const withdrawnCount = withdrawn.rowCount ?? 0;
  await options.faultInjector?.afterWithdrawBeforeFence?.();
  await fenceAttempt(client, input, options.faultInjector);
  // Full page → continued (remaining visible rows are the cursor).
  // Partial/empty pages that still see committed visible matches also continue:
  // SKIP LOCKED can return 0 while a stale owner holds the last rows; completing
  // would ack the outbox and leave those rows visible after the stale rollback.
  if (withdrawnCount === maxRecipients) {
    return { disposition: 'continued', withdrawnCount };
  }
  if (await hasRemainingMatchingVisible(client, input)) {
    return { disposition: 'continued', withdrawnCount };
  }
  return {
    disposition: withdrawnCount > 0 ? 'applied' : 'duplicate',
    withdrawnCount,
  };
}

async function hasRemainingMatchingVisible(
  client: PoolClient,
  input: ProjectSocialFeedWithdrawalInput,
): Promise<boolean> {
  const remaining = await client.query<{ remaining: boolean }>(`
    select exists (
      select 1
        from social_feed_items
       where published_at <= $3::timestamptz
         and state='visible'
         and (
           (recipient_profile_id=$1 and actor_profile_id=$2
             and kind='collection_change')
           or
           (recipient_profile_id=$2 and actor_profile_id=$1
             and kind='follow_activity')
         )
    ) as remaining`, [
    input.event.actorProfileId,
    input.event.targetProfileId,
    input.event.occurredAt,
  ]);
  return remaining.rows[0]?.remaining === true;
}

async function ownsAttempt(
  client: PoolClient,
  input: ProjectSocialFeedWithdrawalInput,
): Promise<boolean> {
  const result = await client.query<{ owned: boolean }>(`
    select state='leased'
        and lease_generation=$2
        and locked_until > clock_timestamp()
        and domain_event_id=$3
        and event_type='social.follow-removed'
        and event_version=$4
        and handler_name=$5
        and handler_mode='delivery_each_event' as owned
      from outbox_events where outbox_id=$1`, [
    input.attempt.outboxId,
    input.attempt.leaseGeneration,
    input.event.eventId,
    input.event.eventVersion,
    SOCIAL_FEED_WITHDRAWAL_HANDLER,
  ]);
  return result.rows[0]?.owned === true;
}

async function fenceAttempt(
  client: PoolClient,
  input: ProjectSocialFeedWithdrawalInput,
  faultInjector?: SocialFeedWithdrawalWorkerFaultInjector,
): Promise<void> {
  input.signal.throwIfAborted();
  await faultInjector?.beforeAttemptFence?.();
  const owned = await fenceOutboxLease(
    (statement, parameters) => client.query(statement, parameters), input.attempt, input.signal);
  if (!owned) throw new LeaseFenceRollbackError();
}

class LeaseFenceRollbackError extends Error {}

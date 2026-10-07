import { fenceOutboxLease } from '../outbox/lease-fence.js';
import type { Pool, PoolClient } from 'pg';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import {
  type ProjectSocialCollectionChangeInput,
  type ProjectSocialCollectionChangeResult,
  type ProjectSocialFollowActivityInput,
  type ProjectSocialFollowActivityResult,
  type RebuildSocialFeedScopeInput,
  type RebuildSocialFeedScopeResult,
  type SocialCollectionChangeConsumerEvent,
  type SocialFollowActivityConsumerEvent,
  type SocialFeedWorkerRepository,
} from '../../modules/social/index.js';
import { OutboxDeliveryError } from '../outbox/router.js';
import {
  fanoutPageContinuationCursor,
  stableFeedItemId,
  stableIntentId,
} from './feed-fanout-contract.js';
import { buildFanoutRecipientPageStatement } from './feed-fanout-recipient-statement.js';

const HANDLER = 'social.publish-collection-change';

interface WatermarkRow {
  last_commit_ordinal: string;
  last_source_event_id: string | null;
  state_revision: string;
  projection_state: 'live' | 'rebuilding';
  rebuild_generation: string;
  rebuild_high_commit_ordinal: string | null;
  rebuild_high_source_event_id: string | null;
  rebuild_replayed_commit_ordinal: string | null;
  rebuild_started_at: Date | null;
  fanout_source_event_id: string | null;
  fanout_commit_ordinal: string | null;
  fanout_after_recipient_profile_id: string | null;
  fanout_candidate_count: string | null;
  fanout_started_at: Date | null;
}

interface AuthorityRow {
  owner_profile_id: string | null;
  discoverable: boolean;
}

interface RetainedEventRow {
  domain_event_id: string;
  event_version: number;
  aggregate_revision: string;
  commit_ordinal: string;
  occurred_at: Date;
  payload_json: Record<string, unknown>;
  state: string;
}

export function createPostgresSocialFeedWorkerRepository(
  pool: Pool,
  options: {
    readonly emitNotificationIntents?: boolean;
    readonly includeCollectionFollowers?: boolean;
  } = {},
): SocialFeedWorkerRepository {
  const emitNotificationIntents = options.emitNotificationIntents !== false;
  const includeCollectionFollowers = options.includeCollectionFollowers === true;
  return Object.freeze({
    async projectCollectionChange(
      input: ProjectSocialCollectionChangeInput,
    ): Promise<ProjectSocialCollectionChangeResult> {
      try {
        return await inTransaction(pool, (client) => project(
          client, input, emitNotificationIntents, includeCollectionFollowers,
        ), input);
      } catch (error: unknown) {
        if (error instanceof LeaseFenceRollbackError) {
          return { disposition: 'lease_lost', itemCount: 0 };
        }
        throw error;
      }
    },
    async projectFollowActivity(
      input: ProjectSocialFollowActivityInput,
    ): Promise<ProjectSocialFollowActivityResult> {
      try {
        return await inTransaction(pool, (client) => projectFollowActivity(client, input), input);
      } catch (error: unknown) {
        if (error instanceof LeaseFenceRollbackError) {
          return { disposition: 'lease_lost', itemCount: 0 };
        }
        throw error;
      }
    },
    rebuildCollectionScope(
      input: RebuildSocialFeedScopeInput,
    ): Promise<RebuildSocialFeedScopeResult> {
      return rebuild(pool, input, includeCollectionFollowers);
    },
  });
}

/**
 * Follow-created Feed projection: re-reads current Follow/Profile authority and writes one
 * stable per (event, recipient) item to the followed Profile owner. The recipient is the
 * followed Profile only, so the relationship never leaks to other principals.
 */
async function projectFollowActivity(
  client: PoolClient,
  input: ProjectSocialFollowActivityInput,
): Promise<ProjectSocialFollowActivityResult> {
  input.signal.throwIfAborted();
  if (!(await ownsFollowActivityLease(client, input))) {
    return { disposition: 'lease_lost', itemCount: 0 };
  }
  const recipientProfileId = input.event.targetProfileId;
  const authority = await readFollowActivityAuthority(client, input.event);
  if (!authority.ok) {
    return { disposition: 'ineligible', itemCount: 0 };
  }
  input.signal.throwIfAborted();
  const feedItemId = stableFeedItemId(input.event.eventId, recipientProfileId);
  const inserted = await client.query(`insert into social_feed_items(
      feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,collection_id,
      source_event_version,source_commit_ordinal,publication_revision,
      discoverability_recheck_key,published_at,retain_until)
    values($1,$2,'follow_activity',$3,$4,null,1,0,null,
           'follow:' || $4 || ':' || $3,$5,$5::timestamptz + interval '90 days')
    on conflict (source_event_id,recipient_profile_id) do nothing
    returning feed_item_id`, [
    feedItemId, input.event.eventId, recipientProfileId, input.event.actorProfileId,
    input.event.occurredAt,
  ]);
  if (inserted.rowCount === 1) return { disposition: 'applied', itemCount: 1 };
  return { disposition: 'duplicate', itemCount: 0 };
}

interface FollowActivityAuthorityRow {
  readonly ok: boolean;
}

async function readFollowActivityAuthority(
  client: PoolClient,
  event: SocialFollowActivityConsumerEvent,
): Promise<FollowActivityAuthorityRow> {
  const row = await client.query<FollowActivityAuthorityRow>(`select exists (
      select 1
        from follows follow
        join profiles actor_profile on actor_profile.account_id=follow.actor_profile_id
        join accounts actor_account on actor_account.id=actor_profile.account_id
          and actor_account.status='active' and actor_account.deleted_at is null
        join profiles recipient_profile on recipient_profile.account_id=follow.target_profile_id
        join accounts recipient_account on recipient_account.id=recipient_profile.account_id
          and recipient_account.status='active' and recipient_account.deleted_at is null
       where follow.actor_profile_id=$1
         and follow.target_profile_id=$2
         and date_trunc('milliseconds', follow.followed_at) <= $3::timestamptz
    ) ok`,
  [event.actorProfileId, event.targetProfileId, event.occurredAt]);
  return row.rows[0] ?? { ok: false };
}

async function ownsFollowActivityLease(
  client: PoolClient,
  input: ProjectSocialFollowActivityInput,
): Promise<boolean> {
  const lease = await client.query<{ owned: boolean }>(`select
      state='leased' and lease_generation=$2 and locked_until > current_timestamp
        and domain_event_id=$3 and event_type='social.follow-created'
        and event_version=$4 and handler_name='social_feed_follow_activity'
        and handler_mode='delivery_each_event'
        and aggregate_scope=$5 and commit_ordinal is null as owned
    from outbox_events where outbox_id=$1`,
  [input.attempt.outboxId, input.attempt.leaseGeneration, input.event.eventId,
    input.event.eventVersion, input.event.targetProfileId]);
  return lease.rows[0]?.owned === true;
}

async function project(
  client: PoolClient,
  input: ProjectSocialCollectionChangeInput,
  emitNotificationIntents: boolean,
  includeCollectionFollowers: boolean,
): Promise<ProjectSocialCollectionChangeResult> {
  input.signal.throwIfAborted();
  if (!(await ownsLiveLease(client, input))) {
    return { disposition: 'lease_lost', itemCount: 0 };
  }

  const watermark = await lockWatermark(client, input.event.collectionId);
  if (BigInt(watermark.last_commit_ordinal) >= BigInt(input.event.commitOrdinal)) {
    if (watermark.fanout_source_event_id === input.event.eventId) {
      await clearFanoutTuple(client, input, watermark.state_revision);
    }
    return { disposition: 'obsolete', itemCount: 0 };
  }

  // A newer in-progress fan-out supersedes this older event.
  if (watermark.fanout_commit_ordinal !== null
      && BigInt(watermark.fanout_commit_ordinal) > BigInt(input.event.commitOrdinal)) {
    return { disposition: 'obsolete', itemCount: 0 };
  }

  let stateRevision = watermark.state_revision;
  let afterRecipient = watermark.fanout_after_recipient_profile_id;
  if (watermark.fanout_source_event_id !== null
      && watermark.fanout_source_event_id !== input.event.eventId) {
    // Abandon a stale lower-ordinal fan-out tuple before starting this event.
    stateRevision = await clearFanoutTuple(client, input, stateRevision);
    afterRecipient = null;
  } else if (watermark.fanout_source_event_id === input.event.eventId) {
    afterRecipient = watermark.fanout_after_recipient_profile_id;
  } else {
    afterRecipient = null;
  }

  // Every slice re-reads lease, Follow event-time, Profile and Collection authority.
  if (!(await ownsLiveLease(client, input))) {
    return { disposition: 'lease_lost', itemCount: 0 };
  }
  const authority = await readAuthority(client, input.event.collectionId);
  const publicNow = authority?.discoverable === true
    && authority.owner_profile_id === input.event.ownerProfileId;
  const shouldPublish = publicNow && input.event.producerDiscoverability !== 'remove';
  const reason = input.event.producerDiscoverability === 'remove'
    ? 'source_removed' : publicNow ? 'unfollowed' : 'discoverability_revoked';

  if (!shouldPublish) {
    const withdrawnCount = await withdrawVisiblePage(
      client, input.event, reason, input.maxRecipients,
    );
    if (withdrawnCount === input.maxRecipients) {
      input.signal.throwIfAborted();
      await saveFanoutContinuation(client, input, stateRevision, afterRecipient, 0);
      return { disposition: 'continued', itemCount: 0 };
    }
    input.signal.throwIfAborted();
    await finishLiveFanout(client, input, stateRevision);
    return { disposition: 'applied', itemCount: 0 };
  }

  input.signal.throwIfAborted();
  const candidates = await readRecipients(
    client, input.event, input.maxRecipients + 1, afterRecipient,
    includeCollectionFollowers,
  );
  const page = candidates.slice(0, input.maxRecipients);
  const itemCount = await insertItemsBatch(
    client, input.event, page, emitNotificationIntents, input.signal,
  );

  const hasMore = candidates.length > input.maxRecipients;
  if (hasMore) {
    const cursor = fanoutPageContinuationCursor(page);
    if (cursor === null) {
      throw new OutboxDeliveryError('retryable', 'social Feed fan-out page cursor is missing');
    }
    input.signal.throwIfAborted();
    await saveFanoutContinuation(client, input, stateRevision, cursor, page.length);
    return { disposition: 'continued', itemCount };
  }

  input.signal.throwIfAborted();
  await finishLiveFanout(client, input, stateRevision);
  return { disposition: 'applied', itemCount };
}

async function ownsLiveLease(
  client: PoolClient,
  input: ProjectSocialCollectionChangeInput,
): Promise<boolean> {
  const lease = await client.query<{ owned: boolean }>(`select
      state='leased' and lease_generation=$2 and locked_until > current_timestamp
        and domain_event_id=$3 and event_type='social.collection-change'
        and event_version=$4 and handler_name='social.publish-collection-change'
        and aggregate_scope=$5 and commit_ordinal=$6 as owned
    from outbox_events where outbox_id=$1`,
  [input.attempt.outboxId, input.attempt.leaseGeneration, input.event.eventId,
    input.event.eventVersion, input.event.collectionId, input.event.commitOrdinal]);
  return lease.rows[0]?.owned === true;
}

async function clearFanoutTuple(
  client: PoolClient,
  input: ProjectSocialCollectionChangeInput,
  stateRevision: string,
): Promise<string> {
  const cleared = await client.query<{ state_revision: string }>(`
    update social_feed_watermarks
       set fanout_source_event_id=null, fanout_commit_ordinal=null,
           fanout_after_recipient_profile_id=null, fanout_candidate_count=null,
           fanout_started_at=null, state_revision=state_revision+1,
           state_updated_at=current_timestamp
     where aggregate_scope=$1 and state_revision=$2
     returning state_revision::text`,
  [input.event.collectionId, stateRevision]);
  if (!cleared.rows[0]) throw new LeaseFenceRollbackError();
  return cleared.rows[0].state_revision;
}

async function saveFanoutContinuation(
  client: PoolClient,
  input: ProjectSocialCollectionChangeInput,
  stateRevision: string,
  afterRecipient: string | null,
  pageCandidateCount: number,
): Promise<void> {
  const saved = await client.query(`
    update social_feed_watermarks watermark
       set fanout_source_event_id=$3,
           fanout_commit_ordinal=$4,
           fanout_after_recipient_profile_id=$5,
           fanout_candidate_count=coalesce(fanout_candidate_count, 0) + $6,
           fanout_started_at=coalesce(fanout_started_at, current_timestamp),
           state_revision=state_revision+1,
           state_updated_at=current_timestamp
     where aggregate_scope=$1 and state_revision=$2
       and last_commit_ordinal < $4
       and (fanout_source_event_id is null or fanout_source_event_id=$3)
       and exists (
         select 1 from outbox_events event
          where event.outbox_id=$7
            and event.state='leased'
            and event.lease_generation=$8
            and event.locked_until > current_timestamp
       )`, [
    input.event.collectionId, stateRevision, input.event.eventId, input.event.commitOrdinal,
    afterRecipient, pageCandidateCount, input.attempt.outboxId, input.attempt.leaseGeneration,
  ]);
  if (saved.rowCount !== 1) throw new LeaseFenceRollbackError();
}

async function finishLiveFanout(
  client: PoolClient,
  input: ProjectSocialCollectionChangeInput,
  stateRevision: string,
): Promise<void> {
  const advanced = await client.query(`
    update social_feed_watermarks watermark
       set last_commit_ordinal=$3,
           last_source_event_id=$4,
           fanout_source_event_id=null,
           fanout_commit_ordinal=null,
           fanout_after_recipient_profile_id=null,
           fanout_candidate_count=null,
           fanout_started_at=null,
           state_revision=state_revision+1,
           state_updated_at=current_timestamp
     where aggregate_scope=$1 and state_revision=$2 and last_commit_ordinal < $3
       and exists (
         select 1 from outbox_events event
          where event.outbox_id=$5
            and event.state='leased'
            and event.lease_generation=$6
            and event.locked_until > current_timestamp
       )`, [
    input.event.collectionId, stateRevision, input.event.commitOrdinal,
    input.event.eventId, input.attempt.outboxId, input.attempt.leaseGeneration,
  ]);
  if (advanced.rowCount !== 1) throw new LeaseFenceRollbackError();
}

interface RetainedRangeRow {
  lo: string;
  hi: string;
  high_domain_event_id: string | null;
  cnt: string;
}

interface RetentionFloorRow {
  floor_commit_ordinal: string;
  floor_domain_event_id: string | null;
}

/**
 * Paged rebuild (FIX-M-027): maxEvents is a single-batch page size, never a scope total.
 *
 * The captured continuation is (scope, captured high, next ordinal, generation), stored in the
 * watermark; each committed page advances the next-ordinal cursor so an interrupted rebuild
 * resumes where it stopped instead of restarting. New events after the captured high are applied
 * by the live path (dual-apply) and never move the captured high. The source is trusted to be
 * ordinal-dense for this handler (one completed row per collection commit ordinal). Physical
 * holes are authorized only through the durable monotonic retention floor; any hole above that
 * floor is a source gap and fails closed.
 */
async function rebuild(
  pool: Pool,
  input: RebuildSocialFeedScopeInput,
  includeCollectionFollowers: boolean,
): Promise<RebuildSocialFeedScopeResult> {
  const client = await pool.connect();
  let lockHeld = false;
  let releaseError: Error | undefined;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_lock(hashtextextended($1,511)) acquired', [input.aggregateScope],
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new OutboxDeliveryError('retryable', 'social Feed rebuild scope is already leased');
    }
    lockHeld = true;
    input.signal?.throwIfAborted();

    // Phase 1: capture a fresh continuation or resume the durable one. Only a fresh capture
    // deletes the scope-wide items: resumed pages must keep the items earlier committed pages
    // already inserted (their ordinals are behind the durable next-ordinal cursor).
    await client.query('begin');
    input.signal?.throwIfAborted();
    const watermark = await lockWatermark(client, input.aggregateScope);
    let generation = BigInt(watermark.rebuild_generation);
    let high: bigint;
    let replayed: bigint;
    let highSourceEventId: string | null;
    if (watermark.projection_state === 'live') {
      const range = await retainedRange(client, input.aggregateScope);
      const floorPosition = await readRetentionFloor(client, input.aggregateScope);
      const floor = BigInt(floorPosition.floor_commit_ordinal);
      const last = BigInt(watermark.last_commit_ordinal);
      if (range.cnt === '0') {
        // Nothing retained inside the window: keep the live watermark as a no-op rebuild.
        high = maxOrdinal(last, floor);
        replayed = high;
        highSourceEventId = floor >= last && floor > 0n
          ? floorPosition.floor_domain_event_id
          : watermark.last_source_event_id;
        if (floor > 0n && last > floor) {
          await assertRetainedDense(client, input.aggregateScope, floor, last, floor);
          await assertResolvedSource(client, input.aggregateScope, floor, last);
        }
      } else {
        const lo = BigInt(range.lo);
        const hi = BigInt(range.hi);
        high = maxOrdinal(maxOrdinal(hi, last), floor);
        highSourceEventId = floor >= hi && floor >= last
          ? floorPosition.floor_domain_event_id
          : hi >= last ? range.high_domain_event_id : watermark.last_source_event_id;
        // A physical prefix may be absent only after its durable floor has passed it.
        replayed = maxOrdinal(lo - 1n, minOrdinal(floor, high));
        const densityStart = floor > 0n ? floor : replayed;
        const densityHigh = floor > 0n ? high : hi;
        await assertRetainedDense(client, input.aggregateScope, densityStart, densityHigh, floor);
        if (floor > 0n) {
          await assertResolvedSource(client, input.aggregateScope, floor, high);
        }
      }
      await client.query(`delete from social_feed_items
        where collection_id=$1 and source_commit_ordinal <= $2`, [input.aggregateScope, high]);
      const begun = await client.query<{ rebuild_generation: string }>(`
        update social_feed_watermarks set projection_state='rebuilding',
          rebuild_generation=rebuild_generation+1,rebuild_high_commit_ordinal=$3,
          rebuild_replayed_commit_ordinal=$4,rebuild_high_source_event_id=$5,
          rebuild_started_at=current_timestamp,
          state_revision=state_revision+1,state_updated_at=current_timestamp,
          fanout_source_event_id=null,fanout_commit_ordinal=null,
          fanout_after_recipient_profile_id=null,fanout_candidate_count=null,
          fanout_started_at=null
        where aggregate_scope=$1 and state_revision=$2 and projection_state='live'
        returning rebuild_generation::text`, [input.aggregateScope, watermark.state_revision,
        high, replayed, highSourceEventId]);
      if (!begun.rows[0]) {
        throw new OutboxDeliveryError('retryable', 'social Feed rebuild capture CAS failed');
      }
      generation = BigInt(begun.rows[0]!.rebuild_generation);
    } else {
      high = BigInt(watermark.rebuild_high_commit_ordinal!);
      replayed = BigInt(watermark.rebuild_replayed_commit_ordinal!);
      highSourceEventId = watermark.rebuild_high_source_event_id;
    }
    await client.query('commit');

    // Phase 2: replay one durable page at a time. Each page transaction loads, verifies and
    // replays a bounded slice, then advances the next-ordinal cursor; a crash between pages
    // only re-runs the uncommitted page, and inserts are idempotent (on conflict do nothing).
    const authority = await readAuthority(client, input.aggregateScope);
    let eventCount = 0;
    let itemCount = 0;
    while (true) {
      input.signal?.throwIfAborted();
      if (replayed >= high) break;
      await client.query('begin');
      input.signal?.throwIfAborted();
      // Retention may advance while a rebuild is paused. Move the durable replay cursor over the
      // newly authorized prefix before checking density or loading a page.
      const floor = BigInt((await readRetentionFloor(client, input.aggregateScope))
        .floor_commit_ordinal);
      const floorReplayed = minOrdinal(floor, high);
      if (floorReplayed > replayed) {
        const skipped = await client.query(`update social_feed_watermarks set
            rebuild_replayed_commit_ordinal=$3,state_revision=state_revision+1,
            state_updated_at=current_timestamp
          where aggregate_scope=$1 and projection_state='rebuilding'
            and rebuild_generation=$2 and rebuild_high_commit_ordinal=$4
            and rebuild_replayed_commit_ordinal < $3`,
        [input.aggregateScope, generation, floorReplayed, high]);
        if (skipped.rowCount !== 1) {
          throw new OutboxDeliveryError('retryable', 'social Feed rebuild floor CAS failed');
        }
        replayed = floorReplayed;
      }
      if (replayed >= high) {
        await client.query('commit');
        continue;
      }
      const page = await loadRetainedPage(client, input.aggregateScope, replayed, high,
        input.maxEvents + 1);
      if (page.length === 0) {
        // No retained rows remain below the captured high. Either every remaining row aged out
        // of the 90-day window (their items expired; completing is consistent with the windowed
        // contract) or source rows were deleted (a gap that must fail closed).
        if (!(await retainedDense(client, input.aggregateScope, replayed, high, floor))) {
          throw rebuildGapError(input.aggregateScope, high, replayed);
        }
        const completed = await client.query(`update social_feed_watermarks set
            rebuild_replayed_commit_ordinal=$3,state_revision=state_revision+1,
            state_updated_at=current_timestamp
          where aggregate_scope=$1 and projection_state='rebuilding'
            and rebuild_generation=$2 and rebuild_high_commit_ordinal=$3
            and rebuild_replayed_commit_ordinal < $3`,
        [input.aggregateScope, generation, high]);
        if (completed.rowCount !== 1) {
          throw new OutboxDeliveryError('retryable', 'social Feed rebuild replay CAS failed');
        }
        replayed = high;
        await client.query('commit');
        continue;
      }
      const firstRow = BigInt(page[0]!.commit_ordinal);
      if (firstRow > replayed + 1n
          && !(await retainedDense(client, input.aggregateScope, replayed, firstRow, floor))) {
        throw rebuildGapError(input.aggregateScope, high, replayed);
      }
      if (page.some((row) => row.state !== 'completed')) {
        throw new OutboxDeliveryError('retryable', 'social Feed retained source row is unresolved');
      }
      const replayable = page.length > input.maxEvents ? page.slice(0, input.maxEvents) : page;
      // FIX-M-027: the recipient budget is a hard bound per page (batch), never a scope total;
      // each page resets its own counter so large scopes stay rebuildable across pages.
      let pageItemCount = 0;
      for (const row of replayable) {
        input.signal?.throwIfAborted();
        const event = retainedEvent(row, input.aggregateScope);
        if (authority?.discoverable !== true || authority.owner_profile_id !== event.ownerProfileId
            || event.producerDiscoverability === 'remove') continue;
        pageItemCount += await insertRecipientPages(client, event, input.maxRecipients,
          input.signal, false, input.maxTotalRecipients === undefined
            ? undefined : input.maxTotalRecipients - pageItemCount,
          includeCollectionFollowers);
      }
      itemCount += pageItemCount;
      const nextReplayed = BigInt(replayable.at(-1)!.commit_ordinal);
      const advanced = await client.query(`update social_feed_watermarks set
          rebuild_replayed_commit_ordinal=$3,state_revision=state_revision+1,
          state_updated_at=current_timestamp
        where aggregate_scope=$1 and projection_state='rebuilding'
          and rebuild_generation=$2 and rebuild_high_commit_ordinal=$4
          and rebuild_replayed_commit_ordinal < $3`,
      [input.aggregateScope, generation, nextReplayed, high]);
      if (advanced.rowCount !== 1) {
        throw new OutboxDeliveryError('retryable', 'social Feed rebuild replay CAS failed');
      }
      eventCount += replayable.length;
      replayed = nextReplayed;
      await client.query('commit');
    }

    // Phase 3: atomic cutover once the captured high is fully replayed. Live dual-apply may
    // have advanced the watermark beyond the captured high; greatest() keeps that tail.
    await client.query('begin');
    input.signal?.throwIfAborted();
    const cutover = await client.query(`update social_feed_watermarks set
        last_commit_ordinal=greatest(last_commit_ordinal,$3::bigint),
        last_source_event_id=case when last_commit_ordinal <= $3
          then coalesce($4,last_source_event_id) else last_source_event_id end,
        projection_state='live',rebuild_high_commit_ordinal=null,rebuild_high_source_event_id=null,
        rebuild_replayed_commit_ordinal=null,rebuild_started_at=null,
        state_revision=state_revision+1,state_updated_at=current_timestamp,
        fanout_source_event_id=null,fanout_commit_ordinal=null,
        fanout_after_recipient_profile_id=null,fanout_candidate_count=null,
        fanout_started_at=null
      where aggregate_scope=$1 and projection_state='rebuilding'
        and rebuild_generation=$2 and rebuild_high_commit_ordinal=$3
        and rebuild_replayed_commit_ordinal >= rebuild_high_commit_ordinal`,
    [input.aggregateScope, generation, high, highSourceEventId]);
    if (cutover.rowCount !== 1) {
      throw new OutboxDeliveryError('retryable', 'social Feed rebuild cutover CAS failed');
    }
    await client.query('commit');
    return { eventCount, itemCount, highCommitOrdinal: high.toString() };
  } catch (error: unknown) {
    await rollbackTransaction(error, () => client.query('rollback'), 'Social feed rebuild');
    throw error;
  } finally {
    if (lockHeld) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'select pg_advisory_unlock(hashtextextended($1,511)) unlocked',
          [input.aggregateScope],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          releaseError = new Error('Failed to release social Feed rebuild advisory lock');
        }
      } catch (error: unknown) {
        releaseError = error instanceof Error
          ? error
          : new Error('Failed to release social Feed rebuild advisory lock');
      }
    }
    // Passing the unlock failure to pg evicts the session instead of returning a
    // possibly lock-holding connection to the pool. The rebuild result/error stays
    // authoritative because closing the session releases the advisory lock server-side.
    client.release(releaseError);
  }
}

function rebuildGapError(scope: string, high: bigint, replayed: bigint): OutboxDeliveryError {
  return new OutboxDeliveryError('permanent',
    `social Feed rebuild source gap: scope ${scope} captured high ${high} is not replayable from ordinal ${replayed}`);
}

async function retainedRange(client: PoolClient, scope: string): Promise<RetainedRangeRow> {
  const counted = await client.query<RetainedRangeRow>(`select
      coalesce(min(source.commit_ordinal),0)::bigint as lo,
      coalesce(max(source.commit_ordinal),0)::bigint as hi,
      count(*)::bigint as cnt,
      (select high.domain_event_id from outbox_events high
        where high.handler_name=$1 and high.event_type='social.collection-change'
          and high.aggregate_scope=$2 and high.commit_ordinal > 0
          and high.occurred_at >= current_timestamp - interval '90 days'
        order by high.commit_ordinal desc,high.domain_event_id desc limit 1)
        as high_domain_event_id
    from outbox_events source where source.handler_name=$1
      and source.event_type='social.collection-change'
      and source.aggregate_scope=$2 and source.commit_ordinal > 0
      and source.occurred_at >= current_timestamp - interval '90 days'`,
  [HANDLER, scope]);
  return counted.rows[0]!;
}

/**
 * Ordinal-density check over an exclusive/inclusive range without the 90-day filter. Only the
 * durable retention floor authorizes missing physical rows; a shortfall above it proves a source
 * gap. The check counts DISTINCT ordinals: a
 * duplicate ordinal (late/duplicate event re-enqueued with the same commit ordinal, per the
 * R5-04 corner contract) is not a gap, only a missing ordinal is.
 */
async function retainedDense(
  client: PoolClient,
  scope: string,
  fromExclusive: bigint,
  toInclusive: bigint,
  floor: bigint,
): Promise<boolean> {
  const requiredFrom = maxOrdinal(fromExclusive, floor);
  if (requiredFrom >= toInclusive) return true;
  const counted = await client.query<{ cnt: string }>(`select count(distinct commit_ordinal)::bigint as cnt
    from outbox_events where handler_name=$1 and event_type='social.collection-change'
      and aggregate_scope=$2 and commit_ordinal > $3 and commit_ordinal <= $4`,
  [HANDLER, scope, requiredFrom, toInclusive]);
  return BigInt(counted.rows[0]!.cnt) === toInclusive - requiredFrom;
}

async function assertRetainedDense(
  client: PoolClient,
  scope: string,
  fromExclusive: bigint,
  toInclusive: bigint,
  floor: bigint,
): Promise<void> {
  if (!(await retainedDense(client, scope, fromExclusive, toInclusive, floor))) {
    throw rebuildGapError(scope, toInclusive, fromExclusive);
  }
}

async function assertResolvedSource(
  client: PoolClient,
  scope: string,
  fromExclusive: bigint,
  toInclusive: bigint,
): Promise<void> {
  if (fromExclusive >= toInclusive) return;
  const unresolved = await client.query(`select 1 from outbox_events
    where handler_name=$1 and event_type='social.collection-change'
      and aggregate_scope=$2 and commit_ordinal > $3 and commit_ordinal <= $4
      and state <> 'completed' limit 1`, [HANDLER, scope, fromExclusive, toInclusive]);
  if (unresolved.rows[0]) {
    throw new OutboxDeliveryError('retryable', 'social Feed retained source row is unresolved');
  }
}

async function loadRetainedPage(
  client: PoolClient,
  scope: string,
  fromExclusive: bigint,
  toInclusive: bigint,
  limit: number,
): Promise<readonly RetainedEventRow[]> {
  const retained = await client.query<RetainedEventRow>(`select domain_event_id,event_version,
      aggregate_revision,commit_ordinal::text,occurred_at,payload_json,state
    from outbox_events where handler_name=$1 and event_type='social.collection-change'
      and aggregate_scope=$2 and commit_ordinal > $3 and commit_ordinal <= $4
      and occurred_at >= current_timestamp - interval '90 days'
    order by outbox_events.commit_ordinal,domain_event_id limit $5`,
  [HANDLER, scope, fromExclusive, toInclusive, limit]);
  return retained.rows;
}

async function lockWatermark(client: PoolClient, scope: string): Promise<WatermarkRow> {
  await client.query(`insert into social_feed_watermarks(aggregate_scope) values($1)
    on conflict (aggregate_scope) do nothing`, [scope]);
  const row = await client.query<WatermarkRow>(`select last_commit_ordinal::text,
    last_source_event_id,state_revision::text,projection_state,rebuild_generation::text,
    rebuild_high_commit_ordinal::text,rebuild_high_source_event_id,
    rebuild_replayed_commit_ordinal::text,
    rebuild_started_at,fanout_source_event_id,fanout_commit_ordinal::text,
    fanout_after_recipient_profile_id,fanout_candidate_count::text,fanout_started_at
    from social_feed_watermarks where aggregate_scope=$1 for update`, [scope]);
  if (!row.rows[0]) throw new Error('social Feed watermark lock failed');
  return row.rows[0];
}

async function readRetentionFloor(client: PoolClient, scope: string): Promise<RetentionFloorRow> {
  const row = await client.query<RetentionFloorRow>(`select
      floor_commit_ordinal::text,floor_domain_event_id from outbox_retention_floors
    where handler_name=$1 and event_type='social.collection-change' and aggregate_scope=$2`,
  [HANDLER, scope]);
  return row.rows[0] ?? { floor_commit_ordinal: '0', floor_domain_event_id: null };
}

function minOrdinal(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxOrdinal(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

async function readAuthority(client: PoolClient, collectionId: string): Promise<AuthorityRow | null> {
  const row = await client.query<AuthorityRow>(`select account.id as owner_profile_id,
      collection.deleted_at is null and collection.visibility='public'
        and collection.publication_slug is not null and collection.published_at is not null
        and account.status='active' and account.deleted_at is null
        and profile.account_id is not null as discoverable
    from collections collection
    left join accounts account on account.subject_id=collection.owner_subject_id
    left join profiles profile on profile.account_id=account.id
    where collection.id=$1`, [collectionId]);
  return row.rows[0] ?? null;
}

async function readRecipients(
  client: PoolClient,
  event: SocialCollectionChangeConsumerEvent,
  maxRecipients: number,
  afterRecipient: string | null,
  includeCollectionFollowers: boolean,
): Promise<readonly string[]> {
  const statement = buildFanoutRecipientPageStatement({
    ownerProfileId: event.ownerProfileId,
    collectionId: event.collectionId,
    occurredAt: event.occurredAt,
    afterRecipientProfileId: afterRecipient,
    limit: maxRecipients,
    includeCollectionFollowers,
  });
  const rows = await client.query<{ actor_profile_id: string }>(
    statement.text, [...statement.values],
  );
  return Object.freeze(rows.rows.map((row) => row.actor_profile_id));
}

async function insertRecipientPages(
  client: PoolClient,
  event: SocialCollectionChangeConsumerEvent,
  maxRecipients: number,
  signal?: AbortSignal,
  emitNotificationIntents = true,
  maxTotalRecipients?: number,
  includeCollectionFollowers = false,
): Promise<number> {
  let itemCount = 0;
  let afterRecipient: string | null = null;
  const batchSignal = signal ?? new AbortController().signal;
  while (true) {
    signal?.throwIfAborted();
    const recipients = await readRecipients(
      client, event, maxRecipients, afterRecipient, includeCollectionFollowers,
    );
    // PGC-05 (T-08): rebuild inserts whole recipient pages through the same
    // UNNEST batch as live fan-out instead of one INSERT per recipient.
    // FIX-M-027 semantics are preserved by chunking to the remaining budget:
    // a batch can never insert past maxTotalRecipients (conflicts do not
    // consume budget), and reaching the cap with recipients still pending
    // fails retryable exactly like the previous per-row loop.
    let index = 0;
    while (index < recipients.length) {
      signal?.throwIfAborted();
      if (maxTotalRecipients !== undefined && itemCount >= maxTotalRecipients) {
        throw new OutboxDeliveryError('retryable', 'social Feed rebuild recipient cap exceeded');
      }
      const budget = maxTotalRecipients === undefined
        ? recipients.length - index
        : Math.min(maxTotalRecipients - itemCount, recipients.length - index);
      const chunk = recipients.slice(index, index + budget);
      itemCount += await insertItemsBatch(
        client, event, chunk, emitNotificationIntents, batchSignal,
      );
      index += chunk.length;
    }
    if (recipients.length < maxRecipients) return itemCount;
    afterRecipient = recipients.at(-1)!;
  }
}

async function withdrawVisiblePage(
  client: PoolClient,
  event: SocialCollectionChangeConsumerEvent,
  reason: 'source_removed' | 'discoverability_revoked' | 'unfollowed',
  limit: number,
): Promise<number> {
  const withdrawn = await client.query(`with selected as (
      select feed_item_id
        from social_feed_items
       where collection_id=$1 and source_commit_ordinal <= $2 and state='visible'
       order by feed_item_id
       for update skip locked
       limit $4
    )
    update social_feed_items item
       set state='withdrawn', withdrawn_at=current_timestamp, withdrawal_reason=$3
      from selected
     where item.feed_item_id=selected.feed_item_id`,
  [event.collectionId, event.commitOrdinal, reason, limit]);
  return withdrawn.rowCount ?? 0;
}

async function insertItemsBatch(
  client: PoolClient,
  event: SocialCollectionChangeConsumerEvent,
  recipients: readonly string[],
  emitNotificationIntent: boolean,
  signal: AbortSignal,
): Promise<number> {
  if (recipients.length === 0) return 0;

  // Precompute stable Feed item ids in Node so UNNEST arrays stay aligned.
  const feedItemIds = recipients.map((recipientProfileId) => stableFeedItemId(
    event.eventId, recipientProfileId,
  ));

  signal.throwIfAborted();
  const inserted = await client.query<{
    feed_item_id: string;
    recipient_profile_id: string;
  }>(`insert into social_feed_items(
      feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,collection_id,
      source_event_version,source_commit_ordinal,publication_revision,
      discoverability_recheck_key,published_at,retain_until)
    select feed_item_id,$2,'collection_change',recipient_profile_id,$3,$4,$5,$6,$7,$8,
           $9::timestamptz,$9::timestamptz + interval '90 days'
      from unnest($1::text[],$10::text[]) as batch(feed_item_id,recipient_profile_id)
    on conflict (source_event_id,recipient_profile_id) do nothing
    returning feed_item_id,recipient_profile_id`, [
    feedItemIds, event.eventId, event.ownerProfileId, event.collectionId,
    event.eventVersion, event.commitOrdinal, event.publicationRevision,
    event.discoverabilityRecheckKey, event.occurredAt, recipients,
  ]);

  if (emitNotificationIntent && inserted.rows.length > 0) {
    await appendNotificationIntentsBatch(client, event, inserted.rows, signal);
  }
  return inserted.rows.length;
}

async function appendNotificationIntentsBatch(
  client: PoolClient,
  event: SocialCollectionChangeConsumerEvent,
  insertedRows: readonly { feed_item_id: string; recipient_profile_id: string }[],
  signal: AbortSignal,
): Promise<void> {
  // Key by returned row fields — never assume RETURNING order matches UNNEST input order.
  const eventIds: string[] = [];
  const outboxIds: string[] = [];
  const feedItemIds: string[] = [];
  const recipientIds: string[] = [];
  const resourceIds: string[] = [];
  const resourceTypes: string[] = [];
  const payloads: string[] = [];

  for (const row of insertedRows) {
    const feedItemId = row.feed_item_id;
    const recipientProfileId = row.recipient_profile_id;
    const eventId = stableIntentId('event', feedItemId);
    const outboxId = stableIntentId('outbox', feedItemId);
    const payload = {
      feedItemId,
      recipientProfileId,
      sourceEventId: event.eventId,
      collectionId: event.collectionId,
      discoverabilityRecheckKey: event.discoverabilityRecheckKey,
    };
    const payloadJson = JSON.stringify(payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > 2_048) {
      throw new OutboxDeliveryError('permanent', 'social Feed notification intent exceeds content budget');
    }
    eventIds.push(eventId);
    outboxIds.push(outboxId);
    feedItemIds.push(feedItemId);
    recipientIds.push(recipientProfileId);
    payloads.push(payloadJson);
    resourceIds.push(eventId, outboxId);
    resourceTypes.push('notification-domain-event', 'notification-outbox');
  }

  signal.throwIfAborted();
  await client.query(`insert into resource_id_ledger(resource_id,resource_type,committed_at)
    select resource_id,resource_type,$3
      from unnest($1::text[],$2::text[]) as batch(resource_id,resource_type)`,
  [resourceIds, resourceTypes, event.occurredAt]);

  signal.throwIfAborted();
  await client.query(`insert into outbox_events(outbox_id,domain_event_id,event_type,event_version,
      handler_name,handler_mode,aggregate_type,aggregate_id,aggregate_scope,aggregate_revision,
      commit_ordinal,occurred_at,payload_json,state,attempt_count,available_at,lease_generation)
    select outbox_id,event_id,'social.feed-item-published',1,'social_feed_item_notification',
           'delivery_each_event','social-feed-item',feed_item_id,recipient_profile_id,'1',$4,$5,
           payload::jsonb,'pending',0,current_timestamp,0
      from unnest($1::text[],$2::text[],$3::text[],$6::text[],$7::text[])
        as batch(outbox_id,event_id,feed_item_id,recipient_profile_id,payload)`,
  [outboxIds, eventIds, feedItemIds, event.commitOrdinal, event.occurredAt, recipientIds, payloads]);
}

function retainedEvent(row: RetainedEventRow, scope: string): SocialCollectionChangeConsumerEvent {
  const payload = row.payload_json;
  if ((row.event_version !== 1 && row.event_version !== 2)
      || payload.collectionId !== scope || typeof payload.ownerProfileId !== 'string'
      || typeof payload.publicationRevision !== 'string'
      || payload.publicationRevision !== row.aggregate_revision
      || payload.discoverabilityRecheckKey !== `publication.collection:${scope}`
      || (row.event_version === 2 && payload.producerDiscoverability !== 'public_candidate'
        && payload.producerDiscoverability !== 'remove')) {
    throw new OutboxDeliveryError('permanent', 'invalid retained social collection change event');
  }
  return {
    eventId: row.domain_event_id,
    eventVersion: row.event_version,
    collectionId: scope,
    ownerProfileId: payload.ownerProfileId,
    publicationRevision: payload.publicationRevision,
    discoverabilityRecheckKey: payload.discoverabilityRecheckKey as string,
    producerDiscoverability: row.event_version === 2
      ? payload.producerDiscoverability as 'public_candidate' | 'remove' : null,
    commitOrdinal: row.commit_ordinal,
    occurredAt: row.occurred_at,
  };
}

class LeaseFenceRollbackError extends Error {}

async function inTransaction<Result>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<Result>,
  input: { readonly attempt: { readonly outboxId: string; readonly leaseGeneration: string }; readonly signal: AbortSignal },
): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    if (!await fenceOutboxLease((statement, parameters) => client.query(statement, parameters),
      input.attempt, input.signal)) throw new LeaseFenceRollbackError();
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    await rollbackTransaction(error, () => client.query('rollback'), 'Social feed worker transaction');
    throw error;
  } finally {
    client.release();
  }
}

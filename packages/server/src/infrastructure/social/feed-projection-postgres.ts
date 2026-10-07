import type { Pool, PoolClient } from 'pg';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type AdvanceSocialFeedWatermark,
  type AdvanceSocialFeedRebuild,
  type AppliedSocialFeedBatch,
  type ApplySocialFeedBatchInput,
  type BeginSocialFeedRebuild,
  type PurgeSocialFeedItemsInput,
  type PurgedSocialFeedItems,
  type SavedSocialFeedItem,
  type SocialFeedItemInput,
  type SocialFeedItemRecord,
  type SocialFeedProjectionRepository,
  type SocialFeedWatermark,
  type SocialFeedWatermarkCas,
  type SocialFeedWithdrawalReason,
} from '../../modules/social/index.js';

interface FeedItemRow {
  feed_item_id: string;
  source_event_id: string;
  kind: 'collection_change' | 'follow_activity';
  recipient_profile_id: string;
  actor_profile_id: string;
  collection_id: string | null;
  source_event_version: number;
  source_commit_ordinal: string;
  publication_revision: string | null;
  discoverability_recheck_key: string;
  published_at: Date;
  retain_until: Date;
  state: 'visible' | 'withdrawn';
  withdrawn_at: Date | null;
  withdrawal_reason: SocialFeedWithdrawalReason | null;
  created_at: Date;
}

interface WatermarkRow {
  aggregate_scope: string;
  projection_state: 'live' | 'rebuilding';
  last_commit_ordinal: string;
  last_source_event_id: string | null;
  rebuild_generation: string;
  rebuild_high_commit_ordinal: string | null;
  rebuild_replayed_commit_ordinal: string | null;
  rebuild_started_at: Date | null;
  state_revision: string;
  state_updated_at: Date;
}

const SAFE_TEXT_MAX = SOCIAL_IDENTITY_MAX_LENGTH;

export function createPostgresSocialFeedProjectionRepository(
  pool: Pool,
): SocialFeedProjectionRepository {
  return Object.freeze({
    async applyBatch(input: ApplySocialFeedBatchInput): Promise<AppliedSocialFeedBatch | null> {
      if (input.items.length < 1 || input.items.length > 1_000) {
        throw new TypeError('Feed projection batch must contain between 1 and 1000 items');
      }
      input.items.forEach(assertItem);
      assertAdvance(input.watermark);
      for (const item of input.items) {
        if (item.collectionId !== input.watermark.aggregateScope
            || item.sourceEventId !== input.watermark.sourceEventId
            || item.sourceCommitOrdinal !== input.watermark.nextCommitOrdinal) {
          throw new TypeError('Feed projection batch items must match the watermark event scope');
        }
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const advanced = await advanceWatermark(client, input.watermark);
        if (!advanced) {
          await client.query('ROLLBACK');
          return null;
        }
        const items: SavedSocialFeedItem[] = [];
        for (const item of input.items) items.push(await putItem(client, item));
        await client.query('COMMIT');
        return Object.freeze({ items: Object.freeze(items), watermark: advanced });
      } catch (error: unknown) {
        await rollbackTransaction(error, () => client.query('ROLLBACK'), 'Social feed batch projection');
        throw error;
      } finally {
        client.release();
      }
    },

    async withdrawItem(input: {
      readonly feedItemId: string;
      readonly reason: SocialFeedWithdrawalReason;
    }): Promise<boolean> {
      assertText(input.feedItemId, 'feedItemId', 128);
      if (!['source_removed', 'discoverability_revoked', 'unfollowed'].includes(input.reason)) {
        throw new TypeError('Feed withdrawal reason is invalid');
      }
      const result = await pool.query(`update social_feed_items
        set state='withdrawn',withdrawn_at=current_timestamp,withdrawal_reason=$2
        where feed_item_id=$1 and state='visible'`, [input.feedItemId, input.reason]);
      return result.rowCount === 1;
    },

    async loadWatermark(aggregateScope: string): Promise<SocialFeedWatermark> {
      assertText(aggregateScope, 'aggregateScope', SAFE_TEXT_MAX);
      await pool.query(`insert into social_feed_watermarks(aggregate_scope) values($1)
        on conflict (aggregate_scope) do nothing`, [aggregateScope]);
      const row = await pool.query<WatermarkRow>(
        'select * from social_feed_watermarks where aggregate_scope=$1', [aggregateScope],
      );
      if (!row.rows[0]) throw new Error('Feed watermark initialization has no durable row');
      return mapWatermark(row.rows[0]);
    },

    async advanceWatermark(
      input: AdvanceSocialFeedWatermark,
    ): Promise<SocialFeedWatermark | null> {
      assertAdvance(input);
      return advanceWatermark(pool, input);
    },

    async beginRebuild(input: BeginSocialFeedRebuild): Promise<SocialFeedWatermark | null> {
      const high = assertBegin(input);
      const row = await pool.query<WatermarkRow>(`update social_feed_watermarks
        set projection_state='rebuilding',rebuild_generation=rebuild_generation+1,
            rebuild_high_commit_ordinal=$3,rebuild_high_source_event_id=$4,
            rebuild_replayed_commit_ordinal=0,
            rebuild_started_at=current_timestamp,
            state_revision=state_revision+1,
            state_updated_at=current_timestamp
        where aggregate_scope=$1 and state_revision=$2 and projection_state='live'
          and last_commit_ordinal <= $3
        returning *`, [
        input.aggregateScope, input.expectedStateRevision.toString(), high.toString(),
        input.capturedHighSourceEventId,
      ]);
      return row.rows[0] ? mapWatermark(row.rows[0]) : null;
    },

    async advanceRebuild(input: AdvanceSocialFeedRebuild): Promise<SocialFeedWatermark | null> {
      assertCas(input);
      const replayed = nonNegativeOrdinal(input.replayedCommitOrdinal, 'replayedCommitOrdinal');
      const row = await pool.query<WatermarkRow>(`update social_feed_watermarks
        set rebuild_replayed_commit_ordinal=$3,state_revision=state_revision+1,
            state_updated_at=current_timestamp
        where aggregate_scope=$1 and state_revision=$2 and projection_state='rebuilding'
          and rebuild_replayed_commit_ordinal < $3 and $3 <= rebuild_high_commit_ordinal
        returning *`, [
        input.aggregateScope, input.expectedStateRevision.toString(), replayed.toString(),
      ]);
      return row.rows[0] ? mapWatermark(row.rows[0]) : null;
    },

    async completeRebuild(input: SocialFeedWatermarkCas): Promise<SocialFeedWatermark | null> {
      assertCas(input);
      const row = await pool.query<WatermarkRow>(`update social_feed_watermarks
        set projection_state='live',rebuild_high_commit_ordinal=null,
            rebuild_high_source_event_id=null,
            rebuild_replayed_commit_ordinal=null,rebuild_started_at=null,
            state_revision=state_revision+1,state_updated_at=current_timestamp
        where aggregate_scope=$1 and state_revision=$2 and projection_state='rebuilding'
          and rebuild_replayed_commit_ordinal >= rebuild_high_commit_ordinal
        returning *`, [input.aggregateScope, input.expectedStateRevision.toString()]);
      return row.rows[0] ? mapWatermark(row.rows[0]) : null;
    },

    async purgeExpiredItems(input: PurgeSocialFeedItemsInput): Promise<PurgedSocialFeedItems> {
      if (!(input.cutoff instanceof Date) || !Number.isFinite(input.cutoff.getTime())) {
        throw new TypeError('Feed retention cutoff must be a finite Date');
      }
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 10_000) {
        throw new TypeError('Feed retention batch limit must be between 1 and 10000');
      }
      if (input.aggregateScope !== undefined) {
        assertText(input.aggregateScope, 'aggregateScope', SAFE_TEXT_MAX);
      }
      const client = input.aggregateScope === undefined ? null : await pool.connect();
      try {
        if (client) {
          await client.query('begin');
          await client.query('select pg_advisory_xact_lock(hashtextextended($1,511))',
            [input.aggregateScope]);
        }
        const rows = await (client ?? pool).query<{ feed_item_id: string }>(`with victims as (
          select feed_item_id from social_feed_items
           where retain_until <= least($1::timestamptz,current_timestamp)
             and ($3::text is null or collection_id=$3)
             and not exists (select 1 from social_feed_watermarks watermark
               where watermark.aggregate_scope=social_feed_items.collection_id
                 and watermark.projection_state='rebuilding')
             and not exists (select 1 from outbox_events source
               where source.domain_event_id=social_feed_items.source_event_id
                 and source.handler_name='social.publish-collection-change'
                 and (source.state<>'completed'
                   or source.occurred_at >= current_timestamp-interval '90 days'))
           order by retain_until,feed_item_id
           for update skip locked limit $2
        )
        delete from social_feed_items item using victims
         where item.feed_item_id=victims.feed_item_id
        returning item.feed_item_id`, [input.cutoff, input.limit, input.aggregateScope ?? null]);
        if (client) await client.query('commit');
        const feedItemIds = Object.freeze(rows.rows.map((row) => row.feed_item_id));
        return Object.freeze({ deletedCount: feedItemIds.length, feedItemIds });
      } catch (error: unknown) {
        if (client) {
          await rollbackTransaction(error, () => client.query('rollback'), 'Social feed purge');
        }
        throw error;
      } finally {
        client?.release();
      }
    },
  });
}

function assertItem(input: SocialFeedItemInput): void {
  assertText(input.feedItemId, 'feedItemId', 128);
  assertText(input.sourceEventId, 'sourceEventId', 128);
  if (!['collection_change', 'follow_activity'].includes(input.kind)) {
    throw new TypeError('Feed item kind is invalid');
  }
  assertText(input.recipientProfileId, 'recipientProfileId', SAFE_TEXT_MAX);
  assertText(input.actorProfileId, 'actorProfileId', SAFE_TEXT_MAX);
  assertText(input.discoverabilityRecheckKey, 'discoverabilityRecheckKey', SAFE_TEXT_MAX);
  if (!Number.isSafeInteger(input.sourceEventVersion) || input.sourceEventVersion < 1) {
    throw new TypeError('sourceEventVersion must be a positive integer');
  }
  if (input.kind === 'follow_activity') {
    if (input.collectionId !== null || input.publicationRevision !== null
        || input.sourceCommitOrdinal !== '0') {
      throw new TypeError('follow_activity Feed items must not bind a Collection or publication revision');
    }
  } else {
    assertText(input.collectionId, 'collectionId', SAFE_TEXT_MAX);
    assertText(input.publicationRevision, 'publicationRevision', SAFE_TEXT_MAX);
    positiveOrdinal(input.sourceCommitOrdinal, 'sourceCommitOrdinal');
  }
  if (!(input.publishedAt instanceof Date) || !Number.isFinite(input.publishedAt.getTime())) {
    throw new TypeError('publishedAt must be a finite Date');
  }
}

function assertCas(input: SocialFeedWatermarkCas): void {
  assertText(input.aggregateScope, 'aggregateScope', SAFE_TEXT_MAX);
  if (typeof input.expectedStateRevision !== 'bigint' || input.expectedStateRevision < 0n) {
    throw new TypeError('expectedStateRevision must be a non-negative bigint');
  }
}

function assertBegin(input: BeginSocialFeedRebuild): bigint {
  assertCas(input);
  const high = nonNegativeOrdinal(input.capturedHighCommitOrdinal, 'capturedHighCommitOrdinal');
  if (high === 0n) {
    if (input.capturedHighSourceEventId !== null) {
      throw new TypeError('capturedHighSourceEventId must be null when captured high is 0');
    }
  } else {
    assertText(input.capturedHighSourceEventId, 'capturedHighSourceEventId', 128);
  }
  return high;
}

function assertAdvance(input: AdvanceSocialFeedWatermark): void {
  assertCas(input);
  positiveOrdinal(input.nextCommitOrdinal, 'nextCommitOrdinal');
  assertText(input.sourceEventId, 'sourceEventId', 128);
}

async function advanceWatermark(
  client: Pool | PoolClient,
  input: AdvanceSocialFeedWatermark,
): Promise<SocialFeedWatermark | null> {
  const row = await client.query<WatermarkRow>(`update social_feed_watermarks
    set last_commit_ordinal=$3,last_source_event_id=$4,
        state_revision=state_revision+1,state_updated_at=current_timestamp
    where aggregate_scope=$1 and state_revision=$2 and last_commit_ordinal < $3
    returning *`, [
    input.aggregateScope, input.expectedStateRevision.toString(), input.nextCommitOrdinal,
    input.sourceEventId,
  ]);
  return row.rows[0] ? mapWatermark(row.rows[0]) : null;
}

async function putItem(
  client: Pool | PoolClient,
  input: SocialFeedItemInput,
): Promise<SavedSocialFeedItem> {
  const inserted = await client.query<FeedItemRow>(`
    insert into social_feed_items(
      feed_item_id,source_event_id,kind,recipient_profile_id,actor_profile_id,collection_id,
      source_event_version,source_commit_ordinal,publication_revision,
      discoverability_recheck_key,published_at,retain_until)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11::timestamptz + interval '90 days')
    on conflict (source_event_id,recipient_profile_id) do nothing
    returning *`, [
    input.feedItemId, input.sourceEventId, input.kind, input.recipientProfileId,
    input.actorProfileId, input.collectionId, input.sourceEventVersion, input.sourceCommitOrdinal,
    input.publicationRevision, input.discoverabilityRecheckKey, input.publishedAt,
  ]);
  if (inserted.rows[0]) return Object.freeze({ ...mapItem(inserted.rows[0]), inserted: true });
  const winner = await client.query<FeedItemRow>(`select * from social_feed_items
    where source_event_id=$1 and recipient_profile_id=$2`,
  [input.sourceEventId, input.recipientProfileId]);
  if (!winner.rows[0]) throw new Error('Feed item uniqueness conflict has no durable winner');
  assertWinnerMatches(winner.rows[0], input);
  return Object.freeze({ ...mapItem(winner.rows[0]), inserted: false });
}

function assertWinnerMatches(row: FeedItemRow, input: SocialFeedItemInput): void {
  if (row.kind !== input.kind
      || row.actor_profile_id !== input.actorProfileId
      || row.collection_id !== input.collectionId
      || row.source_event_version !== input.sourceEventVersion
      || String(row.source_commit_ordinal) !== input.sourceCommitOrdinal
      || row.publication_revision !== input.publicationRevision
      || row.discoverability_recheck_key !== input.discoverabilityRecheckKey
      || row.published_at.getTime() !== input.publishedAt.getTime()) {
    throw new Error('Feed item event/recipient binding conflicts with immutable facts');
  }
}

function assertText(value: unknown, name: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
}

function positiveOrdinal(value: string, name: string): bigint {
  const parsed = nonNegativeOrdinal(value, name);
  if (parsed < 1n) throw new TypeError(`${name} must be positive`);
  return parsed;
}

function nonNegativeOrdinal(value: string, name: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new TypeError(`${name} is invalid`);
  return BigInt(value);
}

function mapItem(row: FeedItemRow): SocialFeedItemRecord {
  return Object.freeze({
    feedItemId: row.feed_item_id,
    sourceEventId: row.source_event_id,
    kind: row.kind,
    recipientProfileId: row.recipient_profile_id,
    actorProfileId: row.actor_profile_id,
    collectionId: row.collection_id,
    sourceEventVersion: row.source_event_version,
    sourceCommitOrdinal: String(row.source_commit_ordinal),
    publicationRevision: row.publication_revision,
    discoverabilityRecheckKey: row.discoverability_recheck_key,
    publishedAt: row.published_at,
    state: row.state,
    withdrawnAt: row.withdrawn_at,
    withdrawalReason: row.withdrawal_reason,
    retainUntil: row.retain_until,
    createdAt: row.created_at,
  });
}

function mapWatermark(row: WatermarkRow): SocialFeedWatermark {
  return Object.freeze({
    aggregateScope: row.aggregate_scope,
    projectionState: row.projection_state,
    lastCommitOrdinal: String(row.last_commit_ordinal),
    lastSourceEventId: row.last_source_event_id,
    rebuildGeneration: BigInt(row.rebuild_generation),
    rebuildHighCommitOrdinal: row.rebuild_high_commit_ordinal === null
      ? null : String(row.rebuild_high_commit_ordinal),
    rebuildReplayedCommitOrdinal: row.rebuild_replayed_commit_ordinal === null
      ? null : String(row.rebuild_replayed_commit_ordinal),
    rebuildStartedAt: row.rebuild_started_at,
    stateRevision: BigInt(row.state_revision),
    stateUpdatedAt: row.state_updated_at,
  });
}

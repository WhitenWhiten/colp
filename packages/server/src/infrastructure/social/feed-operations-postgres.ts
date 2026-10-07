import type { Pool } from 'pg';
import { rollbackTransaction } from '../database/transaction-rollback.js';
import {
  SOCIAL_IDENTITY_MAX_LENGTH,
  type FeedDeadLetterReplayResult,
  type FeedFanoutOperationsStatus,
  type FeedOperationsRepository,
  type FeedOperationsStatus,
  type FeedScopeEvidence,
  type SocialFeedWatermark,
} from '../../modules/social/index.js';
import { SOCIAL_FEED_WITHDRAWAL_HANDLER } from './feed-withdrawal-worker-route.js';

const HANDLER = 'social.publish-collection-change';

export function createPostgresSocialFeedOperationsRepository(pool: Pool): FeedOperationsRepository {
  return Object.freeze({
    async inspectStatus(): Promise<FeedOperationsStatus> {
      try {
        const [queue, rebuilding, categories, lag, fanout, rebuilds] = await Promise.all([
          pool.query<{ state: string; count: string; oldest_ms: string }>(`select state,
              count(*)::text,coalesce(extract(epoch from
                (current_timestamp-min(case when state='dead_letter' then dead_lettered_at
                  else available_at end)))*1000,0)::bigint::text oldest_ms
            from outbox_events where handler_name=$1
              and (state in ('pending','retryable','leased','dead_letter')
                or (state='completed' and completed_at >= current_timestamp-interval '2 minutes'))
              group by state`, [HANDLER]),
          pool.query<{ count: string }>(`select count(*)::text from social_feed_watermarks
            where projection_state='rebuilding'`),
          pool.query<DeadLetterCategoryRow>(`select
            count(*) filter (where category='unknown_future_version')::text unknown_future_version,
            count(*) filter (where category='invalid_contract')::text invalid_contract,
            count(*) filter (where category='retry_exhausted')::text retry_exhausted,
            count(*) filter (where category='dependency')::text dependency,
            count(*) filter (where category='other')::text other from (
              select case
                when last_error ilike '%unknown%version%' then 'unknown_future_version'
                when last_error ilike '%invalid%event%' then 'invalid_contract'
                when last_error ilike '%attempt%' or last_error ilike '%retry%' then 'retry_exhausted'
                when last_error ilike '%database%' or last_error ilike '%dependency%' then 'dependency'
                else 'other' end category
              from outbox_events where handler_name=$1 and state='dead_letter'
            ) classified`, [HANDLER]),
          pool.query<LagRow>(`with sources as (
              select aggregate_scope,max(commit_ordinal) high
              from outbox_events where handler_name=$1 group by aggregate_scope
            ), per_scope as (
              select sources.high,coalesce(watermark.last_commit_ordinal,0) watermark
              from sources left join social_feed_watermarks watermark
                on watermark.aggregate_scope=sources.aggregate_scope
            ) select coalesce(max(high),0)::text source_high,
              coalesce(max(watermark),0)::text watermark_high,
              coalesce(max(greatest(high-watermark,0)),0)::text maximum_lag from per_scope`, [HANDLER]),
          pool.query<FanoutRow>(`with active as (
              select fanout_source_event_id, fanout_candidate_count, fanout_started_at,
                     aggregate_scope
                from social_feed_watermarks
               where fanout_source_event_id is not null
            ), progress as (
              select count(*)::text progress_backlog,
                     coalesce(extract(epoch from
                       (current_timestamp-min(fanout_started_at)))*1000,0)::bigint::text oldest_ms,
                     coalesce(sum(fanout_candidate_count),0)::text candidate_count
                from active
            ), orphan as (
              select count(*)::text orphan_progress
                from active
               where not exists (
                 select 1 from outbox_events outbox
                  where outbox.handler_name=$1
                    and outbox.domain_event_id=active.fanout_source_event_id
                    and outbox.state in ('pending','retryable','leased')
               )
            ), reverse as (
              select count(*)::text reverse_inconsistency
                from active
               where exists (
                 select 1 from outbox_events outbox
                  where outbox.handler_name=$1
                    and outbox.domain_event_id=active.fanout_source_event_id
                    and outbox.state in ('completed','dead_letter')
               )
                 and not exists (
                 select 1 from outbox_events outbox
                  where outbox.handler_name=$1
                    and outbox.domain_event_id=active.fanout_source_event_id
                    and outbox.state in ('pending','retryable','leased')
               )
            ), withdrawal as (
              select count(*)::text withdrawal_backlog
                from outbox_events
               where handler_name=$2
                 and state in ('pending','retryable','leased')
            )
            select progress.progress_backlog, progress.oldest_ms, progress.candidate_count,
                   orphan.orphan_progress, reverse.reverse_inconsistency,
                   withdrawal.withdrawal_backlog
              from progress, orphan, reverse, withdrawal`,
          [HANDLER, SOCIAL_FEED_WITHDRAWAL_HANDLER]),
          pool.query<RebuildRow>(`select watermark.aggregate_scope,
              watermark.rebuild_generation::text as generation,
              watermark.rebuild_high_commit_ordinal::text as captured_high,
              watermark.rebuild_replayed_commit_ordinal::text as replayed,
              watermark.rebuild_started_at as started_at,
              coalesce(floor.floor_commit_ordinal,0)::text as retention_floor,
              coalesce((select min(source.commit_ordinal) from outbox_events source
                 where source.handler_name=$1 and source.event_type='social.collection-change'
                   and source.aggregate_scope=watermark.aggregate_scope
                   and source.commit_ordinal > 0
                   and source.occurred_at >= current_timestamp - interval '90 days'),0)::bigint
                as retained_lo,
              (greatest(watermark.rebuild_replayed_commit_ordinal,
                  coalesce(floor.floor_commit_ordinal,0))
                 < watermark.rebuild_high_commit_ordinal
               and ((select count(distinct source.commit_ordinal)
                       from outbox_events source
                      where source.handler_name=$1
                        and source.event_type='social.collection-change'
                        and source.aggregate_scope=watermark.aggregate_scope
                        and source.commit_ordinal > greatest(
                          watermark.rebuild_replayed_commit_ordinal,
                          coalesce(floor.floor_commit_ordinal,0))
                        and source.commit_ordinal <= watermark.rebuild_high_commit_ordinal)
                    <> watermark.rebuild_high_commit_ordinal - greatest(
                      watermark.rebuild_replayed_commit_ordinal,
                      coalesce(floor.floor_commit_ordinal,0))
                 or exists (select 1 from outbox_events source
                      where source.handler_name=$1
                        and source.event_type='social.collection-change'
                        and source.aggregate_scope=watermark.aggregate_scope
                        and source.commit_ordinal > greatest(
                          watermark.rebuild_replayed_commit_ordinal,
                          coalesce(floor.floor_commit_ordinal,0))
                        and source.commit_ordinal <= watermark.rebuild_high_commit_ordinal
                        and source.state <> 'completed'))) as gap
            from social_feed_watermarks watermark
            left join outbox_retention_floors floor
              on floor.handler_name=$1 and floor.event_type='social.collection-change'
             and floor.aggregate_scope=watermark.aggregate_scope
           where watermark.projection_state='rebuilding'
           order by watermark.aggregate_scope`, [HANDLER]),
        ]);
        const byState = new Map(queue.rows.map((row) => [row.state, row]));
        const number = (state: string, key: 'count' | 'oldest_ms') =>
          Number(byState.get(state)?.[key] ?? 0);
        const active = number('pending', 'count') + number('retryable', 'count')
          + number('dead_letter', 'count');
        const worker = number('leased', 'count') > 0 || number('completed', 'count') > 0
          ? 'running' : active === 0 ? 'idle' : 'stopped';
        const lagRow = lag.rows[0];
        return Object.freeze({ dependency: 'available', worker,
          readyCount: number('pending', 'count'), retryCount: number('retryable', 'count'),
          leasedCount: number('leased', 'count'), deadLetterCount: number('dead_letter', 'count'),
          oldestEligibleAgeMs: Math.max(0, number('pending', 'oldest_ms'),
            number('retryable', 'oldest_ms')),
          oldestDeadLetterAgeMs: Math.max(0, number('dead_letter', 'oldest_ms')),
          rebuildingScopeCount: Number(rebuilding.rows[0]?.count ?? 0),
          sourceHighCommitOrdinal: lagRow?.source_high ?? '0',
          watermarkHighCommitOrdinal: lagRow?.watermark_high ?? '0',
          maximumCommitLag: lagRow?.maximum_lag ?? '0',
          deadLetterCategories: mapCategories(categories.rows[0]),
          rebuilds: mapRebuilds(rebuilds.rows, Date.now()),
          fanout: mapFanout(fanout.rows[0]) });
      } catch {
        return Object.freeze({ dependency: 'unavailable', worker: 'unknown', readyCount: 0,
          retryCount: 0, leasedCount: 0, deadLetterCount: 0, oldestEligibleAgeMs: 0,
          oldestDeadLetterAgeMs: 0, rebuildingScopeCount: 0,
          sourceHighCommitOrdinal: '0', watermarkHighCommitOrdinal: '0', maximumCommitLag: '0',
          deadLetterCategories: mapCategories(), rebuilds: Object.freeze([]),
          fanout: mapFanout() });
      }
    },

    async captureScope(aggregateScope: string): Promise<FeedScopeEvidence> {
      assertScope(aggregateScope);
      const client = await pool.connect();
      try {
        await client.query('begin isolation level repeatable read read only');
        const watermark = await client.query<WatermarkRow>(`select aggregate_scope,
          projection_state,last_commit_ordinal::text,last_source_event_id,
          rebuild_generation::text,rebuild_high_commit_ordinal::text,
          rebuild_replayed_commit_ordinal::text,rebuild_started_at,state_revision::text,
          state_updated_at
          from social_feed_watermarks where aggregate_scope=$1`, [aggregateScope]);
        if (!watermark.rows[0]) throw new Error('Feed operations scope has no production watermark');
        const items = await client.query<{ feed_item_id: string }>(`select feed_item_id
          from social_feed_items where collection_id=$1 order by feed_item_id`, [aggregateScope]);
        await client.query('commit');
        return Object.freeze({ watermark: mapWatermark(watermark.rows[0]),
          itemIds: Object.freeze(items.rows.map((row) => row.feed_item_id)) });
      } catch (error: unknown) {
        await rollbackTransaction(error, () => client.query('rollback'), 'Social feed operations inspection');
        throw error;
      } finally { client.release(); }
    },

    async replayDeadLetters(input: { readonly aggregateScope: string; readonly limit: number;
      readonly allowUnknownFutureVersion?: boolean }): Promise<FeedDeadLetterReplayResult> {
      assertScope(input.aggregateScope);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new RangeError('Feed dead-letter replay limit must be between 1 and 1000');
      }
      const rows = await pool.query<{ outbox_id: string }>(`with candidates as (
          select outbox_id from outbox_events where handler_name=$1 and state='dead_letter'
            and aggregate_scope=$3 and ($4::boolean or last_error not ilike '%unknown%version%')
          order by dead_lettered_at,outbox_id for update skip locked limit $2
        ) update outbox_events event set state='retryable',available_at=current_timestamp,
          dead_lettered_at=null,locked_until=null
        from candidates where event.outbox_id=candidates.outbox_id
          and event.state='dead_letter' returning event.outbox_id`,
      [HANDLER, input.limit, input.aggregateScope, input.allowUnknownFutureVersion === true]);
      return Object.freeze({ outboxIds: Object.freeze(rows.rows.map((row) => row.outbox_id)) });
    },
  });
}

interface WatermarkRow {
  aggregate_scope: string; projection_state: 'live' | 'rebuilding'; last_commit_ordinal: string;
  last_source_event_id: string | null; rebuild_generation: string;
  rebuild_high_commit_ordinal: string | null; rebuild_replayed_commit_ordinal: string | null;
  rebuild_started_at: Date | null;
  state_revision: string; state_updated_at: Date;
}

interface RebuildRow {
  aggregate_scope: string;
  generation: string;
  captured_high: string;
  replayed: string;
  retention_floor: string;
  started_at: Date | null;
  retained_lo: string;
  gap: boolean;
}

interface DeadLetterCategoryRow {
  unknown_future_version: string; invalid_contract: string; retry_exhausted: string;
  dependency: string; other: string;
}

interface LagRow { source_high: string; watermark_high: string; maximum_lag: string }

interface FanoutRow {
  progress_backlog: string; oldest_ms: string; candidate_count: string;
  orphan_progress: string; reverse_inconsistency: string; withdrawal_backlog: string;
}

function mapCategories(row?: DeadLetterCategoryRow): FeedOperationsStatus['deadLetterCategories'] {
  return Object.freeze({ unknownFutureVersion: Number(row?.unknown_future_version ?? 0),
    invalidContract: Number(row?.invalid_contract ?? 0),
    retryExhausted: Number(row?.retry_exhausted ?? 0),
    dependency: Number(row?.dependency ?? 0), other: Number(row?.other ?? 0) });
}

function mapFanout(row?: FanoutRow): FeedFanoutOperationsStatus {
  return Object.freeze({
    progressBacklog: Number(row?.progress_backlog ?? 0),
    oldestProgressAgeMs: Math.max(0, Number(row?.oldest_ms ?? 0)),
    candidateCount: Number(row?.candidate_count ?? 0),
    orphanProgressCount: Number(row?.orphan_progress ?? 0),
    reverseInconsistencyCount: Number(row?.reverse_inconsistency ?? 0),
    withdrawalBacklog: Number(row?.withdrawal_backlog ?? 0),
  });
}

function mapRebuilds(
  rows: readonly RebuildRow[],
  now: number,
): FeedOperationsStatus['rebuilds'] {
  return Object.freeze(rows.map((row) => {
    const high = BigInt(row.captured_high);
    const replayed = BigInt(row.replayed);
    const lo = BigInt(row.retained_lo);
    const span = high >= lo ? high - lo + 1n : 1n;
    const done = replayed >= lo ? replayed - lo + 1n : 0n;
    const remaining = high > replayed ? high - replayed : 0n;
    const progressPercent = span > 0n
      ? Math.min(100, Math.max(0, Number((done * 100n) / span)))
      : 100;
    let etaMs = 0;
    if (row.started_at !== null && done > 0n && remaining > 0n) {
      const elapsed = Math.max(0, now - row.started_at.getTime());
      if (elapsed > 0) {
        const estimate = (remaining * BigInt(elapsed)) / done;
        etaMs = estimate > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER : Number(estimate);
      }
    }
    return Object.freeze({
      aggregateScope: row.aggregate_scope,
      generation: row.generation,
      capturedHighCommitOrdinal: row.captured_high,
      replayedCommitOrdinal: row.replayed,
      retentionFloorCommitOrdinal: row.retention_floor,
      startedAt: row.started_at === null ? null : row.started_at.toISOString(),
      progressPercent,
      etaMs,
      gap: row.gap,
    });
  }));
}

function mapWatermark(row: WatermarkRow): SocialFeedWatermark {
  return Object.freeze({ aggregateScope: row.aggregate_scope, projectionState: row.projection_state,
    lastCommitOrdinal: row.last_commit_ordinal, lastSourceEventId: row.last_source_event_id,
    rebuildGeneration: BigInt(row.rebuild_generation),
    rebuildHighCommitOrdinal: row.rebuild_high_commit_ordinal,
    rebuildReplayedCommitOrdinal: row.rebuild_replayed_commit_ordinal,
    rebuildStartedAt: row.rebuild_started_at,
    stateRevision: BigInt(row.state_revision), stateUpdatedAt: row.state_updated_at });
}

function assertScope(value: string): void {
  if (value.length < 1 || value.length > SOCIAL_IDENTITY_MAX_LENGTH || value.trim() !== value) {
    throw new TypeError('Feed operations aggregate scope is invalid');
  }
}

import type { SocialFeedProjectionRepository, SocialFeedWatermark } from './feed-projection-repository.js';
import type { SocialFeedWorkerRepository } from './feed-worker.js';
import { rebuildSocialFeedProjection } from './feed-worker.js';

export interface FeedOperationsConfig {
  readonly queueAgeNotReadyMs: number;
  readonly queueBacklogNotReady: number;
  readonly deadLetterNotReady: number;
  /** Age at which an in-progress fan-out continuation is treated as stale. */
  readonly fanoutProgressAgeNotReadyMs: number;
  readonly withdrawalBacklogNotReady: number;
  /** Retained-event page size per rebuild batch; never a scope-wide total cap. */
  readonly rebuildMaxEvents: number;
  readonly rebuildMaxRecipientsPerEvent: number;
  readonly rebuildMaxTotalRecipients: number;
  readonly rebuildTimeoutMs: number;
  readonly purgeBatchSize: number;
  readonly retentionDays: number;
}

export interface FeedWorkerCapacity {
  readonly workerConcurrency: number;
  readonly workerBatchSize: number;
  readonly workerLeaseDurationMs: number;
  readonly workerHandlerTimeoutMs: number;
}

export interface FeedFanoutOperationsStatus {
  readonly progressBacklog: number;
  readonly oldestProgressAgeMs: number;
  readonly candidateCount: number;
  readonly orphanProgressCount: number;
  readonly reverseInconsistencyCount: number;
  readonly withdrawalBacklog: number;
}

/** Durable per-scope rebuild continuation progress; scope ids are ops-owned, never metric labels. */
export interface FeedRebuildProgress {
  readonly aggregateScope: string;
  readonly generation: string;
  readonly capturedHighCommitOrdinal: string;
  readonly replayedCommitOrdinal: string;
  /** Inclusive physical-source absence authority observed by status. */
  readonly retentionFloorCommitOrdinal: string;
  readonly startedAt: string | null;
  readonly progressPercent: number;
  readonly etaMs: number;
  /** True when captured source above the retention floor is missing or unresolved. */
  readonly gap: boolean;
}

export interface FeedOperationsStatus {
  readonly dependency: 'available' | 'unavailable';
  readonly worker: 'running' | 'idle' | 'stopped' | 'unknown';
  readonly readyCount: number;
  readonly retryCount: number;
  readonly leasedCount: number;
  readonly deadLetterCount: number;
  readonly oldestEligibleAgeMs: number;
  readonly oldestDeadLetterAgeMs: number;
  readonly rebuildingScopeCount: number;
  readonly sourceHighCommitOrdinal: string;
  readonly watermarkHighCommitOrdinal: string;
  readonly maximumCommitLag: string;
  readonly deadLetterCategories: Readonly<{
    unknownFutureVersion: number;
    invalidContract: number;
    retryExhausted: number;
    dependency: number;
    other: number;
  }>;
  readonly rebuilds: ReadonlyArray<FeedRebuildProgress>;
  readonly fanout: FeedFanoutOperationsStatus;
}

export interface FeedScopeEvidence {
  readonly watermark: SocialFeedWatermark;
  readonly itemIds: readonly string[];
}

export interface FeedDeadLetterReplayResult {
  readonly outboxIds: readonly string[];
}

export interface FeedOperationsRepository {
  inspectStatus(): Promise<FeedOperationsStatus>;
  captureScope(aggregateScope: string): Promise<FeedScopeEvidence>;
  replayDeadLetters(input: { readonly aggregateScope: string; readonly limit: number;
    readonly allowUnknownFutureVersion?: boolean }): Promise<FeedDeadLetterReplayResult>;
}

export interface FeedOperationsMetrics {
  gauge(name: string, value: number): void;
  increment?(name: string, value?: number): void;
}

export type FeedCapabilityReadiness = Readonly<{
  capability: 'feed';
  status: 'ready' | 'not-ready';
  reason: 'none' | 'dependency_unavailable' | 'worker_unavailable' | 'queue_age'
    | 'backlog' | 'dead_letter' | 'stale_progress' | 'withdrawal_backlog'
    | 'fanout_inconsistency';
}>;

export function assertFeedOperationsConfig(
  config: FeedOperationsConfig,
  capacity: FeedWorkerCapacity,
): void {
  bounded(config.queueAgeNotReadyMs, 'queueAgeNotReadyMs', 86_400_000);
  bounded(config.queueBacklogNotReady, 'queueBacklogNotReady', 1_000_000);
  bounded(config.deadLetterNotReady, 'deadLetterNotReady', 1_000_000);
  bounded(config.fanoutProgressAgeNotReadyMs, 'fanoutProgressAgeNotReadyMs', 86_400_000);
  bounded(config.withdrawalBacklogNotReady, 'withdrawalBacklogNotReady', 1_000_000);
  bounded(config.rebuildMaxEvents, 'rebuildMaxEvents', 10_000);
  bounded(config.rebuildMaxRecipientsPerEvent, 'rebuildMaxRecipientsPerEvent', 1_000);
  bounded(config.rebuildMaxTotalRecipients, 'rebuildMaxTotalRecipients', 1_000_000);
  bounded(config.rebuildTimeoutMs, 'rebuildTimeoutMs', 3_600_000);
  bounded(config.purgeBatchSize, 'purgeBatchSize', 10_000);
  bounded(config.retentionDays, 'retentionDays', 3650);
  if (config.retentionDays !== 90) {
    throw new RangeError('retentionDays must match the production 90-day Feed source window');
  }
  if (config.rebuildMaxTotalRecipients < config.rebuildMaxRecipientsPerEvent) {
    throw new RangeError('rebuildMaxTotalRecipients must cover one configured recipient page');
  }
  bounded(capacity.workerConcurrency, 'workerConcurrency', 64);
  bounded(capacity.workerBatchSize, 'workerBatchSize', 64);
  bounded(capacity.workerLeaseDurationMs, 'workerLeaseDurationMs', 3_600_000);
  bounded(capacity.workerHandlerTimeoutMs, 'workerHandlerTimeoutMs', 3_600_000);
  if (capacity.workerBatchSize > capacity.workerConcurrency
      || capacity.workerHandlerTimeoutMs > capacity.workerLeaseDurationMs
      || config.rebuildTimeoutMs > capacity.workerLeaseDurationMs) {
    throw new RangeError('Feed operations capacity is incoherent with worker lease capacity');
  }
}

export function evaluateFeedCapabilityReadiness(
  status: FeedOperationsStatus,
  config: FeedOperationsConfig,
): FeedCapabilityReadiness {
  const reason = status.dependency === 'unavailable' ? 'dependency_unavailable'
    : status.worker !== 'running' ? 'worker_unavailable'
      : status.deadLetterCount >= config.deadLetterNotReady ? 'dead_letter'
        : status.fanout.orphanProgressCount > 0
          || status.fanout.reverseInconsistencyCount > 0 ? 'fanout_inconsistency'
          : status.fanout.progressBacklog > 0
            && status.fanout.oldestProgressAgeMs >= config.fanoutProgressAgeNotReadyMs
            ? 'stale_progress'
            : status.fanout.withdrawalBacklog >= config.withdrawalBacklogNotReady
              ? 'withdrawal_backlog'
              : status.oldestEligibleAgeMs >= config.queueAgeNotReadyMs ? 'queue_age'
                : status.readyCount + status.retryCount >= config.queueBacklogNotReady
                  ? 'backlog' : 'none';
  return Object.freeze({ capability: 'feed', status: reason === 'none' ? 'ready' : 'not-ready', reason });
}

export function publishFeedOperationsMetrics(
  status: FeedOperationsStatus,
  metrics: FeedOperationsMetrics,
): void {
  metrics.gauge('feed.queue.ready', status.readyCount);
  metrics.gauge('feed.queue.retry', status.retryCount);
  metrics.gauge('feed.queue.leased', status.leasedCount);
  metrics.gauge('feed.queue.dead_letter', status.deadLetterCount);
  metrics.gauge('feed.queue.oldest_eligible_age_ms', status.oldestEligibleAgeMs);
  metrics.gauge('feed.queue.oldest_dead_letter_age_ms', status.oldestDeadLetterAgeMs);
  metrics.gauge('feed.queue.dead_letter.unknown_future_version',
    status.deadLetterCategories.unknownFutureVersion);
  metrics.gauge('feed.queue.dead_letter.invalid_contract', status.deadLetterCategories.invalidContract);
  metrics.gauge('feed.queue.dead_letter.retry_exhausted', status.deadLetterCategories.retryExhausted);
  metrics.gauge('feed.queue.dead_letter.dependency', status.deadLetterCategories.dependency);
  metrics.gauge('feed.queue.dead_letter.other', status.deadLetterCategories.other);
  metrics.gauge('feed.projection.rebuilding_scopes', status.rebuildingScopeCount);
  metrics.gauge('feed.projection.rebuild_gap_scopes',
    status.rebuilds.filter((entry) => entry.gap).length);
  metrics.gauge('feed.projection.source_high_commit_ordinal', metricOrdinal(status.sourceHighCommitOrdinal));
  metrics.gauge('feed.projection.watermark_high_commit_ordinal', metricOrdinal(status.watermarkHighCommitOrdinal));
  metrics.gauge('feed.projection.maximum_commit_lag', metricOrdinal(status.maximumCommitLag));
  metrics.gauge('feed.worker.running', status.worker === 'running' || status.worker === 'idle' ? 1 : 0);
  metrics.gauge('feed.dependency.available', status.dependency === 'available' ? 1 : 0);
  metrics.gauge('feed.fanout.progress_backlog', status.fanout.progressBacklog);
  metrics.gauge('feed.fanout.oldest_progress_age_ms', status.fanout.oldestProgressAgeMs);
  metrics.gauge('feed.fanout.candidate_count', status.fanout.candidateCount);
  metrics.gauge('feed.fanout.withdrawal_backlog', status.fanout.withdrawalBacklog);
  metrics.gauge('feed.fanout.orphan_progress', status.fanout.orphanProgressCount);
  metrics.gauge('feed.fanout.reverse_inconsistency', status.fanout.reverseInconsistencyCount);
}

/** Low-cardinality fan-out disposition counters; never label recipient/profile/event ids. */
export function recordFeedFanoutDisposition(
  metrics: { readonly increment: (name: string, value?: number) => void } | undefined,
  disposition: 'applied' | 'continued' | 'lease_lost' | 'obsolete',
): void {
  if (!metrics) return;
  switch (disposition) {
    case 'continued':
      metrics.increment('feed.fanout.slice_applied');
      metrics.increment('feed.fanout.continued');
      break;
    case 'applied':
      metrics.increment('feed.fanout.slice_applied');
      metrics.increment('feed.fanout.completed');
      break;
    case 'lease_lost':
      metrics.increment('feed.fanout.lease_lost');
      break;
    case 'obsolete':
      break;
  }
}

export async function rebuildFeedScopeForOperations(input: {
  readonly aggregateScope: string;
  readonly operations: FeedOperationsRepository;
  readonly worker: SocialFeedWorkerRepository;
  readonly config: FeedOperationsConfig;
}): Promise<Readonly<{ beforeWatermark: SocialFeedWatermark; beforeItemIds: readonly string[];
  afterWatermark: SocialFeedWatermark; afterItemIds: readonly string[];
  eventCount: number; itemCount: number; highCommitOrdinal: string }>> {
  const before = await input.operations.captureScope(input.aggregateScope);
  const signal = AbortSignal.timeout(input.config.rebuildTimeoutMs);
  const result = await rebuildSocialFeedProjection({ repository: input.worker,
    aggregateScope: input.aggregateScope, maxEvents: input.config.rebuildMaxEvents,
    maxRecipientsPerEvent: input.config.rebuildMaxRecipientsPerEvent,
    maxTotalRecipients: input.config.rebuildMaxTotalRecipients, signal });
  const after = await input.operations.captureScope(input.aggregateScope);
  if (BigInt(after.watermark.lastCommitOrdinal) < BigInt(before.watermark.lastCommitOrdinal)) {
    throw new Error('Feed rebuild watermark regressed');
  }
  return Object.freeze({ beforeWatermark: before.watermark, beforeItemIds: before.itemIds,
    afterWatermark: after.watermark, afterItemIds: after.itemIds, ...result });
}

export async function replayFeedDeadLettersForOperations(input: {
  readonly operations: FeedOperationsRepository;
  readonly aggregateScope: string;
  readonly limit: number;
  readonly allowUnknownFutureVersion?: boolean;
}): Promise<Readonly<{ beforeWatermark: SocialFeedWatermark; beforeItemIds: readonly string[];
  afterWatermark: SocialFeedWatermark; afterItemIds: readonly string[];
  outboxIds: readonly string[] }>> {
  const before = await input.operations.captureScope(input.aggregateScope);
  const replayed = await input.operations.replayDeadLetters({
    aggregateScope: input.aggregateScope, limit: input.limit,
    ...(input.allowUnknownFutureVersion === undefined
      ? {} : { allowUnknownFutureVersion: input.allowUnknownFutureVersion }),
  });
  const after = await input.operations.captureScope(input.aggregateScope);
  return Object.freeze({ beforeWatermark: before.watermark, beforeItemIds: before.itemIds,
    afterWatermark: after.watermark, afterItemIds: after.itemIds,
    outboxIds: replayed.outboxIds });
}

export async function purgeFeedRetentionForOperations(input: {
  readonly projection: SocialFeedProjectionRepository;
  readonly operations: FeedOperationsRepository;
  readonly aggregateScope: string;
  readonly cutoff: Date;
  readonly config: FeedOperationsConfig;
}): Promise<Readonly<{ beforeWatermark: SocialFeedWatermark; beforeItemIds: readonly string[];
  afterWatermark: SocialFeedWatermark; afterItemIds: readonly string[];
  deletedCount: number; deletedItemIds: readonly string[] }>> {
  const before = await input.operations.captureScope(input.aggregateScope);
  const result = await input.projection.purgeExpiredItems({ cutoff: input.cutoff,
    limit: input.config.purgeBatchSize, aggregateScope: input.aggregateScope });
  const after = await input.operations.captureScope(input.aggregateScope);
  if (BigInt(after.watermark.lastCommitOrdinal) < BigInt(before.watermark.lastCommitOrdinal)) {
    throw new Error('Feed retention purge watermark regressed');
  }
  return Object.freeze({ beforeWatermark: before.watermark, beforeItemIds: before.itemIds,
    afterWatermark: after.watermark, afterItemIds: after.itemIds,
    deletedCount: result.deletedCount, deletedItemIds: result.feedItemIds });
}

function metricOrdinal(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return 0;
  const parsed = BigInt(value);
  return Number(parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : parsed);
}

function bounded(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be between 1 and ${max}`);
  }
}

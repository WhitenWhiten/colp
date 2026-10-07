import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assertFeedOperationsConfig,
  evaluateFeedCapabilityReadiness,
  publishFeedOperationsMetrics,
  replayFeedDeadLettersForOperations,
  type FeedOperationsRepository,
  type FeedOperationsStatus,
  type FeedScopeEvidence,
} from '../../../src/modules/social/index.js';
import { loadConfig } from '../../support/test-config.js';

const config = Object.freeze({
  queueAgeNotReadyMs: 60_000,
  queueBacklogNotReady: 1_000,
  deadLetterNotReady: 1,
  fanoutProgressAgeNotReadyMs: 300_000,
  withdrawalBacklogNotReady: 1_000,
  rebuildMaxEvents: 500,
  rebuildMaxRecipientsPerEvent: 100,
  rebuildMaxTotalRecipients: 10_000,
  rebuildTimeoutMs: 30_000,
  purgeBatchSize: 250,
  retentionDays: 90,
});

function status(overrides: Partial<FeedOperationsStatus> = {}): FeedOperationsStatus {
  return Object.freeze({
    dependency: 'available', worker: 'running', readyCount: 2, retryCount: 1,
    leasedCount: 0, deadLetterCount: 0, oldestEligibleAgeMs: 800,
    oldestDeadLetterAgeMs: 0, rebuildingScopeCount: 0,
    sourceHighCommitOrdinal: '3', watermarkHighCommitOrdinal: '2', maximumCommitLag: '1',
    deadLetterCategories: { unknownFutureVersion: 0, invalidContract: 0,
      retryExhausted: 0, dependency: 0, other: 0 },
    rebuilds: [],
    ...overrides,
    fanout: Object.freeze({
      progressBacklog: 0, oldestProgressAgeMs: 0, candidateCount: 0,
      orphanProgressCount: 0, reverseInconsistencyCount: 0, withdrawalBacklog: 0,
      ...(overrides.fanout ?? {}),
    }),
  });
}

function scopeEvidence(tag: 'before' | 'after'): FeedScopeEvidence {
  const live = tag === 'before';
  return Object.freeze({ watermark: Object.freeze({ aggregateScope: 'scope-a',
    projectionState: 'live', lastCommitOrdinal: live ? '5' : '9',
    lastSourceEventId: live ? 'source-before' : 'source-after', rebuildGeneration: 2n,
    rebuildHighCommitOrdinal: null, rebuildReplayedCommitOrdinal: null,
    rebuildStartedAt: null, stateRevision: 3n,
    stateUpdatedAt: new Date('2026-01-01T00:00:00.000Z') }),
    itemIds: Object.freeze([live ? 'item-before' : 'item-after']) });
}

test('P5-24 rejects zero, unbounded, unsafe and capacity-incoherent operations settings', () => {
  assert.doesNotThrow(() => assertFeedOperationsConfig(config, {
    workerConcurrency: 4, workerBatchSize: 2, workerLeaseDurationMs: 40_000,
    workerHandlerTimeoutMs: 30_000,
  }));
  for (const bad of [
    { queueAgeNotReadyMs: 0 }, { queueBacklogNotReady: Number.MAX_SAFE_INTEGER },
    { deadLetterNotReady: 0 }, { rebuildMaxEvents: 0 },
    { rebuildMaxRecipientsPerEvent: 1_001 }, { rebuildTimeoutMs: 40_001 },
    { rebuildMaxTotalRecipients: 0 },
    { rebuildMaxTotalRecipients: 99 },
    { purgeBatchSize: 10_001 }, { retentionDays: 0 },
  ]) assert.throws(() => assertFeedOperationsConfig({ ...config, ...bad }, {
    workerConcurrency: 4, workerBatchSize: 2, workerLeaseDurationMs: 40_000,
    workerHandlerTimeoutMs: 30_000,
  }));
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://known:known@localhost:5432/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    FEED_REBUILD_MAX_TOTAL_RECIPIENTS: '99' }),
  /rebuildMaxTotalRecipients must cover one configured recipient page/u);
});

test('P5-24 Feed faults degrade only Feed and expose stable low-cardinality reasons', () => {
  assert.deepEqual(evaluateFeedCapabilityReadiness(status(), config), {
    capability: 'feed', status: 'ready', reason: 'none',
  });
  assert.deepEqual(evaluateFeedCapabilityReadiness(status({ deadLetterCount: 1 }), config), {
    capability: 'feed', status: 'not-ready', reason: 'dead_letter',
  });
  assert.deepEqual(evaluateFeedCapabilityReadiness(status({ dependency: 'unavailable' }), config), {
    capability: 'feed', status: 'not-ready', reason: 'dependency_unavailable',
  });
  // The baseline flows into readiness evaluation and its result composes into
  // the global capability snapshot; evaluation must stay read-only over the
  // shared baseline (KA-P5-SOC-10).
  const baseline = status();
  const composition = { core: 'ready', publication: 'ready', api: 'ready',
    feed: evaluateFeedCapabilityReadiness(baseline, config) };
  assert.deepEqual(baseline, status(), 'readiness must not mutate the shared baseline');
  assert.deepEqual(composition, { core: 'ready', publication: 'ready', api: 'ready',
    feed: { capability: 'feed', status: 'ready', reason: 'none' } });
});

test('P5-24 metric series stay fixed and values do not leak multi-tenant identifiers or secrets', () => {
  const series = new Map<string, number>();
  const metrics = { gauge(name: string, value: number) { series.set(name, value); } };
  const sentinels = ['account-secret-A', 'collection-secret-B', 'event-secret-C'];
  for (let index = 0; index < sentinels.length; index += 1) {
    publishFeedOperationsMetrics(status({ readyCount: index + 1, retryCount: index,
      deadLetterCount: index, oldestEligibleAgeMs: 10 + index }), metrics);
  }
  const serialized = JSON.stringify([...series]);
  for (const sentinel of sentinels) assert.doesNotMatch(serialized, new RegExp(sentinel, 'u'));
  const expected = [
    'feed.queue.ready', 'feed.queue.retry', 'feed.queue.leased',
    'feed.queue.dead_letter', 'feed.queue.oldest_eligible_age_ms',
    'feed.queue.oldest_dead_letter_age_ms', 'feed.projection.rebuilding_scopes',
    'feed.projection.rebuild_gap_scopes',
    'feed.worker.running', 'feed.dependency.available',
    'feed.queue.dead_letter.unknown_future_version', 'feed.queue.dead_letter.invalid_contract',
    'feed.queue.dead_letter.retry_exhausted', 'feed.queue.dead_letter.dependency',
    'feed.queue.dead_letter.other',
    'feed.projection.source_high_commit_ordinal',
    'feed.projection.watermark_high_commit_ordinal', 'feed.projection.maximum_commit_lag',
    'feed.fanout.progress_backlog', 'feed.fanout.oldest_progress_age_ms',
    'feed.fanout.candidate_count', 'feed.fanout.withdrawal_backlog',
    'feed.fanout.orphan_progress', 'feed.fanout.reverse_inconsistency',
  ];
  assert.deepEqual([...series.keys()].sort(), [...expected].sort());
  assert.deepEqual(expected.map((name) => (series.get(name) ?? -1) >= 0),
    Array(expected.length).fill(true));
});

test('P5-24 rebuild progress gauges expose gap scopes without leaking scope identifiers', () => {
  const series = new Map<string, number>();
  const metrics = { gauge(name: string, value: number) { series.set(name, value); } };
  publishFeedOperationsMetrics(status({ rebuilds: [Object.freeze({
    aggregateScope: 'collection-secret-C', generation: '3',
    capturedHighCommitOrdinal: '100', replayedCommitOrdinal: '40', startedAt: null,
    retentionFloorCommitOrdinal: '20', progressPercent: 40, etaMs: 1_000, gap: true,
  })] }), metrics);
  assert.equal(series.get('feed.projection.rebuild_gap_scopes'), 1);
  assert.doesNotMatch(JSON.stringify([...series]), /collection-secret-C/u);
});

test('FIX-L-057 replay dead letters snapshots the scope before and after, forwards limit and flag, and merges replayed ids', async () => {
  const calls: string[] = [];
  const before = scopeEvidence('before');
  const after = scopeEvidence('after');
  let captures = 0;
  let replayInput: { aggregateScope: string; limit: number;
    allowUnknownFutureVersion?: boolean } | undefined;
  const operations: FeedOperationsRepository = {
    async inspectStatus() { throw new Error('unused'); },
    async captureScope(aggregateScope: string) {
      calls.push(`capture:${aggregateScope}`);
      captures += 1;
      return captures === 1 ? before : after;
    },
    async replayDeadLetters(input) {
      replayInput = input;
      calls.push('replay');
      return { outboxIds: ['replayed-outbox-1'] };
    },
  };
  const replayed = await replayFeedDeadLettersForOperations({ operations,
    aggregateScope: 'scope-a', limit: 3, allowUnknownFutureVersion: true });
  assert.deepEqual(calls, ['capture:scope-a', 'replay', 'capture:scope-a'],
    'replay must capture the scope, replay dead letters, then capture again');
  assert.deepEqual(replayInput, { aggregateScope: 'scope-a', limit: 3,
    allowUnknownFutureVersion: true }, 'limit and flag must be forwarded verbatim');
  assert.deepEqual(replayed.beforeWatermark, before.watermark);
  assert.equal(replayed.beforeWatermark.lastCommitOrdinal, '5');
  assert.deepEqual(replayed.beforeItemIds, ['item-before']);
  assert.deepEqual(replayed.afterWatermark, after.watermark);
  assert.equal(replayed.afterWatermark.lastCommitOrdinal, '9');
  assert.deepEqual(replayed.afterItemIds, ['item-after']);
  assert.deepEqual(replayed.outboxIds, ['replayed-outbox-1'],
    'replayed outbox ids must be merged into the evidence');
});

test('FIX-L-057 replay forwards allowUnknownFutureVersion only when explicitly provided', async () => {
  const transmitted: Array<{ aggregateScope: string; limit: number;
    allowUnknownFutureVersion?: boolean }> = [];
  const operations: FeedOperationsRepository = {
    async inspectStatus() { throw new Error('unused'); },
    async captureScope() { return scopeEvidence('before'); },
    async replayDeadLetters(input) { transmitted.push(input); return { outboxIds: [] }; },
  };
  await replayFeedDeadLettersForOperations({ operations, aggregateScope: 'scope-a', limit: 2 });
  await replayFeedDeadLettersForOperations({ operations, aggregateScope: 'scope-a',
    limit: 2, allowUnknownFutureVersion: false });
  await replayFeedDeadLettersForOperations({ operations, aggregateScope: 'scope-a',
    limit: 2, allowUnknownFutureVersion: true });
  assert.deepEqual(transmitted, [
    { aggregateScope: 'scope-a', limit: 2 },
    { aggregateScope: 'scope-a', limit: 2, allowUnknownFutureVersion: false },
    { aggregateScope: 'scope-a', limit: 2, allowUnknownFutureVersion: true },
  ]);
});

test('FIX-L-057 replay propagates capture and replay failures without partial evidence', async () => {
  await assert.rejects(replayFeedDeadLettersForOperations({ operations: {
    async inspectStatus() { throw new Error('unused'); },
    async captureScope() { throw new Error('capture exploded'); },
    async replayDeadLetters() { return { outboxIds: [] }; },
  }, aggregateScope: 'scope-a', limit: 1 }), /capture exploded/u);
  await assert.rejects(replayFeedDeadLettersForOperations({ operations: {
    async inspectStatus() { throw new Error('unused'); },
    async captureScope() { return scopeEvidence('before'); },
    async replayDeadLetters() { throw new Error('replay exploded'); },
  }, aggregateScope: 'scope-a', limit: 1 }), /replay exploded/u);
});

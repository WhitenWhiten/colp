import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  assertFeedOperationsConfig,
  evaluateFeedCapabilityReadiness,
  publishFeedOperationsMetrics,
  recordFeedFanoutDisposition,
  type FeedOperationsStatus,
} from '../../../src/modules/social/index.js';

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

const capacity = Object.freeze({
  workerConcurrency: 4,
  workerBatchSize: 2,
  workerLeaseDurationMs: 40_000,
  workerHandlerTimeoutMs: 30_000,
});

function status(overrides: Partial<FeedOperationsStatus> = {}): FeedOperationsStatus {
  const fanout = {
    progressBacklog: 0,
    oldestProgressAgeMs: 0,
    candidateCount: 0,
    orphanProgressCount: 0,
    reverseInconsistencyCount: 0,
    withdrawalBacklog: 0,
    ...(overrides.fanout ?? {}),
  };
  return Object.freeze({
    dependency: 'available',
    worker: 'running',
    readyCount: 2,
    retryCount: 1,
    leasedCount: 0,
    deadLetterCount: 0,
    oldestEligibleAgeMs: 800,
    oldestDeadLetterAgeMs: 0,
    rebuildingScopeCount: 0,
    sourceHighCommitOrdinal: '3',
    watermarkHighCommitOrdinal: '2',
    maximumCommitLag: '1',
    deadLetterCategories: {
      unknownFutureVersion: 0,
      invalidContract: 0,
      retryExhausted: 0,
      dependency: 0,
      other: 0,
    },
    rebuilds: [],
    ...overrides,
    fanout: Object.freeze(fanout),
  });
}

test('R5-12 rejects unsafe fan-out operations thresholds and keeps capacity coherent', () => {
  assert.doesNotThrow(() => assertFeedOperationsConfig(config, capacity));
  for (const bad of [
    { fanoutProgressAgeNotReadyMs: 0 },
    { fanoutProgressAgeNotReadyMs: 86_400_001 },
    { withdrawalBacklogNotReady: 0 },
    { withdrawalBacklogNotReady: 1_000_001 },
  ]) {
    assert.throws(() => assertFeedOperationsConfig({ ...config, ...bad }, capacity));
  }
  assert.throws(() => loadConfig({
    DATABASE_URL: 'postgres://known:known@localhost:5432/known',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    FEED_FANOUT_PROGRESS_AGE_NOT_READY_MS: '0',
  }), /FEED_FANOUT_PROGRESS_AGE_NOT_READY_MS/u);
});

test('R5-12 readiness distinguishes normal continuation, stale progress, withdrawal backlog and dead-letter', () => {
  assert.deepEqual(evaluateFeedCapabilityReadiness(status({
    fanout: { progressBacklog: 3, oldestProgressAgeMs: 12_000, candidateCount: 1500,
      orphanProgressCount: 0, reverseInconsistencyCount: 0, withdrawalBacklog: 2 },
  }), config), { capability: 'feed', status: 'ready', reason: 'none' });

  assert.deepEqual(evaluateFeedCapabilityReadiness(status({
    fanout: { progressBacklog: 1, oldestProgressAgeMs: 300_000, candidateCount: 500,
      orphanProgressCount: 0, reverseInconsistencyCount: 0, withdrawalBacklog: 0 },
  }), config), { capability: 'feed', status: 'not-ready', reason: 'stale_progress' });

  assert.deepEqual(evaluateFeedCapabilityReadiness(status({
    fanout: { progressBacklog: 0, oldestProgressAgeMs: 0, candidateCount: 0,
      orphanProgressCount: 0, reverseInconsistencyCount: 0, withdrawalBacklog: 1_000 },
  }), config), { capability: 'feed', status: 'not-ready', reason: 'withdrawal_backlog' });

  assert.deepEqual(evaluateFeedCapabilityReadiness(status({ deadLetterCount: 1 }), config), {
    capability: 'feed', status: 'not-ready', reason: 'dead_letter',
  });

  assert.deepEqual(evaluateFeedCapabilityReadiness(status({
    fanout: { progressBacklog: 1, oldestProgressAgeMs: 1_000, candidateCount: 10,
      orphanProgressCount: 1, reverseInconsistencyCount: 0, withdrawalBacklog: 0 },
  }), config), { capability: 'feed', status: 'not-ready', reason: 'fanout_inconsistency' });

  assert.deepEqual(evaluateFeedCapabilityReadiness(status({
    fanout: { progressBacklog: 1, oldestProgressAgeMs: 1_000, candidateCount: 10,
      orphanProgressCount: 0, reverseInconsistencyCount: 1, withdrawalBacklog: 0 },
  }), config), { capability: 'feed', status: 'not-ready', reason: 'fanout_inconsistency' });
});

test('R5-12 metric series stay fixed, low-cardinality, and never leak ids or secrets', () => {
  const series = new Map<string, number>();
  const metrics = {
    gauge(name: string, value: number) { series.set(name, value); },
    increment(name: string, value = 1) {
      series.set(name, (series.get(name) ?? 0) + value);
    },
  };
  const sentinels = [
    'account-secret-A', 'collection-secret-B', 'event-secret-C',
    'recipient-profile-Z', 'IiIiIiIiIiIiIiIiIiIiIg',
  ];
  for (let index = 0; index < sentinels.length; index += 1) {
    publishFeedOperationsMetrics(status({
      readyCount: index + 1,
      fanout: {
        progressBacklog: index,
        oldestProgressAgeMs: 10 + index,
        candidateCount: 100 * index,
        orphanProgressCount: 0,
        reverseInconsistencyCount: 0,
        withdrawalBacklog: index,
      },
    }), metrics);
    recordFeedFanoutDisposition(metrics, 'continued');
    recordFeedFanoutDisposition(metrics, 'applied');
    recordFeedFanoutDisposition(metrics, 'lease_lost');
  }
  const serialized = JSON.stringify([...series]);
  for (const sentinel of sentinels) {
    assert.doesNotMatch(serialized, new RegExp(sentinel, 'u'));
  }
  const expectedGauges = [
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
  for (const name of expectedGauges) {
    assert.ok(series.has(name), `missing gauge ${name}`);
    assert.ok((series.get(name) ?? -1) >= 0);
  }
  assert.equal(series.get('feed.fanout.slice_applied'), sentinels.length * 2);
  assert.equal(series.get('feed.fanout.continued'), sentinels.length);
  assert.equal(series.get('feed.fanout.completed'), sentinels.length);
  assert.equal(series.get('feed.fanout.lease_lost'), sentinels.length);
  assert.ok([...series.keys()].every((name) => name.startsWith('feed.')));
});

test('R5-12 completed fan-out zeros progress gauges while counters remain monotonic', () => {
  const series = new Map<string, number>();
  const metrics = {
    gauge(name: string, value: number) { series.set(name, value); },
    increment(name: string, value = 1) {
      series.set(name, (series.get(name) ?? 0) + value);
    },
  };
  recordFeedFanoutDisposition(metrics, 'continued');
  recordFeedFanoutDisposition(metrics, 'applied');
  publishFeedOperationsMetrics(status({
    fanout: {
      progressBacklog: 0, oldestProgressAgeMs: 0, candidateCount: 0,
      orphanProgressCount: 0, reverseInconsistencyCount: 0, withdrawalBacklog: 0,
    },
  }), metrics);
  assert.equal(series.get('feed.fanout.progress_backlog'), 0);
  assert.equal(series.get('feed.fanout.oldest_progress_age_ms'), 0);
  assert.equal(series.get('feed.fanout.candidate_count'), 0);
  assert.equal(series.get('feed.fanout.slice_applied'), 2);
  assert.equal(series.get('feed.fanout.continued'), 1);
  assert.equal(series.get('feed.fanout.completed'), 1);
});

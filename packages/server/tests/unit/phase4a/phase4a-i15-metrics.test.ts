/**
 * P4A-I15 metrics contract: fixed-label schema and bounded store.
 *
 * Proves:
 *  - the metric label vocabularies are FIXED, frozen, and non-empty;
 *  - `recordAttachmentMetric` accepts only fixed operation/state/errorClass/
 *    sizeBucket/latencyBucket values — any other value throws, so metric
 *    cardinality can never grow with keys/blobs/principals/filenames/
 *    digests/URLs;
 *  - the snapshot contains only the fixed label keys and fixed gauge names
 *    (never key/blob/principal/filename/digest/URL fields) and the counter
 *    space is bounded by the fixed label product;
 *  - gauges are fixed-name only and unknown gauge names throw;
 *  - backlog samples are kept in a bounded ring (oldest dropped) and are
 *    returned in time order;
 *  - a synthetic secret marker recorded in a metric value never appears in
 *    the snapshot serialization.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ATTACHMENT_GAUGE_NAMES,
  ATTACHMENT_METRIC_ERROR_CLASSES,
  ATTACHMENT_METRIC_LATENCY_BUCKETS,
  ATTACHMENT_METRIC_OPERATIONS,
  ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS,
  ATTACHMENT_METRIC_SIZE_BUCKETS,
  ATTACHMENT_METRIC_STATES,
  createAttachmentMetricsStore,
  recordAttachmentMetric,
  snapshotAttachmentMetrics,
  type AttachmentMetricLabels,
} from '../../../src/modules/attachments/index.js';

function labels(overrides: Partial<AttachmentMetricLabels> = {}): AttachmentMetricLabels {
  return {
    operation: 'verify',
    state: 'ok',
    errorClass: 'none',
    sizeBucket: 'under_1mib',
    latencyBucket: 'under_1s',
    rateLimitDecision: 'none',
    ...overrides,
  };
}

describe('P4A-I15 metrics: fixed-label schema', () => {
  test('every label vocabulary is a frozen, non-empty, fixed allowlist', () => {
    for (const list of [
      ATTACHMENT_METRIC_OPERATIONS,
      ATTACHMENT_METRIC_STATES,
      ATTACHMENT_METRIC_ERROR_CLASSES,
      ATTACHMENT_METRIC_SIZE_BUCKETS,
      ATTACHMENT_METRIC_LATENCY_BUCKETS,
      ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS,
      ATTACHMENT_GAUGE_NAMES,
    ] as const) {
      assert.ok(Object.isFrozen(list), 'the allowlist must be frozen');
      assert.ok(list.length > 0, 'the allowlist must be non-empty');
      assert.equal(new Set(list).size, list.length, 'the allowlist must not contain duplicates');
    }
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('issue'));
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('complete'));
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('verify'));
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('cleanup'));
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('deliver'));
    // P4A-RL01 additions: the five admission routes + DB query latency.
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('status'));
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('finalize'));
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('download'));
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes('query'));
    assert.ok(ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS.includes('allowed'));
    assert.ok(ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS.includes('denied'));
  });

  test('recording with any label value outside the fixed allowlist throws (cardinality bounded)', () => {
    const store = createAttachmentMetricsStore();
    const base = labels();
    assert.throws(() => recordAttachmentMetric(store, { ...base, operation: 'issuance' as never }), /not_a_fixed/);
    assert.throws(() => recordAttachmentMetric(store, { ...base, state: 'processing' as never }), /not_a_fixed/);
    assert.throws(() => recordAttachmentMetric(store, { ...base, errorClass: 'provider_sdk_bug' as never }), /not_a_fixed/);
    assert.throws(() => recordAttachmentMetric(store, { ...base, sizeBucket: '10GiB' as never }), /not_a_fixed/);
    assert.throws(() => recordAttachmentMetric(store, { ...base, latencyBucket: 'three_minutes' as never }), /not_a_fixed/);
    // P4A-RL01: the rate-limit decision dimension is fixed as well.
    assert.throws(() => recordAttachmentMetric(store, { ...base, rateLimitDecision: 'shadow' as never }), /not_a_fixed/);
    assert.throws(() => recordAttachmentMetric(store, { ...base, blobId: 'blob-x' } as never), /not_a_fixed/);
    // An unknown record key (not a label) must also throw.
    assert.throws(() => recordAttachmentMetric(store, { ...base, principalId: 'p-x' } as never), /not_a_fixed/);
  });

  test('the fixed batch-increment count field is accepted and never becomes a label', () => {
    const store = createAttachmentMetricsStore();
    recordAttachmentMetric(store, { ...labels(), count: 3 });
    recordAttachmentMetric(store, labels());
    const snapshot = snapshotAttachmentMetrics(store);
    assert.equal(snapshot.counters.length, 1, 'count must not create a new label combination');
    assert.equal(snapshot.counters[0]!.count, 4, 'count accumulates into the same fixed-label counter');
    assert.deepEqual(Object.keys(snapshot.counters[0]!.labels).sort(), [
      'errorClass', 'latencyBucket', 'operation', 'rateLimitDecision', 'sizeBucket', 'state',
    ], 'the snapshot label set stays exactly the six fixed labels');
    // Invalid counts still fail closed.
    assert.throws(() => recordAttachmentMetric(store, { ...labels(), count: 0 }), /not_a_fixed|count_invalid/);
    assert.throws(() => recordAttachmentMetric(store, { ...labels(), count: 1.5 }), /not_a_fixed|count_invalid/);
  });

  test('the snapshot contains only fixed label keys and fixed gauges; counters accumulate', () => {
    const store = createAttachmentMetricsStore();
    recordAttachmentMetric(store, labels());
    recordAttachmentMetric(store, labels());
    recordAttachmentMetric(store, labels({ state: 'failed', errorClass: 'contract_corruption' }));
    recordAttachmentMetric(store, labels({ operation: 'deliver', state: 'denied', errorClass: 'provider_denied' }));
    const snapshot = snapshotAttachmentMetrics(store);

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['blobId', 'principalId', 'filename', 'digest', 'url', 'key', 'token', 'secret']) {
      assert.ok(!serialized.includes(`"${forbidden}"`), `snapshot must not contain label field ${forbidden}`);
    }

    const counters = new Map(snapshot.counters.map((entry) => [JSON.stringify(entry.labels), entry.count]));
    assert.equal(counters.get(JSON.stringify(labels())), 2, 'same fixed labels accumulate');
    assert.equal(counters.get(JSON.stringify(labels({ state: 'failed', errorClass: 'contract_corruption' }))), 1);
    assert.equal(counters.get(JSON.stringify(labels({ operation: 'deliver', state: 'denied', errorClass: 'provider_denied' }))), 1);

    for (const gauge of ATTACHMENT_GAUGE_NAMES) {
      assert.equal(snapshot.gauges[gauge], 0, 'gauges start at zero');
    }
    assert.deepEqual(
      Object.keys(snapshot.gauges).sort(),
      [...ATTACHMENT_GAUGE_NAMES].sort(),
      'the gauge surface is exactly the fixed allowlist',
    );
  });

  test('gauges are fixed-name only; an unknown gauge name throws', () => {
    const store = createAttachmentMetricsStore();
    store.setGauge('verification_backlog', 42);
    assert.equal(snapshotAttachmentMetrics(store).gauges.verification_backlog, 42);
    assert.throws(() => store.setGauge('blob_backlog' as never, 1), /not_a_fixed/);
  });

  test('backlog samples are kept in a bounded ring and returned in time order', () => {
    const store = createAttachmentMetricsStore({ maxBacklogSamples: 4 });
    const at = (second: number) => `2026-08-08T00:00:${String(second).padStart(2, '0')}.000Z`;
    for (let second = 1; second <= 10; second += 1) {
      store.recordBacklogSample({
        atIso: at(second), verificationBacklog: second, cleanupBacklog: second,
        quarantineCount: 0, deadLetterCount: 0,
      });
    }
    const samples = snapshotAttachmentMetrics(store).backlogSamples;
    assert.equal(samples.length, 4, 'the ring must drop the oldest samples');
    assert.deepEqual(samples.map((sample) => sample.atIso), [at(7), at(8), at(9), at(10)]);
  });

  test('a synthetic secret marker recorded in a metric value never appears in the snapshot', () => {
    const marker = `metric-secret-marker-${Date.now()}`;
    const store = createAttachmentMetricsStore();
    store.setGauge('dead_letter_count', 3);
    store.recordBacklogSample({
      atIso: '2026-08-08T00:00:00.000Z',
      verificationBacklog: Number(`1${marker}`.replace(/[^0-9]/gu, '')),
      cleanupBacklog: 0, quarantineCount: 0, deadLetterCount: 3,
    });
    recordAttachmentMetric(store, labels());
    const serialized = JSON.stringify(snapshotAttachmentMetrics(store));
    assert.ok(!serialized.includes(marker), 'metric snapshots must never serialize secrets');
  });
});
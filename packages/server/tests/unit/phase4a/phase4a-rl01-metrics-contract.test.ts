/**
 * P4A-RL01 metrics surface contract: fixed-label admission baseline (plan §8
 * RL01 production scope).
 *
 * RL01 extends the P4A-I15 fixed-label metric surface with the admission
 * baseline dimensions and proves the extended surface stays low-cardinality:
 *
 *  - route operations for the five admission paths (`status`, `finalize`,
 *    `download`) plus the `query` operation (DB query latency), so route
 *    query/admission counters and query latency buckets have fixed label
 *    values;
 *  - a fixed `rateLimitDecision` dimension (`none|allowed|denied|
 *    unavailable|fallback`) so rate-limit decision/fallback counts never
 *    carry a principal, route-identity or dynamic value;
 *  - fixed PostgreSQL pool gauges (`pool_total/pool_idle/pool_active/
 *    pool_waiting/pool_max_waiting`) for pool wait/saturation;
 *  - recording any other label name or value still throws, so cardinality can
 *    never grow with principal/Collection/blob/key/filename/digest/URL
 *    (§12 artifact ban + §13.2 low-cardinality requirement).
 *
 * No Attachment cache is introduced by RL01; nothing in this surface reads or
 * caches object bytes.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
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

/** The exact six fixed label keys of the extended counter surface. */
const FIXED_LABEL_KEYS = [
  'errorClass', 'latencyBucket', 'operation', 'rateLimitDecision', 'sizeBucket', 'state',
] as const;

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

test('every label vocabulary is a frozen, non-empty, fixed allowlist (RL01 extension)', () => {
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
  // The five admission route operations plus verify/cleanup/deliver plus the
  // `query` operation for DB query latency.
  for (const operation of ['issue', 'complete', 'status', 'finalize', 'download', 'verify', 'cleanup', 'deliver', 'query']) {
    assert.ok(ATTACHMENT_METRIC_OPERATIONS.includes(operation as never),
      `operation ${operation} must be a fixed label value`);
  }
  // Rate-limit decision/fallback dimension: fixed values only (RL04 later
  // composes the Redis mode; the allowlist is sealed NOW so no dynamic value
  // can ever enter the counter space).
  assert.deepEqual([...ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS],
    ['none', 'allowed', 'denied', 'unavailable', 'fallback']);
  // Pool wait/saturation gauges are fixed-name members of the gauge surface.
  for (const gauge of ['pool_total', 'pool_idle', 'pool_active', 'pool_waiting', 'pool_max_waiting']) {
    assert.ok(ATTACHMENT_GAUGE_NAMES.includes(gauge as never), `gauge ${gauge} must be fixed`);
  }
});

test('recording with any label value outside the fixed allowlist throws (RL01 included)', () => {
  const store = createAttachmentMetricsStore();
  const base = labels();
  assert.throws(() => recordAttachmentMetric(store, { ...base, operation: 'issuance' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, operation: 'replacement' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, operation: 'retire' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, state: 'processing' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, errorClass: 'provider_sdk_bug' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, sizeBucket: '10GiB' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, latencyBucket: 'three_minutes' as never }), /not_a_fixed/);
  // The RL01 rate-limit decision dimension is fixed too: a mode/decision
  // value (or any dynamic value) outside the allowlist throws.
  assert.throws(() => recordAttachmentMetric(store, { ...base, rateLimitDecision: 'shadow' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, rateLimitDecision: 'enforce' as never }), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, rateLimitDecision: 'principal-budget' as never }), /not_a_fixed/);
  // Unknown record keys (principal/route/blob identity, URLs, ...) throw.
  assert.throws(() => recordAttachmentMetric(store, { ...base, blobId: 'blob-x' } as never), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, principalId: 'p-x' } as never), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, collectionId: 'c-x' } as never), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, route: 'issue' } as never), /not_a_fixed/);
  assert.throws(() => recordAttachmentMetric(store, { ...base, url: 'https://x' } as never), /not_a_fixed/);
});

test('valid six-label records accumulate; the snapshot carries exactly the six fixed label keys', () => {
  const store = createAttachmentMetricsStore();
  recordAttachmentMetric(store, labels());
  recordAttachmentMetric(store, labels());
  recordAttachmentMetric(store, labels({
    operation: 'download', state: 'denied', rateLimitDecision: 'denied', latencyBucket: 'under_10ms',
  }));
  recordAttachmentMetric(store, labels({ operation: 'status', latencyBucket: 'under_10ms' }));
  recordAttachmentMetric(store, labels({ operation: 'query', sizeBucket: 'zero', latencyBucket: 'under_100ms' }));
  recordAttachmentMetric(store, labels({ operation: 'finalize', state: 'failed', errorClass: 'database' }));
  const snapshot = snapshotAttachmentMetrics(store);

  assert.equal(snapshot.counters.length, 5, 'each distinct fixed-label combination is one counter');
  for (const counter of snapshot.counters) {
    assert.deepEqual(Object.keys(counter.labels).sort(), [...FIXED_LABEL_KEYS].sort(),
      'the snapshot label set stays exactly the six fixed labels');
  }
  const counters = new Map(snapshot.counters.map((entry) => [JSON.stringify(entry.labels), entry.count]));
  assert.equal(counters.get(JSON.stringify(labels())), 2, 'same fixed labels accumulate');
  assert.equal(
    counters.get(JSON.stringify(labels({ operation: 'download', state: 'denied', rateLimitDecision: 'denied', latencyBucket: 'under_10ms' }))),
    1,
  );
  assert.equal(counters.get(JSON.stringify(labels({ operation: 'status', latencyBucket: 'under_10ms' }))), 1);
  assert.equal(counters.get(JSON.stringify(labels({ operation: 'query', sizeBucket: 'zero', latencyBucket: 'under_100ms' }))), 1);

  // The snapshot serialization never contains identity/secret-shaped fields.
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    'blobId', 'intentId', 'generationId', 'principalId', 'subjectId', 'collectionId',
    'filename', 'digest', 'url', 'key', 'token', 'secret', 'credential',
  ]) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `snapshot must not contain label field ${forbidden}`);
  }

  // The batch-increment count field stays a record-only field, never a label.
  recordAttachmentMetric(store, { ...labels(), count: 3 });
  const afterBatch = snapshotAttachmentMetrics(store);
  const plain = afterBatch.counters.find((entry) => JSON.stringify(entry.labels) === JSON.stringify(labels()));
  assert.equal(plain?.count, 5, 'count accumulates into the same fixed-label counter');
  assert.throws(() => recordAttachmentMetric(store, { ...labels(), count: 0 }), /count_invalid/);
  assert.throws(() => recordAttachmentMetric(store, { ...labels(), count: 1.5 }), /count_invalid/);
});

test('pool wait/saturation gauges are fixed-name only; unknown gauge names throw', () => {
  const store = createAttachmentMetricsStore();
  for (const gauge of ['pool_total', 'pool_idle', 'pool_active', 'pool_waiting', 'pool_max_waiting'] as const) {
    store.setGauge(gauge, 7);
    assert.equal(snapshotAttachmentMetrics(store).gauges[gauge], 7);
  }
  assert.throws(() => store.setGauge('pool_waiting_queries' as never, 1), /not_a_fixed/);
  assert.throws(() => store.setGauge('db_query_count' as never, 1), /not_a_fixed/);
  assert.throws(() => store.setGauge('pool_quota_principal' as never, 1), /not_a_fixed/);
  assert.throws(() => store.setGauge('pool_total', Number.NaN), /gauge_value_invalid/);
});

test('the counter space is bounded by the fixed label product (low cardinality)', () => {
  const store = createAttachmentMetricsStore();
  const bound = ATTACHMENT_METRIC_OPERATIONS.length
    * ATTACHMENT_METRIC_STATES.length
    * ATTACHMENT_METRIC_ERROR_CLASSES.length
    * ATTACHMENT_METRIC_SIZE_BUCKETS.length
    * ATTACHMENT_METRIC_LATENCY_BUCKETS.length
    * ATTACHMENT_METRIC_RATE_LIMIT_DECISIONS.length;
  // Record one combination for every fixed operation: the counter space is
  // exactly the number of fixed operations, never a growing identity space.
  for (const operation of ATTACHMENT_METRIC_OPERATIONS) {
    recordAttachmentMetric(store, labels({
      operation, state: 'ok', errorClass: 'none', sizeBucket: 'zero',
      latencyBucket: 'under_10ms', rateLimitDecision: 'none',
    }));
  }
  const snapshot = snapshotAttachmentMetrics(store);
  assert.equal(snapshot.counters.length, ATTACHMENT_METRIC_OPERATIONS.length);
  assert.ok(snapshot.counters.length <= bound, 'counter space must never exceed the fixed label product');
});

test('a synthetic secret marker never appears in the RL01-extended snapshot', () => {
  const marker = `rl01-metric-marker-${Date.now()}`;
  const store = createAttachmentMetricsStore();
  store.setGauge('pool_waiting', 2);
  recordAttachmentMetric(store, labels({ operation: 'download', state: 'denied', rateLimitDecision: 'denied' }));
  recordAttachmentMetric(store, labels({ operation: 'query', sizeBucket: 'zero' }));
  store.recordBacklogSample({
    atIso: '2026-08-08T00:00:00.000Z',
    verificationBacklog: 10, cleanupBacklog: 0, quarantineCount: 0, deadLetterCount: 0,
  });
  const serialized = JSON.stringify(snapshotAttachmentMetrics(store));
  assert.ok(!serialized.includes(marker), 'metric snapshots must never serialize secrets');
  // The marker cannot enter ANY string-valued field of the snapshot: label
  // values, record keys and gauge names are fixed allowlists, so a
  // marker-shaped value throws instead of being recorded/serialized (the
  // I15 marker contract, extended to the RL01 surface).
  assert.throws(
    () => recordAttachmentMetric(store, { ...labels(), rateLimitDecision: marker } as never),
    /not_a_fixed/,
    'a marker-shaped decision value must be rejected by the fixed allowlist',
  );
  assert.throws(
    () => recordAttachmentMetric(store, { ...labels(), blobId: marker } as never),
    /not_a_fixed/,
    'a marker-shaped record key must be rejected by the fixed record schema',
  );
  assert.throws(
    () => store.setGauge(`pool_${marker}` as never, 1),
    /not_a_fixed/,
    'a marker-shaped gauge name must be rejected by the fixed gauge allowlist',
  );
});

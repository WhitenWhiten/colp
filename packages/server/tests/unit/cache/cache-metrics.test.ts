/**
 * T05 unit tests (plan §6.4 T05 / §7.2): cache telemetry mapping.
 *
 * `recordCacheReadOutcome` maps every T04 ReadThroughResult (plus the T05
 * circuit-open bypass variant) onto low-cardinality outcome counters so each
 * outcome is incremented exactly once. Latency and entry bytes use observe;
 * circuit state uses a gauge; metric names are fixed labels plus a fixed
 * domain label and can never contain collection IDs, query hashes, cache keys
 * or raw error text.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  CACHE_ERROR_CATEGORY,
  cacheMetricName,
  cacheOutcomeMetricName,
  cacheReadOutcomeMetricNames,
  cacheObservedMetricNames,
  cacheCircuitMetricNames,
  classifyCacheReadOutcome,
  recordCacheBreakerOpen,
  recordCacheBreakerProbe,
  recordCacheCircuitState,
  recordCacheEntryBytes,
  recordCacheReadLatency,
  recordCacheReadOutcome,
  type CacheMetricsResult,
  type ReadThroughResult,
} from '../../../src/infrastructure/cache/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const DOMAIN = 'publication-metadata';

function metrics(): InMemoryMetrics {
  return new InMemoryMetrics();
}

function resultOf<T>(result: ReadThroughResult<T> | CacheMetricsResult<T>): CacheMetricsResult<T> {
  return result;
}

describe('classifyCacheReadOutcome', () => {
  test('each T04 outcome maps to exactly the expected counters', () => {
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'cache_hit', value: { id: 'x' }, writtenAtMs: 0, hardExpiresAtMs: 30_000 })), ['hit']);
    assert.deepEqual(
      classifyCacheReadOutcome(resultOf({ kind: 'stale_hit', value: { id: 'x' }, writtenAtMs: 0, softExpiresAtMs: 10_000, hardExpiresAtMs: 30_000 })),
      ['stale'],
    );
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'origin', value: { id: 'x' }, path: 'miss', cached: true })), ['miss']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'origin', value: { id: 'x' }, path: 'soft_expired', cached: false })), ['miss']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'origin', value: { id: 'x' }, path: 'decode_error', cached: false })), ['bad_value']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'origin', value: { id: 'x' }, path: 'cache_unavailable', cached: false })), ['redis_error', 'fallback']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'origin', value: { id: 'x' }, path: 'lock_unavailable', cached: false })), ['redis_error', 'fallback']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'origin', value: { id: 'x' }, path: 'lock_wait_exceeded', cached: false })), ['lock_wait', 'fallback']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'origin', value: { id: 'x' }, path: 'circuit_open' })), ['fallback']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'not_found', path: 'miss' })), ['miss']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'not_found', path: 'circuit_open' })), ['miss']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'loader_error', path: 'miss', error: new Error('boom') })), ['fallback']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'loader_error', path: 'circuit_open', error: new Error('boom') })), ['fallback']);
    assert.deepEqual(classifyCacheReadOutcome(resultOf({ kind: 'fallback_rejected', reason: 'bulkhead_full' })), ['fallback']);
  });
});

describe('recordCacheReadOutcome', () => {
  test('hit increments only hit', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'cache_hit', value: { id: 'x' }, writtenAtMs: 0, hardExpiresAtMs: 30_000 });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'hit')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'miss')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'stale')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'bad_value')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'lock_wait')), 0);
  });

  test('miss increments only miss', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'origin', value: { id: 'x' }, path: 'miss', cached: true });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'miss')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'hit')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 0);
  });

  test('stale increments only stale', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'stale_hit', value: { id: 'x' }, writtenAtMs: 0, softExpiresAtMs: 10_000, hardExpiresAtMs: 30_000 });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'stale')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'hit')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'miss')), 0);
  });

  test('fallback increments only fallback', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'loader_error', path: 'miss', error: new Error('db down') });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'miss')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0);

    const m2 = metrics();
    recordCacheReadOutcome(m2, DOMAIN, { kind: 'fallback_rejected', reason: 'bulkhead_full' });
    assert.equal(m2.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);
  });

  test('bad value increments only bad_value', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'origin', value: { id: 'x' }, path: 'decode_error', cached: false });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'bad_value')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'miss')), 0);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 0);
  });

  test('redis error increments redis_error and fallback exactly once each', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'origin', value: { id: 'x' }, path: 'cache_unavailable', cached: false });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);

    const m2 = metrics();
    recordCacheReadOutcome(m2, DOMAIN, { kind: 'origin', value: { id: 'x' }, path: 'lock_unavailable', cached: false });
    assert.equal(m2.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 1);
    assert.equal(m2.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);
  });

  test('lock wait increments lock_wait and fallback exactly once each', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'origin', value: { id: 'x' }, path: 'lock_wait_exceeded', cached: false });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'lock_wait')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);
  });

  test('circuit-open bypass increments fallback exactly once and never redis_error', () => {
    const m = metrics();
    recordCacheReadOutcome(m, DOMAIN, { kind: 'origin', value: { id: 'x' }, path: 'circuit_open' });
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'fallback')), 1);
    assert.equal(m.get(cacheOutcomeMetricName(DOMAIN, 'redis_error')), 0);
  });
});

describe('observe / gauge metrics', () => {
  test('entry bytes use observe once', () => {
    const m = metrics();
    recordCacheEntryBytes(m, DOMAIN, 123_456);
    assert.deepEqual(m.observations(cacheMetricName(DOMAIN, cacheObservedMetricNames.entryBytes)), [123_456]);
  });

  test('read latency uses observe once', () => {
    const m = metrics();
    recordCacheReadLatency(m, DOMAIN, 12.5);
    assert.deepEqual(m.observations(cacheMetricName(DOMAIN, cacheObservedMetricNames.latencyMs)), [12.5]);
  });

  test('circuit state is a gauge and probe/open are counters', () => {
    const m = metrics();
    recordCacheCircuitState(m, 'closed');
    recordCacheCircuitState(m, 'half_open');
    recordCacheCircuitState(m, 'open');
    assert.equal(m.get(cacheCircuitMetricNames.state), 2);
    recordCacheCircuitState(m, 'closed');
    assert.equal(m.get(cacheCircuitMetricNames.state), 0);

    recordCacheBreakerProbe(m);
    recordCacheBreakerProbe(m);
    assert.equal(m.get(cacheCircuitMetricNames.probe), 2);

    recordCacheBreakerOpen(m);
    assert.equal(m.get(cacheCircuitMetricNames.open), 1);
  });
});

describe('metric name safety', () => {
  test('names are fixed low-cardinality labels plus a fixed domain label', () => {
    assert.equal(cacheOutcomeMetricName(DOMAIN, 'hit'), 'cache.read.hit.publication-metadata');
    assert.equal(cacheOutcomeMetricName(DOMAIN, 'redis_error'), 'cache.read.redis_error.publication-metadata');
    assert.equal(cacheMetricName(DOMAIN, cacheObservedMetricNames.entryBytes), 'cache.entry.size_bytes.publication-metadata');
    for (const base of Object.values(cacheReadOutcomeMetricNames)) {
      assert.match(cacheMetricName(DOMAIN, base), /^[a-z0-9._-]+$/u);
    }
    assert.match(cacheCircuitMetricNames.state, /^[a-z0-9._-]+$/u);
    assert.match(cacheCircuitMetricNames.probe, /^[a-z0-9._-]+$/u);
    assert.match(cacheCircuitMetricNames.open, /^[a-z0-9._-]+$/u);
  });

  test('invalid domain labels are rejected so no collection id or key can enter a metric name', () => {
    const m = metrics();
    assert.throws(() => cacheMetricName('collection id 1', 'cache.read.hit'), /low-cardinality/u);
    assert.throws(() => cacheOutcomeMetricName('key:known:cache:v1:{pub:1}', 'hit'), /low-cardinality/u);
    assert.throws(() => recordCacheEntryBytes(m, 'query-hash 4f2a', 10), /low-cardinality/u);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

describe('InMemoryMetrics observations', () => {
  test('retains only the newest samples in chronological order', () => {
    const metrics = new InMemoryMetrics({ maxObservationsPerMetric: 3 });

    metrics.observe('request.duration_ms', 1);
    metrics.observe('request.duration_ms', 2);
    metrics.observe('request.duration_ms', 3);
    metrics.observe('request.duration_ms', 4);
    metrics.observe('request.duration_ms', 5);

    assert.deepEqual(metrics.observations('request.duration_ms'), [3, 4, 5]);
  });

  test('keeps independent bounded rings for each metric', () => {
    const metrics = new InMemoryMetrics({ maxObservationsPerMetric: 2 });

    metrics.observe('a', 1);
    metrics.observe('b', 10);
    metrics.observe('a', 2);
    metrics.observe('a', 3);

    assert.deepEqual(metrics.observations('a'), [2, 3]);
    assert.deepEqual(metrics.observations('b'), [10]);
  });

  test('rejects invalid retention limits', () => {
    assert.throws(() => new InMemoryMetrics({ maxObservationsPerMetric: 0 }), RangeError);
    assert.throws(() => new InMemoryMetrics({ maxObservationsPerMetric: 1.5 }), RangeError);
  });

  test('renders counters, gauges and all-time observation aggregates for Prometheus', () => {
    const metrics = new InMemoryMetrics({ maxObservationsPerMetric: 2 });
    metrics.increment('request.total', 2);
    metrics.gauge('worker.active', 3);
    metrics.observe('request.duration_ms', 10);
    metrics.observe('request.duration_ms', 20);
    metrics.observe('request.duration_ms', 30);

    assert.equal(metrics.renderPrometheus(), [
      '# TYPE known_request_total counter',
      'known_request_total 2',
      '# TYPE known_worker_active gauge',
      'known_worker_active 3',
      '# TYPE known_request_duration_ms summary',
      'known_request_duration_ms_sum 60',
      'known_request_duration_ms_count 3',
      '',
    ].join('\n'));
  });
});

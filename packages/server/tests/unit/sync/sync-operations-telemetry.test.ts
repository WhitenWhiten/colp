import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'vitest';
import { createLogger, InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  publishSyncOperationalTelemetry,
  SYNC_OPERATIONAL_METRICS,
} from '../../../src/infrastructure/sync/index.js';

describe('Sync operational telemetry', () => {
  test('publishes the complete fixed metric set and low-cardinality log fields', () => {
    const metrics = new InMemoryMetrics();
    const output: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk) => output.push(chunk.toString('utf8')));
    publishSyncOperationalTelemetry({
      queue: { deferred: 2, oldestAgeMs: 150 },
      conflicts: { open: 3, oldestAgeMs: 1_500 },
      recovery: { required: 4 },
      purge: { pendingTombstones: 5, oldestAgeMs: 15_000 },
    }, metrics, createLogger('info', destination));
    assert.deepEqual(SYNC_OPERATIONAL_METRICS.map((name) => metrics.get(name)),
      [2, 150, 3, 1_500, 4, 5, 15_000]);
    const record = JSON.parse(output.join('')) as Record<string, unknown>;
    assert.deepEqual({
      event: record.event,
      queueLagBucket: record.queueLagBucket,
      conflictAgeBucket: record.conflictAgeBucket,
      purgeAgeBucket: record.purgeAgeBucket,
    }, {
      event: 'sync_operational_snapshot',
      queueLagBucket: 'under_1s',
      conflictAgeBucket: 'under_10s',
      purgeAgeBucket: 'over_10s',
    });
  });

  test('rejects invalid counts and never accepts dynamic labels or sensitive details', () => {
    const sentinel = 'P3_39_SECRET_SENTINEL_replica_collection_url_title';
    const metrics = new InMemoryMetrics();
    const destination = new PassThrough();
    const chunks: string[] = [];
    destination.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
    assert.throws(() => publishSyncOperationalTelemetry({
      queue: { deferred: -1, oldestAgeMs: 0 },
      conflicts: { open: 0, oldestAgeMs: 0 }, recovery: { required: 0 },
      purge: { pendingTombstones: 0, oldestAgeMs: 0 },
    }, metrics, createLogger('info', destination)), /invalid/iu);
    assert.doesNotMatch(`${JSON.stringify(metrics)}\n${chunks.join('')}`, new RegExp(sentinel, 'u'));
    assert.equal(SYNC_OPERATIONAL_METRICS.some((name) => name.includes(sentinel)), false);
  });
});

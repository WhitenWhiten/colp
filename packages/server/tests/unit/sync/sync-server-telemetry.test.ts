import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'vitest';
import { InMemoryMetrics, createLogger, serializeRequestForLog } from '../../../src/infrastructure/telemetry/index.js';
import {
  SYNC_TELEMETRY_ENDPOINTS,
  SYNC_TELEMETRY_OUTCOMES,
  createSyncServerTelemetry,
} from '../../../src/infrastructure/telemetry/sync-server.js';

describe('server Sync telemetry', () => {
  test('emits only fixed low-cardinality dimensions for success, replay, retry, abort, timeout and failures', () => {
    const metrics = new InMemoryMetrics();
    const records: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk) => records.push(chunk.toString('utf8')));
    const telemetry = createSyncServerTelemetry({ metrics, logger: createLogger('info', destination) });
    for (const endpoint of SYNC_TELEMETRY_ENDPOINTS) {
      for (const outcome of SYNC_TELEMETRY_OUTCOMES) {
        telemetry.record({ endpoint, outcome, problem: outcome === 'problem' ? 'sequence_gap' : 'none',
          bucket: 'under_100ms', durationMs: 10 });
      }
    }
    assert.equal(metrics.get('sync.server.requests_total'),
      SYNC_TELEMETRY_ENDPOINTS.length * SYNC_TELEMETRY_OUTCOMES.length);
    assert.ok(metrics.observations('sync.server.duration_ms').length > 0);
    assert.ok(records.every((line) => line.includes('"event":"sync_request"')));
  });

  test('rejects dynamic identifiers and redacts sentinel content from logs, metrics and trace-safe fields', () => {
    const sentinel = 'P3_26_SECRET_SENTINEL_account_replica_collection_op_cursor_url_title';
    const metrics = new InMemoryMetrics();
    const chunks: string[] = [];
    const destination = new PassThrough();
    destination.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
    const telemetry = createSyncServerTelemetry({ metrics, logger: createLogger('info', destination) });
    assert.throws(() => telemetry.record({ endpoint: sentinel as never, outcome: 'success',
      problem: 'none', bucket: 'under_100ms', durationMs: 1 }), /endpoint/iu);
    assert.throws(() => telemetry.record({ endpoint: 'push', outcome: 'problem',
      problem: sentinel as never, bucket: 'under_100ms', durationMs: 1 }), /problem/iu);
    assert.doesNotMatch(`${chunks.join('')}\n${JSON.stringify(metrics)}`, new RegExp(sentinel, 'u'));
    assert.deepEqual(serializeRequestForLog({
      method: 'POST', url: `/opaque/${sentinel}?cursor=${sentinel}`,
      routeOptions: { url: '/opaque/:conflictId' },
    }), { method: 'POST', url: '/opaque/:conflictId', host: undefined,
      remoteAddress: undefined, remotePort: undefined });
  });
});

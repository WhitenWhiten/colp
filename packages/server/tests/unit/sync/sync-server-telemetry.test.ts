import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'vitest';
import Fastify from 'fastify';
import { installSyncTelemetry } from '../../../src/transport/colp-sync/register-colp-sync.js';
import { InMemoryMetrics, createLogger, serializeRequestForLog } from '../../../src/infrastructure/telemetry/index.js';
import {
  SYNC_TELEMETRY_ENDPOINTS,
  SYNC_TELEMETRY_OUTCOMES,
  createSyncServerTelemetry,
  syncTelemetryProblemOf,
} from '../../../src/infrastructure/telemetry/sync-server.js';

describe('server Sync telemetry', () => {
  test('an HTTP 409 records the bounded snapshot problem from the response body', async () => {
    const records: string[] = [];
    const destination = new PassThrough();
    destination.on('data', chunk => records.push(chunk.toString('utf8')));
    const app = Fastify({ loggerInstance: createLogger('info', destination) });
    installSyncTelemetry(app, new InMemoryMetrics(), {
      syncSnapshotRoutes: { path: '/test/snapshot' },
    } as Parameters<typeof installSyncTelemetry>[2]);
    app.get('/test/snapshot', async (_request, reply) => reply.code(409).send({ code: 'snapshot_expired' }));
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/test/snapshot' })).statusCode, 409);
      const record = records.map(line => JSON.parse(line)).find(row => row.event === 'sync_request');
      assert.equal(record?.problem, 'snapshot_expired');
      assert.equal(record?.outcome, 'problem');
    } finally { await app.close(); }
  });
  test('retains actionable failure codes without admitting arbitrary labels', () => {
    assert.equal(syncTelemetryProblemOf({ code: 'resource_not_found' }), 'resource_not_found');
    assert.equal(syncTelemetryProblemOf({ code: 'snapshot_expired' }), 'snapshot_expired');
    assert.equal(syncTelemetryProblemOf({ code: 'position_context_stale' }), 'position_context_stale');
    assert.equal(syncTelemetryProblemOf({ code: 'secret-cursor-value' }), 'internal_error');
  });
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

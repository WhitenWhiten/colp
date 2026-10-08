import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';

import {
  InMemoryMetrics,
  createPrometheusMetricsServer,
  parseMetricsPort,
  type PrometheusMetricsServer,
} from '../../../src/infrastructure/telemetry/index.js';

const servers: PrometheusMetricsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('Prometheus metrics HTTP server', () => {
  test('serves worker metrics and a narrow health endpoint', async () => {
    const metrics = new InMemoryMetrics();
    metrics.gauge('outbox.backlog', 7);
    const server = createPrometheusMetricsServer({ metrics, host: '127.0.0.1', port: 0 });
    servers.push(server);
    const address = await server.start();

    const metricsResponse = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.equal(metricsResponse.status, 200);
    assert.match(await metricsResponse.text(), /known_outbox_backlog 7/u);
    assert.equal(metricsResponse.headers.get('cache-control'), 'no-store');

    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(healthResponse.status, 200);
    assert.equal(await healthResponse.text(), 'ok\n');
  });

  test('validates configured worker ports', () => {
    assert.equal(parseMetricsPort(undefined), 9_464);
    assert.equal(parseMetricsPort('12345'), 12_345);
    assert.throws(() => parseMetricsPort('0'), /between 1 and 65535/u);
    assert.throws(() => parseMetricsPort('abc'), /integer/u);
  });
});

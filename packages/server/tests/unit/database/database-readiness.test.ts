import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { version } from '../../../src/version.js';

const openApps: FastifyInstance[] = [];

function createApp(
  verifyReady: () => Promise<void>,
  metrics = new InMemoryMetrics(),
): FastifyInstance {
  const app = buildApiApp({
    config: loadConfig({ DATABASE_URL: 'postgres://localhost/known', LOG_LEVEL: 'silent',
      OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' }),
    readiness: { verifyReady },
    metrics,
  });
  openApps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe('database-backed readiness boundary', () => {
  test('health remains live without consulting database readiness', async () => {
    let calls = 0;
    const app = createApp(async () => { calls += 1; });

    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', version });
    assert.equal(calls, 0);
  });

  test('readiness verifies the database on every probe', async () => {
    let calls = 0;
    const app = createApp(async () => { calls += 1; });

    const first = await app.inject({ method: 'GET', url: '/ready' });
    const second = await app.inject({ method: 'GET', url: '/ready' });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.deepEqual(first.json(), { status: 'ready' });
    assert.equal(calls, 2);
  });

  test('readiness fails closed while health remains available', async () => {
    const app = createApp(async () => { throw new Error('database unavailable'); });

    const readiness = await app.inject({ method: 'GET', url: '/ready' });
    const health = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(readiness.statusCode, 503);
    assert.deepEqual(readiness.json(), { status: 'not-ready' });
    assert.equal(health.statusCode, 200);
  });

  test('exports process metrics in Prometheus text format', async () => {
    const metrics = new InMemoryMetrics();
    metrics.increment('http.requests', 2);
    const app = createApp(async () => {}, metrics);

    const response = await app.inject({ method: 'GET', url: '/metrics' });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /text\/plain/u);
    assert.match(response.body, /# TYPE known_http_requests counter\nknown_http_requests 2\n/u);
    assert.equal(response.headers['cache-control'], 'no-store');
  });
});

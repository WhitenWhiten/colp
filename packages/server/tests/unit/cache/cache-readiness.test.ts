/**
 * T10 readiness tests (plan §5 / §6.4 T10): the `/ready/features/cache`
 * capability endpoint and the main `/ready` fail-closed branch, plus the
 * guarantee that liveness never depends on Redis.
 *
 * Status mapping: healthy -> 200; degraded / disabled / not-ready -> 503,
 * following the feed/notifications capability-endpoint convention. The main
 * /ready only fails closed when KNOWN_CACHE_REQUIRED=true and the cache state
 * is not healthy; otherwise the cache state never affects the main probe.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import {
  createApiCacheComposition,
  type ApiCacheComposition,
} from '../../../src/bootstrap/cache-composition.js';
import { alwaysReady } from '../../../src/infrastructure/health.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { RecordingCacheStore } from '../../support/recording-cache-store.js';

const openApps: FastifyInstance[] = [];
const openCompositions: ApiCacheComposition[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
  await Promise.all(openCompositions.splice(0).map(async (composition) => composition.close()));
});

function cacheConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://known.example',
    PUBLICATION_ORIGIN: 'https://known.example',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    ...overrides,
  });
}

function buildCompositionApp(
  config: AppConfig,
  store: RecordingCacheStore,
  metrics = new InMemoryMetrics(),
): { readonly app: FastifyInstance; readonly composition: ApiCacheComposition } {
  const composition = createApiCacheComposition({
    config: config.cache,
    metrics,
    environment: 'test',
    createStore: () => store,
  });
  openCompositions.push(composition);
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    metrics,
    cacheReadiness: () => composition.readiness(),
    cacheCapabilityReadiness: () => composition.capabilityReadiness(),
  });
  openApps.push(app);
  return { app, composition };
}

describe('T10 cache capability readiness endpoint', () => {
  test('reports disabled for mode=off without creating a Redis client', async () => {
    const config = cacheConfig({ KNOWN_CACHE_MODE: 'off' });
    const store = new RecordingCacheStore();
    const createStore = vi.fn(() => store);
    const composition = createApiCacheComposition({
      config: config.cache,
      metrics: new InMemoryMetrics(),
      environment: 'test',
      createStore,
    });
    openCompositions.push(composition);
    const app = buildApiApp({
      config,
      readiness: alwaysReady,
      cacheReadiness: () => composition.readiness(),
      cacheCapabilityReadiness: () => composition.capabilityReadiness(),
    });
    openApps.push(app);

    assert.equal(createStore.mock.calls.length, 0);
    const capability = await app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 503);
    assert.equal(capability.json().capability, 'cache');
    assert.equal(capability.json().status, 'disabled');
    assert.equal(capability.json().mode, 'off');
    assert.equal(capability.json().required, false);
  });

  test('reports ready (200) for a healthy Redis store', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      KNOWN_CACHE_REQUIRED: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    });
    const { app } = buildCompositionApp(config, new RecordingCacheStore({ health: 'healthy' }));

    const capability = await app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 200);
    assert.equal(capability.json().status, 'ready');
    assert.equal(capability.json().storeHealth, 'healthy');

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200, 'a healthy cache never fails the main readiness');
  });

  test('reports degraded (503) for a degraded Redis store', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    });
    const { app } = buildCompositionApp(config, new RecordingCacheStore({ health: 'degraded' }));

    const capability = await app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 503);
    assert.equal(capability.json().status, 'degraded');
  });

  test('reports not-ready (503) when the capability probe throws', async () => {
    const config = cacheConfig({ KNOWN_CACHE_MODE: 'serve', REDIS_URL: 'redis://127.0.0.1:6379/0' });
    const app = buildApiApp({
      config,
      readiness: alwaysReady,
      cacheCapabilityReadiness: async () => {
        throw new Error('cache capability probe boom');
      },
    });
    openApps.push(app);

    const capability = await app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 503);
    assert.equal(capability.json().capability, 'cache');
    assert.equal(capability.json().status, 'not-ready');
    assert.equal(capability.json().reason, 'dependency_unavailable');
  });

  test('is not registered when no cache capability probe is supplied (default unchanged)', async () => {
    const app = buildApiApp({ config: cacheConfig(), readiness: alwaysReady });
    openApps.push(app);

    const capability = await app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 404, 'the default composition must not add the cache endpoint');
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200);
  });
});

describe('T10 main readiness and liveness', () => {
  test('cache degradation never affects the main /ready when required=false', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      KNOWN_CACHE_REQUIRED: 'false',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    });
    const { app } = buildCompositionApp(config, new RecordingCacheStore({ health: 'degraded' }));

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { status: 'ready' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  });

  test('required=true fails the main /ready closed when the cache is degraded', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      KNOWN_CACHE_REQUIRED: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    });
    const { app } = buildCompositionApp(config, new RecordingCacheStore({ health: 'degraded' }));

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { status: 'not-ready' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200, 'liveness never depends on Redis');
  });

  test('required=true with mode=off fails closed because disabled is not healthy', async () => {
    const config = cacheConfig({ KNOWN_CACHE_MODE: 'off', KNOWN_CACHE_REQUIRED: 'true' });
    const { app } = buildCompositionApp(config, new RecordingCacheStore());

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 503, 'required cache that is disabled must fail closed');
    const capability = await app.inject({ method: 'GET', url: '/ready/features/cache' });
    assert.equal(capability.statusCode, 503);
    assert.equal(capability.json().status, 'disabled');
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  });

  test('a throwing cache readiness probe fails the main /ready closed when required', async () => {
    const config = cacheConfig({
      KNOWN_CACHE_MODE: 'serve',
      KNOWN_CACHE_REQUIRED: 'true',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
    });
    const app = buildApiApp({
      config,
      readiness: alwaysReady,
      cacheReadiness: async () => {
        throw new Error('cache readiness probe boom');
      },
    });
    openApps.push(app);

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.json(), { status: 'not-ready' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
  });
});

describe('SYNC-Q-016 limiter capability probe', () => {
  test('reports in-process ready when no shared limiter is enabled', async () => {
    const config = cacheConfig({ KNOWN_CACHE_MODE: 'off' });
    const app = buildApiApp({ config, readiness: alwaysReady });
    openApps.push(app);
    const capability = await app.inject({ method: 'GET', url: '/ready/features/limiter' });
    assert.equal(capability.statusCode, 200);
    assert.deepEqual(capability.json(), {
      capability: 'limiter',
      status: 'ready',
      mode: 'in-process',
    });
  });
});

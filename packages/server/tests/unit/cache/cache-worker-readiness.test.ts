/**
 * T11 worker cache readiness tests (plan §5 / §6.4 T11): the Worker owns its
 * own Redis runtime and reports the cache readiness fact
 * (disabled/degraded/healthy) as a cacheReadiness() probe plus the
 * cache.worker.readiness gauge, and enforces KNOWN_CACHE_REQUIRED fail-closed
 * semantics at worker start.
 *
 * Coverage:
 * - Redis-only / CDN-only / Redis+CDN compositions report accurate purge
 *   provider readiness (durable) and cache readiness.
 * - Redis unavailable reports degraded; required=false still allows start,
 *   required=true refuses start (fail closed).
 * - mode=off reports disabled and never creates a Redis store.
 * - A missing purge provider in production fails start closed.
 */
import assert from 'node:assert/strict';
import { describe, test, vi } from 'vitest';
import { loadConfig, type AppConfig } from '../../support/test-config.js';
import {
  CACHE_WORKER_READINESS_GAUGE,
  CACHE_WORKER_READINESS_METRIC,
  buildWorker,
  resolvePublicationCachePurgeReadinessState,
} from '../../../src/bootstrap/worker.js';
import type { DatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import {
  CompositePublicationCachePurgeProvider,
  FetchPublicationCachePurgeProvider,
} from '../../../src/infrastructure/outbox/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import { RecordingCacheStore } from '../../support/recording-cache-store.js';

const REDIS_URL = 'redis://127.0.0.1:6379/0';

function database(config: AppConfig): DatabaseRuntime {
  return {
    pool: { options: { max: config.database.maxConnections } },
    db: {},
    async verifyReady() {},
    async close() {},
  } as unknown as DatabaseRuntime;
}

function workerConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    PRODUCT_ORIGIN: 'https://app.example.test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    ...overrides,
  });
}

/**
 * Production-legal base env (mirrors http-security-baseline.test.ts /
 * redis-config.test.ts): production requires explicit OIDC/cursor secrets
 * before the worker cache assertions are even reached.
 */
function productionWorkerConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: 'postgres://unused/known',
    NODE_ENV: 'production',
    PRODUCT_ORIGIN: 'https://app.example.test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    OIDC_ISSUER: 'https://issuer.example/realms/known',
    OIDC_CLIENT_ID: 'known-web',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/v1/auth/oidc/callback',
    OIDC_AUTHORIZATION_ENDPOINT: 'https://issuer.example/realms/known/auth',
    OIDC_TOKEN_ENDPOINT: 'https://issuer.example/realms/known/token',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    OIDC_ALLOW_TEST_PROVIDER: 'false',
    OIDC_TRANSACTION_HMAC_SECRET: 'prod-oidc-transaction-hmac-secret-not-dev-default',
    OIDC_TRANSACTION_ENCRYPTION_KEYS: `1:oidc-pkce-prod:${Buffer.alloc(32, 5).toString('base64')}`,
    PRODUCT_EDITOR_CURSOR_HMAC_KEY: 'prod-product-editor-cursor-hmac-key-not-dev-default',
    PRODUCT_EDITOR_CURSOR_KEY_ID: 'prod-editor-v1',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_HMAC_KEY: 'prod-owned-collections-cursor-key-not-dev-default',
    PRODUCT_OWNED_COLLECTIONS_CURSOR_KEY_ID: 'prod-owned-v1',
    PRODUCT_LINK_HEALTH_CURSOR_HMAC_KEY: 'prod-link-health-cursor-hmac-key-not-dev-default',
    PRODUCT_LINK_HEALTH_CURSOR_KEY_ID: 'prod-link-health-v1',
    PRODUCT_CLASSIFY_INBOX_CURSOR_HMAC_KEY: 'prod-classify-inbox-cursor-hmac-key-not-dev-default',
    PRODUCT_CLASSIFY_INBOX_CURSOR_KEY_ID: 'prod-classify-inbox-v1',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_HMAC_KEY: 'prod-collection-versions-cursor-hmac-key-not-dev-default',
    PRODUCT_COLLECTION_VERSIONS_CURSOR_KEY_ID: 'prod-collection-versions-v1',
    PUBLISHING_INSIGHTS_VISITOR_HMAC_KEY: 'prod-publishing-insights-visitor-hmac-key-32b',
    PUBLISHING_INSIGHTS_RATELIMIT_HMAC_KEY: 'prod-publishing-insights-ratelimit-hmac-key-32b',
    COLLABORATION_INVITE_RATE_LIMIT_KEY_SECRET: 'prod-collaboration-invite-rate-limit-hmac',
    PRODUCT_EDITOR_CURSOR_ISSUANCE_FORMAT: 'keyed',
    PUBLICATION_SERVER_UUID: '019f9031-c541-74d0-bc83-15a5526fbb54',
    PUBLICATION_CURSOR_ACTIVE_KEY_ID: 'prod-publication-v1',
    PUBLICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 17).toString('base64'),
    FOLLOW_CURSOR_ACTIVE_KEY_ID: 'prod-follow-v1',
    FOLLOW_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 19).toString('base64'),
    FEED_CURSOR_ACTIVE_KEY_ID: 'prod-feed-v1',
    FEED_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 21).toString('base64'),
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_KEY_ID: 'prod-public-activity-v1',
    PUBLIC_ACTIVITY_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 27).toString('base64'),
    NOTIFICATION_CURSOR_ACTIVE_KEY_ID: 'prod-notification-v1',
    NOTIFICATION_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 23).toString('base64'),
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_KEY_ID: 'prod-followed-collections-v1',
    FOLLOWED_COLLECTIONS_CURSOR_ACTIVE_SECRET: Buffer.alloc(32, 37).toString('base64'),
    COMMUNITY_CURSOR_HMAC_KEY: Buffer.alloc(32, 43).toString('base64'),
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

describe('T11 worker cache readiness: combinations', () => {
  test('mode=off reports disabled and never creates a Redis store', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'off' });
    const metrics = new InMemoryMetrics();
    const createStore = vi.fn(() => new RecordingCacheStore());
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: createStore,
    });
    assert.equal(createStore.mock.calls.length, 0);
    assert.equal(await worker.cacheReadiness(), 'disabled');
    assert.equal(metrics.get(CACHE_WORKER_READINESS_METRIC), CACHE_WORKER_READINESS_GAUGE.disabled);
    await worker.stop();
  });

  test('Redis-only (serve, no CDN) reports healthy cache and durable purge readiness', async () => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      NODE_ENV: 'development',
    });
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => new RecordingCacheStore({ health: 'healthy' }),
    });
    assert.equal(await worker.cacheReadiness(), 'healthy');
    assert.equal(metrics.get(CACHE_WORKER_READINESS_METRIC), CACHE_WORKER_READINESS_GAUGE.healthy);
    assert.ok(worker.publicationCachePurgeProvider instanceof CompositePublicationCachePurgeProvider);
    const composite = worker.publicationCachePurgeProvider as CompositePublicationCachePurgeProvider;
    assert.equal(composite.cdnConfigured, false, 'Redis-only must not pretend a CDN exists');
    assert.equal(resolvePublicationCachePurgeReadinessState(composite), 'durable');
    assert.deepEqual(worker.outbox?.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 6,
      durableCount: 6,
      allDurable: true,
      state: 'durable',
    });
    await worker.stop();
  });

  test('CDN-only (off + CDN endpoint) reports disabled cache and durable purge readiness', async () => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: 'off',
      PUBLICATION_CACHE_PURGE_ENDPOINT: 'https://purge.example.test/v1/cache',
    });
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => new RecordingCacheStore(),
    });
    assert.equal(await worker.cacheReadiness(), 'disabled');
    assert.equal(metrics.get(CACHE_WORKER_READINESS_METRIC), CACHE_WORKER_READINESS_GAUGE.disabled);
    assert.ok(worker.publicationCachePurgeProvider instanceof FetchPublicationCachePurgeProvider);
    assert.equal(resolvePublicationCachePurgeReadinessState(worker.publicationCachePurgeProvider), 'durable');
    assert.deepEqual(worker.outbox?.projectionReadiness().publicationCachePurge, {
      configured: true,
      routeCount: 6,
      durableCount: 6,
      allDurable: true,
      state: 'durable',
    });
    await worker.stop();
  });

  test('Redis+CDN (serve + CDN) reports healthy and wires both arms', async () => {
    const config = workerConfig({ KNOWN_CACHE_MODE: 'serve', REDIS_URL });
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => new RecordingCacheStore({ health: 'healthy' }),
      publicationCachePurgeProvider: { async purge() {} },
    });
    assert.equal(await worker.cacheReadiness(), 'healthy');
    assert.equal(metrics.get(CACHE_WORKER_READINESS_METRIC), CACHE_WORKER_READINESS_GAUGE.healthy);
    const composite = worker.publicationCachePurgeProvider as CompositePublicationCachePurgeProvider;
    assert.equal(composite.cdnConfigured, true);
    assert.equal(resolvePublicationCachePurgeReadinessState(composite), 'durable');
    await worker.stop();
  });
});

describe('T11 worker cache readiness: degraded and required fail-closed', () => {
  test('Redis unavailable reports degraded; required=false still starts', async () => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      KNOWN_CACHE_REQUIRED: 'false',
    });
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, undefined, metrics, {
      createCacheStore: () => new RecordingCacheStore({ health: 'degraded', failCommands: true }),
    });
    assert.equal(await worker.cacheReadiness(), 'degraded');
    assert.equal(metrics.get(CACHE_WORKER_READINESS_METRIC), CACHE_WORKER_READINESS_GAUGE.degraded);
    // required=false never blocks start; degraded is a status fact, not a boot failure.
    await worker.start();
    assert.equal(await worker.cacheReadiness(), 'degraded');
    await worker.stop();
  });

  test('required=true fails start closed when Redis is degraded', async () => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: 'serve',
      REDIS_URL,
      KNOWN_CACHE_REQUIRED: 'true',
    });
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, undefined, metrics, {
      createCacheStore: () => new RecordingCacheStore({ health: 'degraded', failCommands: true }),
    });
    await assert.rejects(worker.start(), /KNOWN_CACHE_REQUIRED=true/u);
    assert.equal(metrics.get(CACHE_WORKER_READINESS_METRIC), CACHE_WORKER_READINESS_GAUGE.degraded);
    await worker.stop();
  });

  test('required=true fails start closed when the cache is disabled (mode=off)', async () => {
    const config = workerConfig({
      KNOWN_CACHE_MODE: 'off',
      KNOWN_CACHE_REQUIRED: 'true',
    });
    const worker = buildWorker(config, undefined, new InMemoryMetrics(), {
      createCacheStore: () => new RecordingCacheStore(),
    });
    await assert.rejects(worker.start(), /KNOWN_CACHE_REQUIRED=true/u);
    await worker.stop();
  });

  test('provider missing in production fails start closed and reports disabled cache', async () => {
    const config = productionWorkerConfig();
    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, database(config), metrics, {
      createCacheStore: () => new RecordingCacheStore(),
    });
    assert.equal(worker.publicationCachePurgeProvider, undefined);
    assert.equal(await worker.cacheReadiness(), 'disabled');
    await assert.rejects(worker.start(), /publicationCachePurgeConfigured=false/u);
    await worker.stop();
  });
});

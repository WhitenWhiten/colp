import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  loadConfig,
  sanitizedRuntimeCapacity,
} from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { createDatabasePoolConfig, createDatabaseRuntime } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://operator:s3cret-value@db.example:5432/known',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
} as const;

describe('runtime concurrency configuration', () => {
  test('supplies safe defaults for database pool and worker capacity', () => {
    const config = loadConfig({ ...BASE_ENV });
    assert.deepEqual(config.database, {
      maxConnections: 10,
      connectionTimeoutMs: 2_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 5_000,
      idleTransactionTimeoutMs: 15_000,
    });
    assert.deepEqual(config.worker, {
      batchSize: 1,
      pollIntervalMs: 250,
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
      handlerTimeoutMs: 30_000,
      concurrency: 1,
    });
    assert.deepEqual(config.publisherReceipts, {
      cleanupIntervalMs: 60_000,
      cleanupBatchSize: 100,
    });
    assert.deepEqual(config.publicationInsightRetention, {
      cleanupIntervalMs: 60_000,
      cleanupBatchSize: 5_000,
    });
    assert.deepEqual(config.syncTombstonePurge, {
      enabled: false,
      intervalMs: 60_000,
      batchSize: 20_000,
      leaseDurationMs: 30_000,
    });
  });

  test('accepts operator-tuned bounds within absolute ceilings', () => {
    const config = loadConfig({
      ...BASE_ENV,
      DATABASE_POOL_MAX: '8',
      DATABASE_CONNECTION_TIMEOUT_MS: '1500',
      DATABASE_IDLE_TIMEOUT_MS: '12000',
      DATABASE_STATEMENT_TIMEOUT_MS: '9000',
      DATABASE_LOCK_TIMEOUT_MS: '2500',
      DATABASE_IDLE_TX_TIMEOUT_MS: '8000',
      WORKER_CONCURRENCY: '4',
      WORKER_BATCH_SIZE: '2',
      WORKER_POLL_INTERVAL_MS: '100',
      WORKER_LEASE_DURATION_MS: '40000',
      WORKER_HEARTBEAT_INTERVAL_MS: '5000',
      WORKER_HANDLER_TIMEOUT_MS: '15000',
      PUBLISHER_RECEIPT_CLEANUP_INTERVAL_MS: '30000',
      PUBLISHER_RECEIPT_CLEANUP_BATCH_SIZE: '250',
      PUBLICATION_INSIGHT_CLEANUP_INTERVAL_MS: '45000',
      PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE: '2500',
      SYNC_TOMBSTONE_PURGE_ENABLED: 'true',
      SYNC_TOMBSTONE_PURGE_INTERVAL_MS: '45000',
      SYNC_TOMBSTONE_PURGE_BATCH_SIZE: '500',
      SYNC_TOMBSTONE_PURGE_LEASE_DURATION_MS: '20000',
    });
    assert.equal(config.database.maxConnections, 8);
    assert.equal(config.database.connectionTimeoutMs, 1_500);
    assert.equal(config.worker.concurrency, 4);
    assert.equal(config.worker.batchSize, 2);
    assert.equal(config.worker.pollIntervalMs, 100);
    assert.equal(config.worker.leaseDurationMs, 40_000);
    assert.equal(config.worker.heartbeatIntervalMs, 5_000);
    assert.equal(config.worker.handlerTimeoutMs, 15_000);
    assert.deepEqual(config.publisherReceipts, {
      cleanupIntervalMs: 30_000,
      cleanupBatchSize: 250,
    });
    assert.deepEqual(config.publicationInsightRetention, {
      cleanupIntervalMs: 45_000,
      cleanupBatchSize: 2_500,
    });
    assert.deepEqual(config.syncTombstonePurge, {
      enabled: true, intervalMs: 45_000, batchSize: 500, leaseDurationMs: 20_000,
    });
    assert.throws(() => buildWorker(config), /Sync Tombstone purge requires PostgreSQL/);

    const pool = createDatabasePoolConfig(config.databaseUrl, {
      maxConnections: config.database.maxConnections,
      connectionTimeoutMs: config.database.connectionTimeoutMs,
      idleTimeoutMs: config.database.idleTimeoutMs,
      statementTimeoutMs: config.database.statementTimeoutMs,
      lockTimeoutMs: config.database.lockTimeoutMs,
      idleTransactionTimeoutMs: config.database.idleTransactionTimeoutMs,
    });
    assert.equal(pool.max, 8);
    assert.equal(pool.connectionTimeoutMillis, 1_500);
    assert.equal(pool.statement_timeout, 9_000);
    assert.equal(pool.lock_timeout, 2_500);
  });

  test('rejects invalid individual bounds', () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, DATABASE_POOL_MAX: '0' }),
      /DATABASE_POOL_MAX must be a safe integer >= 1/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, DATABASE_POOL_MAX: '201' }),
      /DATABASE_POOL_MAX must be <= 200/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, WORKER_CONCURRENCY: '0' }),
      /WORKER_CONCURRENCY must be a safe integer >= 1/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, WORKER_CONCURRENCY: '65' }),
      /WORKER_CONCURRENCY must be <= 64/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, WORKER_BATCH_SIZE: '0' }),
      /WORKER_BATCH_SIZE must be a safe integer >= 1/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, WORKER_POLL_INTERVAL_MS: '-1' }),
      /WORKER_POLL_INTERVAL_MS must be a safe integer >= 1/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, WORKER_LEASE_DURATION_MS: 'not-a-number' }),
      /WORKER_LEASE_DURATION_MS must be a safe integer >= 1/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, PUBLISHER_RECEIPT_CLEANUP_BATCH_SIZE: '10001' }),
      /PUBLISHER_RECEIPT_CLEANUP_BATCH_SIZE must be <= 10000/,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE: '10001' }),
      /PUBLICATION_INSIGHT_CLEANUP_BATCH_SIZE must be <= 10000/,
    );
  });

  test('rejects worker concurrency that exceeds database pool capacity', () => {
    assert.throws(
      () => loadConfig({
        ...BASE_ENV,
        DATABASE_POOL_MAX: '2',
        WORKER_CONCURRENCY: '3',
      }),
      /WORKER_CONCURRENCY \(3\) must be <= DATABASE_POOL_MAX \(2\)/,
    );
  });

  test('rejects batch size above concurrency and invalid lease/heartbeat pairs', () => {
    assert.throws(
      () => loadConfig({
        ...BASE_ENV,
        WORKER_CONCURRENCY: '2',
        WORKER_BATCH_SIZE: '3',
      }),
      /WORKER_BATCH_SIZE \(3\) must be <= WORKER_CONCURRENCY \(2\)/,
    );
    assert.throws(
      () => loadConfig({
        ...BASE_ENV,
        WORKER_LEASE_DURATION_MS: '1000',
        WORKER_HEARTBEAT_INTERVAL_MS: '1000',
      }),
      /WORKER_HEARTBEAT_INTERVAL_MS \(1000\) must be < WORKER_LEASE_DURATION_MS \(1000\)/,
    );
    assert.throws(
      () => loadConfig({
        ...BASE_ENV,
        WORKER_LEASE_DURATION_MS: '5000',
        WORKER_HEARTBEAT_INTERVAL_MS: '1000',
        WORKER_HANDLER_TIMEOUT_MS: '6000',
      }),
      /WORKER_HANDLER_TIMEOUT_MS \(6000\) must be <= WORKER_LEASE_DURATION_MS \(5000\)/,
    );
  });

  test('sanitized capacity telemetry never includes credentials or database URLs', () => {
    const config = loadConfig({
      ...BASE_ENV,
      DATABASE_POOL_MAX: '6',
      WORKER_CONCURRENCY: '2',
      WORKER_BATCH_SIZE: '2',
    });
    const capacity = sanitizedRuntimeCapacity(config);
    const serialized = JSON.stringify(capacity);
    assert.doesNotMatch(serialized, /s3cret-value/);
    assert.doesNotMatch(serialized, /postgres:\/\//);
    assert.doesNotMatch(serialized, /db\.example/);
    // Value-level credential guard: field names (e.g. `keySecretConfigured`) are
    // never inspected — only the serialized VALUES may not carry the database
    // URL or credential-like content. `secret` is exact-matched so legitimate
    // values such as the OIDC `client_secret_post` auth mode stay valid while a
    // literal secret/password value still fails.
    const capacityValues: string[] = [];
    const collectValues = (value: unknown): void => {
      if (typeof value === 'string') capacityValues.push(value);
      else if (Array.isArray(value)) value.forEach(collectValues);
      else if (value && typeof value === 'object') Object.values(value).forEach(collectValues);
    };
    collectValues(capacity);
    assert.ok(
      capacityValues.every(
        (value) =>
          value !== BASE_ENV.DATABASE_URL
          && !/^(?:DATABASE_URL|secret)$/i.test(value)
          && !/password/i.test(value),
      ),
      `capacity values must not include the database URL or credential values: ${JSON.stringify(capacityValues)}`,
    );
    assert.equal(capacity.database.maxConnections, 6);
    assert.equal(capacity.worker.concurrency, 2);
    assert.equal(capacity.worker.batchSize, 2);

    const metrics = new InMemoryMetrics();
    const worker = buildWorker(config, undefined, metrics);
    assert.deepEqual(worker.capacity, capacity);
    assert.equal(metrics.get('database.pool_max'), 6);
    assert.equal(metrics.get('outbox.worker_concurrency'), 2);
    assert.equal(metrics.get('outbox.worker_batch_size'), 2);
    assert.equal(metrics.get('publisher.receipt_replay_window_seconds'), 86_400);
    assert.equal(metrics.get('publisher.receipt_cleanup_batch_size'), 100);
    assert.equal(metrics.get('publisher.receipt_cleanup_interval_ms'), 60_000);
  });

  test('worker composition refuses a live pool smaller than configured concurrency', async () => {
    // Pool 6 keeps the T-06 connection budget green (4 <= 6 - 2); the refusal
    // under test is buildWorker against the mis-wired LIVE pool max below.
    const config = loadConfig({
      ...BASE_ENV,
      DATABASE_POOL_MAX: '6',
      WORKER_CONCURRENCY: '4',
      WORKER_BATCH_SIZE: '2',
    });
    // Simulate a mis-wired runtime whose actual pool max is below config.
    const database = createDatabaseRuntime(config.databaseUrl, {
      maxConnections: 1,
      connectionTimeoutMs: 50,
      applicationName: 'known-concurrency-mismatch-test',
    });
    try {
      assert.throws(
        () => buildWorker(config, database),
        /worker composition refused: WORKER_CONCURRENCY \(4\) exceeds database pool max \(1\)/,
      );
    } finally {
      await database.close();
    }
  });
});

describe('database pool backpressure policy', () => {
  test('pool config applies finite max and connection timeout for exhaustion backpressure', () => {
    const config = createDatabasePoolConfig('postgres://localhost/known', {
      maxConnections: 2,
      connectionTimeoutMs: 250,
    });
    assert.equal(config.max, 2);
    assert.equal(config.connectionTimeoutMillis, 250);
    assert.notEqual(config.connectionTimeoutMillis, 0);
  });

  test('pool acquire fails closed within a bounded wait against an unreachable endpoint', async () => {
    // Port 1 refuses connections: proves checkout does not hang unbounded when the
    // pool cannot obtain a client. connectionTimeoutMs remains the operator control
    // for saturation waits when the peer is slow rather than refused.
    const runtime = createDatabaseRuntime('postgres://known:known@127.0.0.1:1/known', {
      maxConnections: 1,
      connectionTimeoutMs: 200,
      applicationName: 'known-pool-exhaustion-test',
    });
    try {
      const started = performance.now();
      await assert.rejects(
        () => runtime.pool.query('select 1'),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return /ECONNREFUSED|timeout|connect/i.test(message);
        },
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 3_000, `pool wait exceeded 3s (elapsed=${elapsed})`);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  loadConfig,
} from '../../support/test-config.js';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import {
  PostgresSyncEvidenceMaintenanceCoordinator,
  SyncEvidenceMaintenanceJob,
} from '../../../src/infrastructure/sync/index.js';
import {
  applySyncEvidenceMaintenanceMetrics,
  SYNC_EVIDENCE_MAINTENANCE_METRICS,
  type SyncEvidenceMaintenanceCoordinator,
  type SyncEvidenceMaintenanceResult,
} from '../../../src/modules/sync/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';

const BASE_ENV = { DATABASE_URL: 'postgres://operator:s3cret-value@db.example:5432/known',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs' } as const;

const EMPTY_RESULT: SyncEvidenceMaintenanceResult = Object.freeze({
  attempted: 0, deleted: 0, redacted: 0, skipped: 0, errors: 0, oldestExpiredAgeMs: 0,
});

describe('R15 sync evidence maintenance configuration', () => {
  test('supplies behavior-preserving defaults with the worker disabled', () => {
    const config = loadConfig({ ...BASE_ENV });
    assert.deepEqual(config.syncEvidenceMaintenance, {
      enabled: false,
      intervalMs: 60_000,
      batchSize: 500,
      leaseDurationMs: 30_000,
    });
  });

  test('accepts operator-tuned bounds within absolute ceilings', () => {
    const config = loadConfig({
      ...BASE_ENV,
      SYNC_EVIDENCE_MAINTENANCE_ENABLED: 'true',
      SYNC_EVIDENCE_MAINTENANCE_INTERVAL_MS: '45000',
      SYNC_EVIDENCE_MAINTENANCE_BATCH_SIZE: '250',
      SYNC_EVIDENCE_MAINTENANCE_LEASE_DURATION_MS: '20000',
    });
    assert.deepEqual(config.syncEvidenceMaintenance, {
      enabled: true, intervalMs: 45_000, batchSize: 250, leaseDurationMs: 20_000,
    });
  });

  test('rejects invalid enablement and out-of-range bounds', () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SYNC_EVIDENCE_MAINTENANCE_ENABLED: 'yes' }),
      /SYNC_EVIDENCE_MAINTENANCE_ENABLED must be true or false/u,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SYNC_EVIDENCE_MAINTENANCE_BATCH_SIZE: '0' }),
      /SYNC_EVIDENCE_MAINTENANCE_BATCH_SIZE must be a safe integer >= 1/u,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SYNC_EVIDENCE_MAINTENANCE_BATCH_SIZE: '20001' }),
      /SYNC_EVIDENCE_MAINTENANCE_BATCH_SIZE must be <= 20000/u,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SYNC_EVIDENCE_MAINTENANCE_INTERVAL_MS: '-1' }),
      /SYNC_EVIDENCE_MAINTENANCE_INTERVAL_MS must be a safe integer >= 1/u,
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, SYNC_EVIDENCE_MAINTENANCE_LEASE_DURATION_MS: 'not-a-number' }),
      /SYNC_EVIDENCE_MAINTENANCE_LEASE_DURATION_MS must be a safe integer >= 1/u,
    );
  });

  test('disabled default keeps worker composition off-safe (R14 behavior unchanged)', async () => {
    const worker = buildWorker(loadConfig({ ...BASE_ENV }));
    await worker.start();
    await worker.stop();
    assert.equal(loadConfig({ ...BASE_ENV }).syncEvidenceMaintenance.enabled, false);
  });

  test('enabled maintenance requires a PostgreSQL runtime at composition time', () => {
    assert.throws(
      () => buildWorker(loadConfig({ ...BASE_ENV, SYNC_EVIDENCE_MAINTENANCE_ENABLED: 'true' })),
      /Sync Evidence maintenance requires PostgreSQL/u,
    );
  });

  test('coordinator constructor rejects malformed options', () => {
    const db = {} as Parameters<typeof PostgresSyncEvidenceMaintenanceCoordinator>[0];
    assert.throws(
      () => new PostgresSyncEvidenceMaintenanceCoordinator(db, {
        workerId: '', batchSize: 1, leaseDurationMs: 1,
      }),
      /Invalid Sync Evidence maintenance coordinator options/u,
    );
    assert.throws(
      () => new PostgresSyncEvidenceMaintenanceCoordinator(db, {
        workerId: 'worker', batchSize: 0, leaseDurationMs: 1,
      }),
      /Invalid Sync Evidence maintenance coordinator options/u,
    );
    assert.throws(
      () => new PostgresSyncEvidenceMaintenanceCoordinator(db, {
        workerId: 'worker', batchSize: 1, leaseDurationMs: 0,
      }),
      /Invalid Sync Evidence maintenance coordinator options/u,
    );
  });
});

describe('R15 sync evidence maintenance metrics contract', () => {
  test('publishes exactly the sync.evidence_maintenance.* counters and gauge', () => {
    const metrics = new InMemoryMetrics();
    applySyncEvidenceMaintenanceMetrics(metrics, {
      attempted: 4, deleted: 2, redacted: 1, skipped: 1, errors: 0, oldestExpiredAgeMs: 43_200_000,
    });
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.runs), 1);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.attempted), 4);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.deleted), 2);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.redacted), 1);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.skipped), 1);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.errors), 0);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.oldestExpiredAge), 43_200_000);
    // The metric name set is closed and stable.
    assert.deepEqual(Object.values(SYNC_EVIDENCE_MAINTENANCE_METRICS).sort(), [
      'sync.evidence_maintenance.attempted',
      'sync.evidence_maintenance.deleted',
      'sync.evidence_maintenance.errors',
      'sync.evidence_maintenance.oldest_expired_age',
      'sync.evidence_maintenance.redacted',
      'sync.evidence_maintenance.runs',
      'sync.evidence_maintenance.skipped',
    ]);
  });

  test('accumulates counters across repeated runs', () => {
    const metrics = new InMemoryMetrics();
    applySyncEvidenceMaintenanceMetrics(metrics, EMPTY_RESULT);
    applySyncEvidenceMaintenanceMetrics(metrics, EMPTY_RESULT);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.runs), 2);
    assert.equal(metrics.get(SYNC_EVIDENCE_MAINTENANCE_METRICS.attempted), 0);
  });
});

describe('R15 sync evidence maintenance job', () => {
  test('ticks a completed run through onResult and keeps results observable', async () => {
    const results: SyncEvidenceMaintenanceResult[] = [];
    const coordinator: SyncEvidenceMaintenanceCoordinator = {
      async runBatch() { return EMPTY_RESULT; },
    };
    const job = new SyncEvidenceMaintenanceJob(coordinator, {
      intervalMs: 60_000,
      onResult(result) { results.push(result); },
    });
    await job.tick();
    await job.tick();
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], EMPTY_RESULT);
  });

  test('skips a tick while a previous run is still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const coordinator: SyncEvidenceMaintenanceCoordinator = {
      async runBatch() { calls += 1; await gate; return EMPTY_RESULT; },
    };
    const job = new SyncEvidenceMaintenanceJob(coordinator, { intervalMs: 60_000 });
    const first = job.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await job.tick();
    release();
    await first;
    assert.equal(calls, 1);
  });

  test('reports coordinator failures through onError and stays runnable', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const coordinator: SyncEvidenceMaintenanceCoordinator = {
      async runBatch() {
        calls += 1;
        if (calls === 1) throw new Error('run:boom');
        return EMPTY_RESULT;
      },
    };
    const job = new SyncEvidenceMaintenanceJob(coordinator, {
      intervalMs: 60_000,
      onError(error) { errors.push(error); },
    });
    await job.tick();
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /run:boom/u);
    await job.tick();
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
  });

  test('start/stop manage an unref timer idempotently', () => {
    const job = new SyncEvidenceMaintenanceJob(
      { async runBatch() { return EMPTY_RESULT; } },
      { intervalMs: 60_000 },
    );
    job.start();
    job.start();
    job.stop();
    job.stop();
  });

  test('rejects a non-positive interval', () => {
    assert.throws(
      () => new SyncEvidenceMaintenanceJob(
        { async runBatch() { return EMPTY_RESULT; } },
        { intervalMs: 0 },
      ),
      /Invalid maintenance interval/u,
    );
  });
});

describe('FIX-L-034 Sync tombstone retention protocol floor', () => {
  test('defaults to the 30-day protocol minimum when not configured', () => {
    const config = loadConfig(syncEnv());
    assert.equal(config.syncSession?.tombstoneRetentionSeconds, 2_592_000);
    assert.equal(config.publication.sync?.cursorRetentionSeconds, 2_592_000);
  });

  test('accepts the 30-day boundary and any longer retention', () => {
    for (const seconds of ['2592000', '2592001', '31536000']) {
      const config = loadConfig(syncEnv({ SYNC_TOMBSTONE_RETENTION_SECONDS: seconds }));
      assert.equal(config.syncSession?.tombstoneRetentionSeconds, Number(seconds));
      assert.equal(config.publication.sync?.cursorRetentionSeconds, Number(seconds));
    }
  });

  test('rejects every value below the 30-day protocol floor', () => {
    for (const seconds of ['1', '86399', '2591999']) {
      assert.throws(
        () => loadConfig(syncEnv({ SYNC_TOMBSTONE_RETENTION_SECONDS: seconds })),
        /SYNC_TOMBSTONE_RETENTION_SECONDS must be a safe integer >= 2592000/u,
      );
    }
    assert.throws(
      () => loadConfig(syncEnv({ SYNC_TOMBSTONE_RETENTION_SECONDS: 'not-a-number' })),
      /SYNC_TOMBSTONE_RETENTION_SECONDS must be a safe integer >= 2592000/u,
    );
  });

  test('disabled Sync sessions skip the retention contract without failing', () => {
    const config = loadConfig({ ...BASE_ENV, SYNC_SESSION_ENABLED: 'false',
      SYNC_TOMBSTONE_RETENTION_SECONDS: '1' });
    assert.equal(config.syncSession, undefined);
    assert.equal(config.publication.sync, undefined);
  });
});

function syncEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test', DATABASE_URL: 'postgres://unused/known', LOG_LEVEL: 'silent',
    OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
    PRODUCT_ORIGIN: 'https://known.example', PUBLICATION_ORIGIN: 'https://known.example',
    SYNC_SESSION_ENABLED: 'true', SYNC_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop',
    SYNC_OAUTH_ISSUER: 'https://issuer.example.test', SYNC_OAUTH_CLIENT_ID: 'known-extension',
    SYNC_OAUTH_AUDIENCE: 'known-sync-api',
    SYNC_OAUTH_AUTHORIZATION_ENDPOINT: 'https://issuer.example.test/oauth2/authorize',
    SYNC_OAUTH_TOKEN_ENDPOINT: 'https://issuer.example.test/oauth2/token',
    SYNC_OAUTH_JWKS_URI: 'https://issuer.example.test/.well-known/jwks.json',
    SYNC_OAUTH_REDIRECT_URI: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/callback',
    SYNC_OAUTH_SCOPES: 'openid known.sync', SYNC_OAUTH_ALGORITHMS: 'RS256',
    SYNC_SESSION_REPLAY_KEY: Buffer.alloc(32, 23).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY: Buffer.alloc(32, 29).toString('base64'),
    SYNC_SNAPSHOT_CURSOR_KEY_ID: 'test-sync-snapshot-v1',
    SYNC_PULL_CURSOR_KEY_ID: 'test-sync-pull-v1',
    SYNC_PULL_CURSOR_KEY: Buffer.alloc(32, 41).toString('base64'),
    SYNC_RECOVERY_CAPABILITY_KEY_ID: 'recovery-v1',
    SYNC_RECOVERY_CAPABILITY_KEY: Buffer.alloc(32, 44).toString('base64'),
    SYNC_PULL_LINEAGE_KEY_ID: 'lineage-v1',
    SYNC_PULL_LINEAGE_KEY: Buffer.alloc(32, 47).toString('base64'),
    ...overrides,
  };
}

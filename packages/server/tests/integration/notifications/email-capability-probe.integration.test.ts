import assert from 'node:assert/strict';
import { afterAll, beforeAll, test } from 'vitest';
import { buildWorker } from '../../../src/bootstrap/worker.js';
import { loadConfig } from '../../support/test-config.js';
import { createDatabaseRuntime, runMigrations } from '../../../src/infrastructure/database/index.js';
import { AliyunDirectMailAdapter } from '../../../src/infrastructure/email/index.js';
import {
  loadEmailEntryReplayManifest,
  startEmailEntryFixture,
  type StartedEmailEntryFixture,
} from '../../../scripts/evidence/phase5-email-entry-fixture.js';
import { createPostgresNotificationOperationsRepository } from '../../../src/infrastructure/notifications/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  buildEmailCapabilityProbeDependencies,
  runEmailCapabilityProbe,
} from '../../../scripts/email-capability-probe.js';
import { createIsolatedPostgresRuntime, describeWithPostgres,
  type IsolatedPostgresRuntime } from '../../support/postgres-test-runtime.js';

const TAG_PREFIX = 'p531-probe-';

describeWithPostgres('P5-31 deployment probe against a composed worker + controlled fixture', () => {
  let isolated!: IsolatedPostgresRuntime;
  let fixture!: StartedEmailEntryFixture;
  let manifest!: ReturnType<typeof loadEmailEntryReplayManifest>;
  let metrics!: InMemoryMetrics;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase5_email_probe', { maxConnections: 12 });
    await runMigrations(isolated.runtime.db, 'latest');
    manifest = loadEmailEntryReplayManifest();
    fixture = await startEmailEntryFixture({
      accessKeyId: manifest.fixedInputs.accessKeyId,
      signingKeyMaterial: manifest.fixedInputs.signingKeyMaterial,
      sender: manifest.fixedInputs.sender,
      recipient: manifest.fixedInputs.recipient,
      timeoutDelayMs: 5_000,
    });
    metrics = new InMemoryMetrics();
  }, 120_000);

  afterAll(async () => {
    await fixture?.close();
    await isolated?.close();
  });

  function emailConfig(overrides: Record<string, string> = {}) {
    return loadConfig({
      DATABASE_URL: isolated.databaseUrl,
      LOG_LEVEL: 'silent',
      NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true',
      OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      KNOWN_FEATURE_EMAIL: 'true',
      EMAIL_DM_ACCOUNT_NAME: manifest.fixedInputs.sender,
      EMAIL_DM_ENDPOINT: fixture.origin,
      EMAIL_DM_TIMEOUT_MS: '700',
      EMAIL_DM_TAG_PREFIX: TAG_PREFIX,
      EMAIL_DM_MAX_TAG_CHARS: '128',
      EMAIL_DM_CALLBACK_HMAC_SECRET: `p531_probe_${'s'.repeat(8)}`,
      EMAIL_DELIVERY_MAX_ATTEMPTS: '3',
      EMAIL_DELIVERY_BASE_BACKOFF_MS: '1000',
      EMAIL_DELIVERY_MAX_BACKOFF_MS: '1000',
      EMAIL_DELIVERY_POLL_INTERVAL_MS: '100',
      EMAIL_DELIVERY_LEASE_DURATION_MS: '2000',
      EMAIL_DELIVERY_HEARTBEAT_INTERVAL_MS: '200',
      EMAIL_DELIVERY_BATCH_SIZE: '4',
      WORKER_CONCURRENCY: '2',
      WORKER_BATCH_SIZE: '2',
      WORKER_POLL_INTERVAL_MS: '5',
      WORKER_LEASE_DURATION_MS: '500',
      WORKER_HEARTBEAT_INTERVAL_MS: '100',
      FEED_REBUILD_TIMEOUT_MS: '400',
      NOTIFICATION_RECOVERY_TIMEOUT_MS: '400',
      WORKER_HANDLER_TIMEOUT_MS: '450',
      ...overrides,
    });
  }

  function buildProbeWorker(config: ReturnType<typeof loadConfig>, metrics: InMemoryMetrics,
    provider?: AliyunDirectMailAdapter) {
    const database = createDatabaseRuntime(isolated.databaseUrl, {
      maxConnections: 4,
      applicationName: 'known-p5-31-probe-worker',
    });
    const worker = buildWorker(config, database, metrics,
      provider === undefined ? {} : { emailDelivery: { provider } });
    return { worker, database };
  }

  test('probe passes green against the composed production worker + controlled fixture', async () => {
    const config = emailConfig();
    const provider = new AliyunDirectMailAdapter({
      endpoint: fixture.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      fixtureTls: true,
      callbackHmacSecret: config.email!.callback.hmacSecret!,
    });
    const { worker } = buildProbeWorker(config, metrics, provider);
    try {
      const deps = buildEmailCapabilityProbeDependencies({
        config,
        database: isolated.runtime,
        worker,
        provider,
        fixture,
        env: {},
      });
      const result = await runEmailCapabilityProbe(deps);
      assert.equal(result.emailCapability, 'enabled');
      assert.equal(result.probeStatus, 'passed');
      assert.equal(result.deploymentProven, false);
      for (const [name, check] of Object.entries(result.checks)) {
        assert.equal(check.status, 'passed', `${name} must pass`);
      }
      assert.equal(result.checks.adapterReachability.mode, 'fixture');
      assert.ok(result.metricNames.includes('notifications.email_delivery.enabled'));
      assert.ok(result.metricNames.includes('notifications.email_delivery.worker_running'));
      assert.ok(result.metricNames.includes('notifications.email_delivery.probe.status'));
    } finally {
      await worker.stop().catch(() => undefined);
      await provider.close().catch(() => undefined);
    }
  });

  test('probe fails closed against a broken config (callback verifier unconfigured)', async () => {
    const config = emailConfig({ EMAIL_DM_CALLBACK_HMAC_SECRET: '' });
    const provider = new AliyunDirectMailAdapter({
      endpoint: fixture.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      fixtureTls: true,
    });
    const { worker } = buildProbeWorker(config, metrics, provider);
    try {
      const deps = buildEmailCapabilityProbeDependencies({
        config,
        database: isolated.runtime,
        worker,
        provider,
        fixture,
        env: {},
      });
      await assert.rejects(() => runEmailCapabilityProbe(deps), /callback verifier not configured/iu);
    } finally {
      await worker.stop().catch(() => undefined);
      await provider.close().catch(() => undefined);
    }
  });

  test('probe reports disabled without claiming deployment when the flag is off', async () => {
    const config = loadConfig({ DATABASE_URL: isolated.databaseUrl, NODE_ENV: 'test',
      OIDC_ALLOW_TEST_PROVIDER: 'true', OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
      LOG_LEVEL: 'silent', KNOWN_FEATURE_EMAIL: 'false' });
    const { worker } = buildProbeWorker(config, new InMemoryMetrics());
    try {
      const deps = buildEmailCapabilityProbeDependencies({ config, database: isolated.runtime, worker, env: {} });
      const result = await runEmailCapabilityProbe(deps);
      assert.equal(result.emailCapability, 'disabled');
      assert.equal(result.probeStatus, 'disabled');
      assert.equal(result.deploymentProven, false);
    } finally { await worker.stop().catch(() => undefined); }
  });

  test('probe surfaces real delivery queue health from the production operations repository', async () => {
    const config = emailConfig();
    const provider = new AliyunDirectMailAdapter({
      endpoint: fixture.origin,
      regionId: 'cn-hangzhou',
      accountName: manifest.fixedInputs.sender,
      accessKeyId: manifest.fixedInputs.accessKeyId,
      accessKeySecret: manifest.fixedInputs.signingKeyMaterial,
      timeoutMs: 700,
      tagPrefix: TAG_PREFIX,
      maxTagChars: 128,
      fixtureTls: true,
      callbackHmacSecret: config.email!.callback.hmacSecret!,
    });
    const { worker } = buildProbeWorker(config, metrics, provider);
    try {
      const ops = createPostgresNotificationOperationsRepository(isolated.runtime.pool);
      const status = await ops.inspectStatus();
      assert.equal(typeof status.delivery.pendingCount, 'number');
      const deliveryQueue = {
        pending: status.delivery.pendingCount,
        retry: status.delivery.retryCount,
        deadLetter: status.delivery.deadLetterCount,
        delivered: status.delivery.deliveredCount,
        suppressed: status.delivery.suppressedCount,
      };
      const deps = buildEmailCapabilityProbeDependencies({
        config, database: isolated.runtime, worker, provider, fixture, env: {},
        queueHealth: async () => deliveryQueue,
      });
      const result = await runEmailCapabilityProbe(deps);
      assert.deepEqual(result.checks.deliveryQueue, { status: 'passed', ...deliveryQueue });
    } finally {
      await worker.stop().catch(() => undefined);
      await provider.close().catch(() => undefined);
    }
  });
});

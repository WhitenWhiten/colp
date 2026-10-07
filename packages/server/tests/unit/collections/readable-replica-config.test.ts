import assert from 'node:assert/strict';
import { test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';

const env = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
};

test('KNOWN_FEATURE_READABLE_REPLICA defaults false and rejects illegal values', () => {
  assert.equal(loadConfig(env).readableReplica.enabled, false);
  assert.throws(
    () => loadConfig({ ...env, KNOWN_FEATURE_READABLE_REPLICA: 'yes' }),
    /KNOWN_FEATURE_READABLE_REPLICA must be true or false/u,
  );
  assert.equal(
    loadConfig({ ...env, KNOWN_FEATURE_READABLE_REPLICA: 'true' }).readableReplica.enabled,
    true,
  );
  assert.equal(
    loadConfig({ ...env, KNOWN_FEATURE_READABLE_REPLICA: 'false' }).readableReplica.enabled,
    false,
  );
});

test('probe and worker numbers default to the contracted budgets', () => {
  const { readableReplica } = loadConfig(env);
  assert.equal(Object.isFrozen(readableReplica), true);
  assert.equal(readableReplica.probeTimeoutMs, 15_000);
  assert.equal(readableReplica.connectTimeoutMs, 5_000);
  assert.equal(readableReplica.maxBodyBytes, 2_097_152);
  assert.equal(readableReplica.workerConcurrency, 2);
  assert.equal(readableReplica.perHostGapMs, 2_000);
  assert.equal(readableReplica.workerPollIntervalMs, 1_000);
  assert.equal(readableReplica.workerLeaseDurationMs, 120_000);
  assert.equal(readableReplica.enqueueCooldownMs, 60_000);
});

test('out-of-range probe timeout fails startup with the env key', () => {
  assert.throws(
    () => loadConfig({ ...env, READABLE_REPLICA_PROBE_TIMEOUT_MS: '30001' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /READABLE_REPLICA_PROBE_TIMEOUT_MS/u);
      assert.match(error.message, /must be <=/u);
      return true;
    },
  );
});

test('lease shorter than probe timeout fails startup naming both keys', () => {
  assert.throws(
    () => loadConfig({
      ...env,
      READABLE_REPLICA_WORKER_LEASE_DURATION_MS: '10000',
      READABLE_REPLICA_PROBE_TIMEOUT_MS: '15000',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /READABLE_REPLICA_WORKER_LEASE_DURATION_MS/u);
      assert.match(error.message, /READABLE_REPLICA_PROBE_TIMEOUT_MS/u);
      return true;
    },
  );
});

test('MAX_BODY_BYTES above 2 MiB and concurrency above 4 fail startup', () => {
  assert.throws(
    () => loadConfig({ ...env, READABLE_REPLICA_MAX_BODY_BYTES: '2097153' }),
    /READABLE_REPLICA_MAX_BODY_BYTES must be <=/u,
  );
  assert.throws(
    () => loadConfig({ ...env, READABLE_REPLICA_WORKER_CONCURRENCY: '5' }),
    /READABLE_REPLICA_WORKER_CONCURRENCY must be <=/u,
  );
});

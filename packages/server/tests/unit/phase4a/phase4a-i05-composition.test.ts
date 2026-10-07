/**
 * P4A-I05 composition + partial-readiness tests.
 *
 * All configs come from the REAL `loadConfig` loader (production mode included);
 * no typed object is constructed directly. Proves that a bad attachment config
 * fails closed inside the loader (before any S3 client/route could exist), that
 * a disabled attachment feature still leaves the global API ready, and that
 * partial readiness is individually observable without affecting the global
 * probe or unrelated features.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { alwaysReady } from '../../../src/infrastructure/health.js';
import { evaluateAttachmentsCapabilityReadiness } from '../../../src/modules/attachments/index.js';
import { buildApiApp } from '../../../src/transport/app.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PRODUCT_ORIGIN: 'https://app.known.example',
  LOG_LEVEL: 'silent',
};

function attachmentEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ATTACHMENTS_ENABLED: 'true',
    ATTACHMENTS_R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    ATTACHMENTS_R2_REGION: 'auto',
    ATTACHMENTS_R2_BUCKET: 'known-private-attachments',
    ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/live/',
    ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/',
    ATTACHMENTS_R2_RW_SECRET_REF: 'known/r2/rw/primary',
    ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/ro/primary',
    ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://delivery.known.test',
    ATTACHMENTS_DELIVERY_CAPABILITY_SECRET_REF: 'known/delivery/hmac/primary',
    ATTACHMENTS_DELIVERY_CAPABILITY_TTL_SECONDS: '60',
    ATTACHMENTS_GRANT_TTL_SECONDS: '60',
    ATTACHMENTS_SINGLE_PUT_MAX_BYTES: '5242880',
    ATTACHMENTS_VERIFICATION_LEASE_MS: '60000',
    ATTACHMENTS_VERIFICATION_TIMEOUT_MS: '15000',
    ATTACHMENTS_VERIFICATION_RETRY_COUNT: '2',
    ATTACHMENTS_INTENT_RETENTION_HOURS: '24',
    ATTACHMENTS_STORED_RETENTION_DAYS: '30',
    ATTACHMENTS_RETIRED_RETENTION_DAYS: '90',
    ATTACHMENTS_CLEANUP_BATCH_SIZE: '100',
    ...overrides,
  };
}

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

function buildApp(config: ReturnType<typeof loadConfig>): FastifyInstance {
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    attachmentsCapabilityReadiness: async () => evaluateAttachmentsCapabilityReadiness(config.attachments),
  });
  openApps.push(app);
  return app;
}

test('disabled default: global API stays ready and the attachments feature reports disabled', async () => {
  const config = loadConfig(baseEnv);
  assert.equal(config.attachments, undefined);
  const app = buildApp(config);
  const ready = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: 'ready' });
  const capability = await app.inject({ method: 'GET', url: '/ready/features/attachments' });
  assert.equal(capability.statusCode, 503);
  assert.deepEqual(capability.json(), { capability: 'attachments', status: 'disabled', reason: 'not_enabled' });
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
});

test('disabled mode ignores every attachment variable and still starts normally', async () => {
  const config = loadConfig({
    ...baseEnv,
    ATTACHMENTS_ENABLED: 'false',
    ATTACHMENTS_R2_ENDPOINT: 'http://broken',
    ATTACHMENTS_R2_RW_SECRET_REF: '',
    ATTACHMENTS_GRANT_TTL_SECONDS: 'bogus',
  });
  assert.equal(config.attachments, undefined);
  const app = buildApp(config);
  assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  const capability = await app.inject({ method: 'GET', url: '/ready/features/attachments' });
  assert.equal(capability.json().status, 'disabled');
});

test('enabled with a valid config reports ready and never fails the global probe', async () => {
  const config = loadConfig({ ...baseEnv, ...attachmentEnv() });
  assert.ok(config.attachments, 'valid enabled fixture must parse');
  const app = buildApp(config);
  const capability = await app.inject({ method: 'GET', url: '/ready/features/attachments' });
  assert.equal(capability.statusCode, 200);
  assert.deepEqual(capability.json(), { capability: 'attachments', status: 'ready', reason: 'none' });
  const ready = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(ready.statusCode, 200, 'an enabled attachments feature never fails the global probe');
});

test('invalid attachment config fails closed inside the loader before any composition', () => {
  const breaks: ReadonlyArray<[string, Record<string, string>]> = [
    ['missing bucket', { ATTACHMENTS_R2_BUCKET: '' }],
    ['same rw/ro reference', { ATTACHMENTS_R2_RO_SECRET_REF: 'known/r2/rw/primary' }],
    ['overlapping prefixes', { ATTACHMENTS_R2_LIVE_PREFIX: 'attachments/', ATTACHMENTS_R2_PROBE_PREFIX: 'attachments/probe/' }],
    ['same-site delivery origin', { ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://files.known.example' }],
    ['verification relationship', { ATTACHMENTS_VERIFICATION_LEASE_MS: '49999' }],
  ];
  for (const [label, overrides] of breaks) {
    assert.throws(
      () => loadConfig({ ...baseEnv, ...attachmentEnv(overrides) }),
      Error,
      `"${label}" must fail inside loadConfig, so no S3 client or route is ever constructed`,
    );
  }
});

test('partial readiness is individually observable: a failing capability probe never downs the global API', async () => {
  const config = loadConfig({ ...baseEnv, ...attachmentEnv() });
  const app = buildApiApp({
    config,
    readiness: alwaysReady,
    // Simulates the I06+ dependency probe failing (R2 unreachable): only the
    // attachments capability becomes not-ready; the global API stays ready.
    attachmentsCapabilityReadiness: async () => {
      throw new Error('r2 unavailable');
    },
  });
  openApps.push(app);
  const capability = await app.inject({ method: 'GET', url: '/ready/features/attachments' });
  assert.equal(capability.statusCode, 503);
  assert.deepEqual(capability.json(), {
    capability: 'attachments', status: 'not-ready', reason: 'dependency_unavailable',
  });
  const ready = await app.inject({ method: 'GET', url: '/ready' });
  assert.equal(ready.statusCode, 200);
});

test('unrelated email/notification dependencies never change the attachments readiness', async () => {
  const withoutEmail = loadConfig({ ...baseEnv, ...attachmentEnv() });
  const withEmail = loadConfig({
    ...baseEnv,
    ...attachmentEnv(),
    KNOWN_FEATURE_EMAIL: 'true',
    EMAIL_DM_ACCOUNT_NAME: 'no-reply@example.invalid',
  });
  assert.ok(withoutEmail.attachments && withEmail.attachments);
  assert.deepEqual(
    evaluateAttachmentsCapabilityReadiness(withEmail.attachments),
    evaluateAttachmentsCapabilityReadiness(withoutEmail.attachments),
    'email/Publication dependencies must not affect attachment readiness',
  );
});

test('the capability route is not registered when no provider is supplied (default unchanged)', async () => {
  const config = loadConfig(baseEnv);
  const app = buildApiApp({ config, readiness: alwaysReady });
  openApps.push(app);
  const capability = await app.inject({ method: 'GET', url: '/ready/features/attachments' });
  assert.equal(capability.statusCode, 404, 'the default composition must not add the attachments endpoint');
  assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
});

test('worker-shaped minimal config requires only its own variables', async () => {
  // No PRODUCT_ORIGIN, no cursor secrets: a worker only needs the DB and the
  // explicit NODE_ENV=test OIDC test-double config (test provider is never defaulted).
  const workerOff = loadConfig({ DATABASE_URL: baseEnv.DATABASE_URL, NODE_ENV: 'test', LOG_LEVEL: 'silent',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default' });
  assert.equal(workerOff.attachments, undefined);
  // Worker with attachments enabled needs only the attachment fixture on top.
  const workerOn = loadConfig({
    DATABASE_URL: baseEnv.DATABASE_URL,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    ...attachmentEnv(),
  });
  assert.ok(workerOn.attachments, 'worker-shaped config with attachments enabled must parse');
});


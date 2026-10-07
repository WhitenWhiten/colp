/**
 * P4A-I15 readiness: partial degradation of the attachments capability while
 * the API component stays ready.
 *
 * Proves:
 *  - config-only evaluation stays backward compatible (disabled / ready legacy
 *    payloads);
 *  - with live facts the payload carries per-component status for API / Worker
 *    (verification + cleanup gauges) / Delivery (host availability gauge)
 *    WITHOUT any destructive operation (the evaluator is a pure function of
 *    facts);
 *  - a delivery outage or worker backlog makes the attachments capability
 *    not-ready/degraded while components.api stays ready — partial failure
 *    never drags the API component down;
 *  - a stopped admission switch degrades only the API component (planned
 *    maintenance), not worker/delivery;
 *  - the extended payload never leaks bucket, prefix, secret refs, origin, or
 *    key material.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  evaluateAttachmentsCapabilityReadiness,
  type AttachmentsReadinessFacts,
} from '../../../src/modules/attachments/index.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_ALLOW_TEST_PROVIDER: 'true',
  OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
  PRODUCT_ORIGIN: 'https://app.known.example',
};

function enabledEnv(): Record<string, string> {
  return {
    ...baseEnv,
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
  };
}

function healthyFacts(): AttachmentsReadinessFacts {
  return {
    admission: { enabled: true },
    worker: { verificationBacklog: 10, cleanupBacklog: 5 },
    delivery: { hostAvailable: true },
  };
}

describe('P4A-I15 readiness: backward-compatible config-only evaluation', () => {
  test('disabled reports the legacy disabled payload', () => {
    const config = loadConfig(baseEnv);
    assert.deepEqual(evaluateAttachmentsCapabilityReadiness(config.attachments), {
      capability: 'attachments', status: 'disabled', reason: 'not_enabled',
    });
  });

  test('enabled without facts reports the legacy ready payload', () => {
    const config = loadConfig(enabledEnv());
    assert.deepEqual(evaluateAttachmentsCapabilityReadiness(config.attachments), {
      capability: 'attachments', status: 'ready', reason: 'none',
    });
  });
});

describe('P4A-I15 readiness: partial degradation with live facts', () => {
  test('all healthy facts report ready with every component ready', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, healthyFacts());
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.components?.api.status, 'ready');
    assert.equal(readiness.components?.worker.status, 'ready');
    assert.equal(readiness.components?.delivery.status, 'ready');
  });

  test('delivery outage makes the capability not-ready while the API component stays ready', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), delivery: { hostAvailable: false },
    });
    assert.equal(readiness.status, 'not-ready');
    assert.equal(readiness.components?.api.status, 'ready', 'partial delivery failure must not drag the API component down');
    assert.equal(readiness.components?.delivery.status, 'not-ready');
    assert.equal(readiness.components?.worker.status, 'ready');
  });

  test('a large verification backlog degrades the worker and the capability, not the API', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), worker: { verificationBacklog: 50_000, cleanupBacklog: 0 },
    });
    assert.equal(readiness.status, 'not-ready');
    assert.equal(readiness.components?.worker.status, 'not-ready');
    assert.equal(readiness.components?.api.status, 'ready');
  });

  test('a moderate verification backlog degrades the capability (not not-ready)', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), worker: { verificationBacklog: 2_000, cleanupBacklog: 0 },
    });
    assert.equal(readiness.status, 'degraded');
    assert.equal(readiness.components?.worker.status, 'degraded');
    assert.equal(readiness.components?.api.status, 'ready');
  });

  test('a stopped admission switch degrades only the API component (planned maintenance)', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), admission: { enabled: false },
    });
    assert.equal(readiness.status, 'degraded');
    assert.equal(readiness.components?.api.status, 'degraded');
    assert.equal(readiness.components?.worker.status, 'ready', 'worker stays ready while issuance is drained');
    assert.equal(readiness.components?.delivery.status, 'ready');
  });

  test('unreported gauges are marked not_reported instead of claiming health', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      admission: { enabled: true },
    });
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.components?.worker.status, 'ready');
    assert.equal(readiness.components?.worker.reason, 'not_reported');
    assert.equal(readiness.components?.delivery.reason, 'not_reported');
  });
});

describe('P4A-I15 readiness: secret hygiene of the extended payload', () => {
  test('the extended payload never leaks bucket, prefix, refs, origin, or key material', () => {
    const config = loadConfig({
      ...enabledEnv(),
      ATTACHMENTS_R2_BUCKET: 'secret-bucket-name',
      ATTACHMENTS_R2_LIVE_PREFIX: 'secret/live/',
      ATTACHMENTS_ISOLATED_DELIVERY_ORIGIN: 'https://files.example.net',
    });
    assert.ok(config.attachments);
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), delivery: { hostAvailable: false },
    });
    const serialized = JSON.stringify(readiness);
    for (const needle of ['secret-bucket-name', 'secret/live/', 'files.example.net',
      'r2.cloudflarestorage.com', 'known/r2/rw/primary', 'known/r2/ro/primary',
      'known/delivery/hmac/primary', 'accessKeyId', 'secretAccessKey', '?']) {
      assert.ok(!serialized.includes(needle), `readiness must not leak ${JSON.stringify(needle)}`);
    }
  });
});
/**
 * P4A-P10 partial readiness + fixed recovery order (plan §9 P10 item 1/7).
 *
 * Pins the attachments capability semantics when each necessary dependency
 * is stopped one by one (R2 / PostgreSQL / Redis / API / Worker / origin):
 *
 *  - R2 (`objectStore`) and PostgreSQL (`database`) are NECESSARY
 *    dependencies: their degradation fails the capability closed
 *    (`not-ready` + `dependency_unavailable`) while the API component stays
 *    ready — partial failure never drags the global API down (plan P10:
 *    "全局 API 不因 attachments 依赖故障无条件下线");
 *  - Redis `enforce + required` degrades the capability not-ready; shadow /
 *    optional enforce only degrade (existing RL04 semantics re-pinned in the
 *    combined table);
 *  - API admission stopped -> degraded `admission_stopped`; worker backlog
 *    exceeded -> not-ready `worker_unavailable`; origin (delivery host) down
 *    -> not-ready `delivery_unavailable`;
 *  - the recovery order is a FIXED production contract
 *    (secret/control -> PostgreSQL -> R2 reconcile -> Redis limiter ->
 *    Worker -> isolated origin -> admission) enforced by
 *    `ATTACHMENTS_RECOVERY_STEPS` / `assertAttachmentsRecoveryOrder`.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { loadConfig } from '../../support/test-config.js';
import {
  ATTACHMENTS_RECOVERY_STEPS,
  assertAttachmentsRecoveryOrder,
  evaluateAttachmentsCapabilityReadiness,
  type AttachmentsReadinessFacts,
} from '../../../src/modules/attachments/index.js';

const baseEnv = {
  DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
  NODE_ENV: 'test',
  OIDC_JWKS_URI: 'https://issuer.example/realms/known/certs',
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
    database: { status: 'healthy' },
    objectStore: { status: 'healthy' },
    rateLimit: { status: 'healthy', blocksAttachments: false },
  };
}

describe('P4A-P10 readiness: each dependency stopped one by one', () => {
  test('all healthy facts (including database and objectStore) report ready', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, healthyFacts());
    assert.equal(readiness.status, 'ready');
    assert.equal(readiness.reason, 'none');
    assert.equal(readiness.components?.api.status, 'ready');
    assert.equal(readiness.components?.worker.status, 'ready');
    assert.equal(readiness.components?.delivery.status, 'ready');
  });

  test('R2 stopped (objectStore degraded) fails the capability closed while the API component stays ready', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), objectStore: { status: 'degraded' },
    });
    assert.equal(readiness.status, 'not-ready', 'R2 is a necessary dependency: fail closed');
    assert.equal(readiness.reason, 'dependency_unavailable');
    assert.equal(readiness.components?.api.status, 'ready',
      'an attachments dependency failure must never drag the API component down');
  });

  test('PostgreSQL stopped (database degraded) fails the capability closed', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), database: { status: 'degraded' },
    });
    assert.equal(readiness.status, 'not-ready', 'PostgreSQL is a necessary dependency: fail closed');
    assert.equal(readiness.reason, 'dependency_unavailable');
    assert.equal(readiness.components?.api.status, 'ready');
  });

  test('Redis enforce+required degraded blocks the capability; shadow/optional only degrades', () => {
    const config = loadConfig(enabledEnv());
    const blocked = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), rateLimit: { status: 'degraded', blocksAttachments: true },
    });
    assert.equal(blocked.status, 'not-ready');
    assert.equal(blocked.reason, 'dependency_unavailable');
    const degraded = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), rateLimit: { status: 'degraded', blocksAttachments: false },
    });
    assert.equal(degraded.status, 'degraded');
  });

  test('API admission stopped degrades the capability (planned maintenance), never not-ready', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), admission: { enabled: false },
    });
    assert.equal(readiness.status, 'degraded');
    assert.equal(readiness.reason, 'admission_stopped');
    assert.equal(readiness.components?.api.status, 'degraded');
  });

  test('Worker stopped (backlog exceeded) makes the capability not-ready worker_unavailable', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), worker: { verificationBacklog: 50_000, cleanupBacklog: 0 },
    });
    assert.equal(readiness.status, 'not-ready');
    assert.equal(readiness.reason, 'worker_unavailable');
    assert.equal(readiness.components?.api.status, 'ready');
  });

  test('origin (delivery host) stopped makes the capability not-ready delivery_unavailable', () => {
    const config = loadConfig(enabledEnv());
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(), delivery: { hostAvailable: false },
    });
    assert.equal(readiness.status, 'not-ready');
    assert.equal(readiness.reason, 'delivery_unavailable');
  });

  test('a necessary dependency failure wins over a lesser verdict (fail-closed precedence)', () => {
    const config = loadConfig(enabledEnv());
    // Worker degraded + R2 stopped: the dependency failure must dominate.
    const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, {
      ...healthyFacts(),
      worker: { verificationBacklog: 2_000, cleanupBacklog: 0 },
      objectStore: { status: 'degraded' },
    });
    assert.equal(readiness.status, 'not-ready');
    assert.equal(readiness.reason, 'dependency_unavailable');
  });

  test('the capability payload never claims a global verdict and never leaks dependency details', () => {
    const config = loadConfig(enabledEnv());
    for (const facts of [
      healthyFacts(),
      { ...healthyFacts(), objectStore: { status: 'degraded' } },
      { ...healthyFacts(), database: { status: 'degraded' } },
    ]) {
      const readiness = evaluateAttachmentsCapabilityReadiness(config.attachments, facts);
      const serialized = JSON.stringify(readiness);
      assert.ok(!serialized.includes('global'), 'the payload is capability-scoped, never a global verdict');
      for (const needle of ['bucket', 'prefix', 'r2.cloudflarestorage.com', 'known/r2/rw/primary',
        'accessKeyId', 'secretAccessKey', 'postgresql://']) {
        assert.ok(!serialized.includes(needle), `readiness must not leak ${JSON.stringify(needle)}`);
      }
    }
    // The global API probe is independent: the config-only evaluation stays
    // unchanged no matter what the attachments facts say (the HTTP-level
    // proof lives in the P10 integration suite).
    const global = evaluateAttachmentsCapabilityReadiness(config.attachments);
    assert.deepEqual(global, { capability: 'attachments', status: 'ready', reason: 'none' });
  });
});

describe('P4A-P10 fixed recovery order (secret/control -> PostgreSQL -> R2 -> Redis -> Worker -> origin -> admission)', () => {
  test('the recovery step list is the sealed production contract', () => {
    assert.deepEqual(ATTACHMENTS_RECOVERY_STEPS, [
      'secret_control', 'postgres', 'r2_reconcile', 'redis_limiter', 'worker', 'isolated_origin', 'admission',
    ]);
  });

  test('the fixed full sequence validates', () => {
    assertAttachmentsRecoveryOrder(ATTACHMENTS_RECOVERY_STEPS);
  });

  test('reordered, missing, duplicated, or unknown steps are rejected (fail closed)', () => {
    const fixed = ATTACHMENTS_RECOVERY_STEPS;
    assert.throws(() => assertAttachmentsRecoveryOrder([...fixed].reverse()), /recovery_order/);
    assert.throws(() => assertAttachmentsRecoveryOrder(fixed.slice(1)), /recovery_order/);
    assert.throws(() => assertAttachmentsRecoveryOrder([...fixed, 'admission']), /recovery_order/);
    assert.throws(() => assertAttachmentsRecoveryOrder([...fixed.slice(0, 3), 'redis_limiter', 'postgres',
      ...fixed.slice(4)]), /recovery_order/);
    assert.throws(() => assertAttachmentsRecoveryOrder(['postgres', 'r2_reconcile', 'secret_control',
      'redis_limiter', 'worker', 'isolated_origin', 'admission']), /recovery_order/,
    'secret/control must come before PostgreSQL');
    assert.throws(() => assertAttachmentsRecoveryOrder(['secret_control', 'postgres', 'r2_reconcile',
      'redis_limiter', 'worker', 'isolated_origin', 'unknown']), /recovery_order/);
  });

  test('admission is the LAST recovery step: resuming admission before the dependencies are back is rejected', () => {
    assert.throws(() => assertAttachmentsRecoveryOrder(['secret_control', 'postgres', 'r2_reconcile',
      'redis_limiter', 'worker', 'admission', 'isolated_origin']), /recovery_order/);
  });
});

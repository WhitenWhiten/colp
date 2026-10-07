import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../support/test-config.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createPhase4bMcpWriteOperations,
  type Phase4bMcpWriteOperationsSnapshot,
  type Phase4bMcpWriteOperationsStorePort,
} from '../../../src/modules/mcp/index.js';
import { buildApiApp } from '../../../src/transport/app.js';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
});

function snapshot(): Phase4bMcpWriteOperationsSnapshot {
  return Object.freeze({
    counts: Object.freeze({
      plans: 0,
      pending: 0,
      approved: 0,
      committing: 0,
      consumed: 0,
      cancelled: 0,
      expired: 0,
      waitingForUser: 0,
      retrying: 0,
      concurrentCommit: 0,
      unknownOutcome: 0,
      permanentlyFailed: 0,
      lowRisk: 0,
      mediumRisk: 0,
      highRisk: 0,
      approvals: 0,
      approvalsConsumed: 0,
      incompleteReceipts: 0,
      completedReceipts: 0,
      dueExpiry: 0,
      retainedPlans: 0,
      retainedApprovals: 0,
      retainedReceipts: 0,
    }),
    ages: Object.freeze({
      oldestWaitingForUserMs: null,
      oldestApprovedMs: null,
      oldestCommittingMs: null,
      oldestRetryingMs: null,
      oldestUnknownOutcomeMs: null,
      oldestPermanentFailureMs: null,
    }),
    retention: Object.freeze({
      dueExpiry: 0,
      retainedPlans: 0,
      retainedApprovals: 0,
      retainedReceipts: 0,
    }),
    dependency: 'available' as const,
    scannedAtMs: 1_720_200_000_000,
  });
}

function store(): Phase4bMcpWriteOperationsStorePort {
  return Object.freeze({
    async inspect() {
      return snapshot();
    },
    async cancel(planId: string) {
      assert.equal(typeof planId, 'string');
      return Object.freeze({ status: 'succeeded', action: 'cancel', planStatus: 'cancelled' });
    },
    async recover(planId: string) {
      assert.equal(typeof planId, 'string');
      return Object.freeze({ status: 'succeeded', action: 'recover', planStatus: 'approved' });
    },
    async expireDuePlans() {
      return 0;
    },
    async purgeRetained() {
      return Object.freeze({ receipts: 0, approvals: 0, plans: 0 });
    },
  });
}

test('mcp-write readiness route is narrow and disabled Write never affects core readiness', async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
  });
  const metrics = new InMemoryMetrics();
  const operations = createPhase4bMcpWriteOperations({ metrics, store: store(), enabled: true });
  const app = buildApiApp({ config, metrics, mcpWriteOperations: operations });
  apps.push(app);

  const ready = await app.inject({ method: 'GET', url: '/ready/features/mcp-write' });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().capability, 'mcp-write');

  operations.disable();
  const disabled = await app.inject({ method: 'GET', url: '/ready/features/mcp-write' });
  assert.equal(disabled.statusCode, 503);
  assert.ok(disabled.json().reasons.includes('mcp_write_disabled'));
  assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/ready/features/mcp' })).statusCode, 404);
});

test('mcp-write readiness route is absent without the operational composition', async () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://known:known@127.0.0.1:5432/known',
    NODE_ENV: 'test',
    OIDC_ALLOW_TEST_PROVIDER: 'true',
    OIDC_TEST_PROVIDER_HMAC_SECRET: 'test-oidc-provider-hmac-secret-not-prod-default',
    LOG_LEVEL: 'silent',
  });
  const app = buildApiApp({ config });
  apps.push(app);
  assert.equal((await app.inject({ method: 'GET', url: '/ready/features/mcp-write' })).statusCode, 404);
});

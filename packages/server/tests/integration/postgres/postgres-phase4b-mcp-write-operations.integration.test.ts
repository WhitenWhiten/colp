import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, test } from 'vitest';
import type { McpAuthenticatedAuthorizationBinding } from '@know-n/colp/mcp';
import type { ChangePlanImpact, ChangePlanOperation, ScopeName } from '@know-n/colp/types';
import { loadConfig } from '../../support/test-config.js';
import { createMcpBindingDigest, createPostgresMcpChangePlanStore, createPostgresMcpWriteOperationsStore, runMigrations, type PostgresMcpStoredPlan } from '../../../src/infrastructure/database/index.js';
import { InMemoryMetrics } from '../../../src/infrastructure/telemetry/index.js';
import {
  createPhase4bMcpChangeSignalSource,
  createPhase4bMcpReadOperations,
  createPhase4bMcpWriteOperations,
  McpWriteMaintenanceJob,
  type Phase4bMcpWriteMaintenanceResult,
  type Phase4bMcpCollectionResourceProjection,
  type Phase4bMcpNodeResourceProjection,
  type Phase4bMcpSnapshotResourceProjection,
  type Phase4bMcpWriteMetrics,
} from '../../../src/modules/mcp/index.js';
import { buildApiApp } from '../../../src/transport/app.js';
import { emptyReadToolAdapterBundle } from '../../support/phase4b-mcp-read-tools-fixture.js';
import {
  createIsolatedPostgresRuntime,
  describeWithPostgres,
  type IsolatedPostgresRuntime,
} from '../../support/postgres-test-runtime.js';

const SERVER_UUID = '019b3c67-a03c-7f02-9c7e-1ee8d50a77de';
const BINDING: McpAuthenticatedAuthorizationBinding = Object.freeze({
  kind: 'authenticated',
  principalId: 'principal-w09',
  clientId: 'client-w09',
  credentialBindingId: 'credential-w09',
  resourceAudience: 'colp://known/collections',
  securityEpoch: 'epoch-w09',
});
const OPERATION: ChangePlanOperation = Object.freeze({
  type: 'set_visibility',
  collectionId: 'collection-w09',
  baseRevision: 'rev-1',
  input: Object.freeze({ visibility: 'private' }),
});
const IMPACT: ChangePlanImpact = Object.freeze({
  collections: 0,
  nodes: 1,
  annotations: 0,
  attachments: 0,
  relations: 0,
  privateFieldsExcluded: [],
});

interface PlanFixture {
  readonly planId: string;
  readonly plan: PostgresMcpStoredPlan;
}

class IntegrationMetrics implements Phase4bMcpWriteMetrics {
  readonly names: string[] = [];
  private readonly values = new Map<string, number>();
  private readonly samples = new Map<string, number[]>();

  increment(name: string, value = 1): void {
    this.names.push(name);
    this.values.set(name, (this.values.get(name) ?? 0) + value);
  }

  gauge(name: string, value: number): void {
    this.names.push(name);
    this.values.set(name, value);
  }

  observe(name: string, value: number): void {
    this.names.push(name);
    const samples = this.samples.get(name) ?? [];
    samples.push(value);
    this.samples.set(name, samples);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  observations(name: string): readonly number[] {
    return [...(this.samples.get(name) ?? [])];
  }
}

describeWithPostgres('MCP-W09 Write Plan operations over the real W02 store', () => {
  let isolated: IsolatedPostgresRuntime;
  let store: ReturnType<typeof createPostgresMcpChangePlanStore>;
  let operationsStore: ReturnType<typeof createPostgresMcpWriteOperationsStore>;

  beforeAll(async () => {
    isolated = await createIsolatedPostgresRuntime('phase4b_mcp_w09', {
      maxConnections: 12,
      applicationName: 'known-mcp-w09-test',
    });
    await runMigrations(isolated.runtime.db, 'latest');
    store = createPostgresMcpChangePlanStore(isolated.runtime.db);
    operationsStore = createPostgresMcpWriteOperationsStore(isolated.runtime.db);
  }, 120_000);

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(async () => {
    await isolated.runtime.pool.query(
      'truncate table mcp_commit_receipts, mcp_approvals, mcp_change_plans cascade',
    );
  });

  test('inspection distinguishes pending, approved, committing, retry, concurrent, unknown, dead-letter, and expiry without secrets', async () => {
    const pending = await savePlan({
      status: 'pending',
      requiresApproval: true,
      approvalMethod: 'out_of_band',
      approvalUri: 'https://approve.example/w09',
      untrustedNote: 'inspection-secret-marker',
      summary: 'w09-inspection-marker',
    });
    const approved = await approvedPlan();
    const retrying = await committingPlan({ idempotencyKey: 'retrying-key' });
    const unknown = await committingPlan({
      idempotencyKey: 'unknown-key',
      claimedAt: new Date(Date.now() - 60_000),
    });
    const permanent = await committingPlan({
      idempotencyKey: 'permanent-key',
      claimedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000),
    });
    const concurrent = await planWithIncompleteReceipts(['race-1', 'race-2']);
    const noReceipt = await planWithStatus('committing');
    const consumed = await consumedPlan();
    const expired = await savePlan({
      status: 'pending',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString(),
      expiresAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
    });
    await store.expireDuePlans();

    const metrics = new IntegrationMetrics();
    const operations = createPhase4bMcpWriteOperations({
      metrics,
      store: operationsStore,
      enabled: true,
      retryAfterMs: 30_000,
      unknownAfterMs: 300_000,
      permanentFailureAfterMs: 24 * 60 * 60 * 1_000,
    });
    const inspected = await operations.inspect();
    assert.equal(inspected.counts.pending, 1);
    assert.equal(inspected.counts.approved, 1);
    assert.equal(inspected.counts.committing, 5);
    assert.equal(inspected.counts.consumed, 1);
    assert.equal(inspected.counts.expired, 1);
    assert.equal(inspected.counts.waitingForUser, 1);
    assert.equal(inspected.counts.retrying, 1);
    assert.equal(inspected.counts.concurrentCommit, 1);
    assert.equal(inspected.counts.unknownOutcome, 2);
    assert.equal(inspected.counts.permanentlyFailed, 1);
    assert.equal(inspected.counts.incompleteReceipts, 5);
    assert.equal(inspected.counts.completedReceipts, 1);
    assert.equal(inspected.counts.approvals, 5);
    assert.equal(inspected.counts.approvalsConsumed, 1);
    assert.equal(inspected.retention.dueExpiry, 0);
    assert.equal(inspected.retention.retainedPlans, 0);

    const serialized = JSON.stringify(inspected);
    assert.equal(serialized.includes('inspection-secret-marker'), false);
    assert.equal(serialized.includes('w09-inspection-marker'), false);
    for (const id of [
      pending.planId,
      approved.planId,
      retrying.planId,
      unknown.planId,
      permanent.planId,
      concurrent.planId,
      noReceipt.planId,
      consumed.planId,
      expired.planId,
    ]) {
      assert.equal(serialized.includes(id), false, `inspection leaked plan id ${id}`);
    }
    assert.equal(metrics.get('mcp.write.plans'), 9);
    assert.equal(metrics.get('mcp.write.plans.committing'), 5);
    assert.equal(metrics.get('mcp.write.backlog.unknown_outcome'), 2);
    assert.equal(metrics.get('mcp.write.backlog.permanent_failure'), 1);
    assert.equal(metrics.get('mcp.write.receipts.incomplete'), 5);
    const firstSeries = new Set(metrics.names);
    for (let index = 0; index < 5; index += 1) {
      await operations.inspect();
    }
    assert.deepEqual(new Set(metrics.names), firstSeries);
    for (const name of firstSeries) {
      assert.doesNotMatch(
        name,
        /(?:principal|client|credential|origin|token|secret|request_state|id)/iu,
        name,
      );
    }
  });

  test('safe recovery and cancel use one durable winner and refuse completed-receipt unknowns', async () => {
    const recoverable = await approvedWithIncompleteReceipt('recover-key');
    const recovered = await operationsStore.recover(recoverable.planId);
    assert.deepEqual(recovered, {
      status: 'succeeded',
      action: 'recover',
      planStatus: 'approved',
    });
    assert.equal((await store.planStore.get(recoverable.planId))?.status, 'approved');
    assert.equal(await receiptCount(recoverable.planId), 0);
    assert.equal(await approvalCount(recoverable.planId), 1);

    const cancelled = await operationsStore.cancel(recoverable.planId);
    assert.deepEqual(cancelled, {
      status: 'succeeded',
      action: 'cancel',
      planStatus: 'cancelled',
    });
    assert.equal((await store.planStore.get(recoverable.planId))?.status, 'cancelled');

    const concurrent = await planWithIncompleteReceipts(['cleanup-1', 'cleanup-2']);
    assert.equal(await receiptCount(concurrent.planId), 2);
    const cleanup = await operationsStore.cancel(concurrent.planId);
    assert.deepEqual(cleanup, {
      status: 'succeeded',
      action: 'cancel',
      planStatus: 'cancelled',
    });
    assert.equal(await receiptCount(concurrent.planId), 0);
    assert.equal((await store.planStore.get(concurrent.planId))?.status, 'cancelled');

    const completed = await planWithCompletedReceipt();
    const unsafeCancel = await operationsStore.cancel(completed.planId);
    assert.equal(unsafeCancel.status, 'unknown_outcome');
    if (unsafeCancel.status === 'unknown_outcome') {
      assert.equal(unsafeCancel.reason, 'completed_receipt_present');
    }
    const unsafeRecover = await operationsStore.recover(completed.planId);
    assert.equal(unsafeRecover.status, 'unknown_outcome');
    assert.equal((await store.planStore.get(completed.planId))?.status, 'committing');
    assert.equal(await receiptCount(completed.planId), 1);
  });

  test('database clock drives expiry and retention inspection with purge cleanup', async () => {
    const future = await savePlan({ status: 'pending' });
    const past = await savePlan({
      status: 'pending',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal((await operationsStore.inspect({
      retryAfterMs: 30_000,
      unknownAfterMs: 300_000,
      permanentFailureAfterMs: 24 * 60 * 60 * 1_000,
    })).retention.dueExpiry, 1);
    assert.equal(await store.expireDuePlans(), 1);
    assert.equal((await store.planStore.get(past.planId))?.status, 'expired');

    const retained = await consumedPlan();
    await isolated.runtime.pool.query(`
      update mcp_change_plans set retained_until = current_timestamp - interval '1 second'
        where plan_id = $1
    `, [retained.planId]);
    await isolated.runtime.pool.query(`
      update mcp_approvals set retained_until = current_timestamp - interval '1 second'
        where plan_id = $1
    `, [retained.planId]);
    await isolated.runtime.pool.query(`
      update mcp_commit_receipts set retained_until = current_timestamp - interval '1 second'
        where plan_id = $1
    `, [retained.planId]);
    const before = await operationsStore.inspect({
      retryAfterMs: 30_000,
      unknownAfterMs: 300_000,
      permanentFailureAfterMs: 24 * 60 * 60 * 1_000,
    });
    assert.equal(before.retention.retainedPlans, 1);
    assert.equal(before.retention.retainedApprovals, 1);
    assert.equal(before.retention.retainedReceipts, 1);
    assert.deepEqual(await store.purgeRetained(), { receipts: 1, approvals: 1, plans: 1 });
    assert.equal(await store.planStore.get(future.planId) !== undefined, true);
    assert.equal(await store.planStore.get(retained.planId), undefined);
  });

  test('maintenance job expires due plans and purges retained rows through production operations', async () => {
    const future = await savePlan({ status: 'pending' });
    const past = new Date(Date.now() - 60_000);
    const duePending = await savePlan({
      status: 'pending',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: past.toISOString(),
    });
    const dueApproved = await savePlan({
      status: 'pending',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: past.toISOString(),
    });
    await setStatus(dueApproved.plan, 'approved');
    const retained = await consumedPlan();
    for (const table of ['mcp_change_plans', 'mcp_approvals', 'mcp_commit_receipts']) {
      await isolated.runtime.pool.query(`
        update ${table} set retained_until = current_timestamp - interval '1 second'
          where plan_id = $1
      `, [retained.planId]);
    }

    const results: Phase4bMcpWriteMaintenanceResult[] = [];
    const operations = createPhase4bMcpWriteOperations({
      metrics: new IntegrationMetrics(),
      store: operationsStore,
      enabled: true,
    });
    const job = new McpWriteMaintenanceJob(operations, {
      intervalMs: 60_000,
      onResult(result) {
        results.push(result);
      },
    });
    await job.tick();

    assert.deepEqual(results, [{
      expiredPlans: 2,
      purge: { receipts: 1, approvals: 1, plans: 1 },
    }]);
    assert.equal((await store.planStore.get(duePending.planId))?.status, 'expired');
    assert.equal((await store.planStore.get(dueApproved.planId))?.status, 'expired');
    assert.equal(await store.planStore.get(retained.planId), undefined);
    assert.equal((await store.planStore.get(future.planId))?.status, 'pending');

    const inspected = await operationsStore.inspect({
      retryAfterMs: 30_000,
      unknownAfterMs: 300_000,
      permanentFailureAfterMs: 24 * 60 * 60 * 1_000,
    });
    assert.equal(inspected.retention.dueExpiry, 0);
    assert.equal(inspected.retention.retainedPlans, 0);
    assert.equal(inspected.retention.retainedApprovals, 0);
    assert.equal(inspected.retention.retainedReceipts, 0);
  });

  test('disabled Write operations degrade only the mcp-write feature probe', async () => {
    const config = loadConfig(mcpEnv(isolated.databaseUrl));
    const metrics = new InMemoryMetrics();
    const operations = createPhase4bMcpWriteOperations({
      metrics,
      store: operationsStore,
      enabled: true,
    });
    operations.disable();
    const source = createPhase4bMcpChangeSignalSource();
    const toolAdapter = emptyReadToolAdapterBundle();
    const readOperations = createPhase4bMcpReadOperations({
      metrics,
      maxConcurrentRequests: config.mcp!.budgets.request.maxConcurrent,
      maxQueuedRequests: config.mcp!.budgets.request.maxQueue,
      maxListeners: config.mcp!.budgets.listen.maxConnections,
      dependencyHealth: async () => Object.freeze({
        oauth: 'ready',
        signalSource: 'ready',
        projection: 'ready',
      }),
    });
    const app = buildApiApp({
      config,
      metrics,
      mcpReadOperations: readOperations,
      mcpReadTransport: {
        changeSignalSource: source,
        readToolAdapter: toolAdapter.adapter,
        readToolParamDeclarations: toolAdapter.paramDeclarations,
      },
      mcpReadResourceProjection: emptyResourceProjection(),
      mcpNodeResourceProjection: emptyNodeResourceProjection(),
      mcpSnapshotResourceProjection: emptySnapshotResourceProjection(),
      mcpWriteOperations: operations,
    });
    try {
      const core = await app.inject({ method: 'GET', url: '/ready' });
      const read = await app.inject({ method: 'GET', url: '/ready/features/mcp' });
      const write = await app.inject({ method: 'GET', url: '/ready/features/mcp-write' });
      assert.equal(core.statusCode, 200);
      assert.equal(read.statusCode, 200);
      assert.ok(read.json().reasons.includes('mcp_read_dependency_unavailable') === false);
      assert.equal(read.json().reasons.includes('mcp_write_disabled'), false);
      assert.equal(write.statusCode, 503);
      assert.ok(write.json().reasons.includes('mcp_write_disabled'));
    } finally {
      await app.close();
      await source.close?.();
    }
  });

  async function savePlan(
    overrides: Readonly<Partial<Record<string, unknown>>> = Object.freeze({}),
  ): Promise<PlanFixture> {
    const planId = `plan-w09-${randomBytes(8).toString('base64url')}`;
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const plan = Object.freeze({
      planId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      risk: 'high',
      requiresApproval: false,
      approvalMethod: undefined,
      approvalUri: undefined,
      summary: 'w09 Plan',
      impact: IMPACT,
      requiredScopes: Object.freeze(['access:write'] as readonly ScopeName[]),
      baseRevisions: Object.freeze({ collection: 'rev-1' }),
      operations: Object.freeze([OPERATION]),
      operationsDigest: `sha-256:${randomUUID()}`,
      binding: BINDING,
      untrustedNote: 'w09 note',
      createdAt,
      status: 'pending',
      ...overrides,
    } as unknown as PostgresMcpStoredPlan);
    await store.planStore.save(plan);
    return { planId, plan };
  }

  async function approvedPlan(): Promise<PlanFixture> {
    const fixture = await savePlan({ status: 'pending' });
    await setStatus(fixture.plan, 'approved');
    await store.approvalStore.markApproved({
      planId: fixture.planId,
      binding: BINDING,
      operationsDigest: fixture.plan.operationsDigest,
    });
    return fixture;
  }

  async function committingPlan(
    options: Readonly<{ idempotencyKey: string; claimedAt?: Date }> = Object.freeze({ idempotencyKey: 'key' }),
  ): Promise<PlanFixture> {
    const fixture = await savePlan({ status: 'pending' });
    await setStatus(fixture.plan, 'approved');
    await store.approvalStore.markApproved({
      planId: fixture.planId,
      binding: BINDING,
      operationsDigest: fixture.plan.operationsDigest,
    });
    await setStatus(fixture.plan, 'committing');
    await insertReceipt(fixture.planId, options.idempotencyKey, options.claimedAt ?? new Date(), false);
    return fixture;
  }

  async function approvedWithIncompleteReceipt(idempotencyKey: string): Promise<PlanFixture> {
    const fixture = await approvedPlan();
    await insertReceipt(fixture.planId, idempotencyKey, new Date(), false);
    return fixture;
  }

  async function planWithIncompleteReceipts(keys: readonly string[]): Promise<PlanFixture> {
    const fixture = await savePlan({ status: 'pending' });
    await setStatus(fixture.plan, 'approved');
    await setStatus(fixture.plan, 'committing');
    for (const key of keys) {
      await insertReceipt(fixture.planId, key, new Date(), false);
    }
    return fixture;
  }

  async function planWithStatus(status: 'committing'): Promise<PlanFixture> {
    const fixture = await savePlan({ status: 'pending' });
    if (status === 'committing') {
      await setStatus(fixture.plan, 'approved');
    }
    await setStatus(fixture.plan, status);
    return fixture;
  }

  async function consumedPlan(): Promise<PlanFixture> {
    const fixture = await approvedPlan();
    await setStatus(fixture.plan, 'committing');
    await insertReceipt(fixture.planId, 'completed-key', new Date(), true);
    await isolated.runtime.pool.query(`
      update mcp_approvals set consumed_at = current_timestamp where plan_id = $1
    `, [fixture.planId]);
    await setStatus(fixture.plan, 'consumed');
    return fixture;
  }

  async function planWithCompletedReceipt(): Promise<PlanFixture> {
    const fixture = await approvedPlan();
    await setStatus(fixture.plan, 'committing');
    await insertReceipt(fixture.planId, 'completed-only-key', new Date(), true);
    return fixture;
  }

  async function setStatus(
    plan: PostgresMcpStoredPlan,
    status: 'pending' | 'approved' | 'committing' | 'consumed' | 'cancelled' | 'expired',
  ): Promise<void> {
    await store.planStore.update(Object.freeze({ ...plan, status }));
  }

  async function insertReceipt(
    planId: string,
    idempotencyKey: string,
    claimedAt: Date,
    completed: boolean,
  ): Promise<void> {
    await isolated.runtime.pool.query(`
      insert into mcp_commit_receipts (
        plan_id, idempotency_key, binding_digest, operations_digest,
        result_json, result_digest, claimed_at, completed_at, retained_until
      ) values (
        $1, $2, $3, $4,
        $5::jsonb, $6, $7, $8, current_timestamp + interval '30 days'
      )
    `, [
      planId,
      idempotencyKey,
      createMcpBindingDigest(BINDING),
      (await store.planStore.get(planId))?.operationsDigest ?? 'sha-256:missing',
      completed ? '{}' : null,
      completed ? 'a'.repeat(64) : null,
      claimedAt,
      completed ? new Date() : null,
    ]);
  }

  async function receiptCount(planId: string): Promise<number> {
    return (await isolated.runtime.pool.query<{ count: number }>(
      'select count(*)::int count from mcp_commit_receipts where plan_id = $1',
      [planId],
    )).rows[0]?.count ?? 0;
  }

  async function approvalCount(planId: string): Promise<number> {
    return (await isolated.runtime.pool.query<{ count: number }>(
      'select count(*)::int count from mcp_approvals where plan_id = $1',
      [planId],
    )).rows[0]?.count ?? 0;
  }
});

function mcpEnv(databaseUrl: string): Record<string, string> {
  return {
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    PUBLICATION_ORIGIN: 'https://collections.example.test',
    PUBLICATION_SERVER_UUID: SERVER_UUID,
    LOG_LEVEL: 'silent',
    KNOWN_FEATURE_MCP_READ: 'true',
    MCP_SERVER_UUID: SERVER_UUID,
    MCP_ALLOWED_ORIGINS: 'https://app.example.test',
    MCP_OAUTH_ISSUER: 'https://issuer.example.test/realms/known',
    MCP_OAUTH_AUDIENCE: 'https://collections.example.test/collections/-/mcp',
    MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_URL:
      'https://issuer.example.test/.well-known/oauth-authorization-server',
    MCP_OAUTH_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    // FIX-M-016 acceptance: loadConfig requires a coherent OIDC issuer/JWKS
    // triple whenever the test provider is disabled; the suite never fetches
    // this endpoint (the MCP verifier is injected), so an HTTPS test URI is
    // sufficient to boot the real API surface.
    OIDC_ISSUER: 'https://issuer.example.test/realms/known',
    OIDC_JWKS_URI: 'https://issuer.example.test/realms/known/protocol/openid-connect/certs',
    MCP_OAUTH_SCOPES: 'mcp:read:public,mcp:read:own',
  };
}

function emptyResourceProjection(): Phase4bMcpCollectionResourceProjection {
  return Object.freeze({
    async listResources() {
      return Object.freeze({ resources: Object.freeze([]) });
    },
    async readResource() {
      throw new Error('not used');
    },
    async cacheForList() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptySnapshotResourceProjection(): Phase4bMcpSnapshotResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('not used');
    },
    async readPage() {
      throw new Error('not used');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

function emptyNodeResourceProjection(): Phase4bMcpNodeResourceProjection {
  return Object.freeze({
    async readResource() {
      throw new Error('not used');
    },
    async cacheForRead() {
      return Object.freeze({ ttlMs: 0, cacheScope: 'private' });
    },
  });
}

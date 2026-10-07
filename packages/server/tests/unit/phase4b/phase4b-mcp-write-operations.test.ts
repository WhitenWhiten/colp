import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createPhase4bMcpWriteOperations,
  type Phase4bMcpWriteActionResult,
  type Phase4bMcpWriteMetrics,
  type Phase4bMcpWriteOperationsSnapshot,
  type Phase4bMcpWriteOperationsStorePort,
} from '../../../src/modules/mcp/index.js';

class RecordingMetrics implements Phase4bMcpWriteMetrics {
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

function snapshot(
  counts: Readonly<Partial<Phase4bMcpWriteOperationsSnapshot['counts']>> = Object.freeze({}),
): Phase4bMcpWriteOperationsSnapshot {
  const base = {
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
  };
  return Object.freeze({
    counts: Object.freeze({ ...base, ...counts }),
    ages: Object.freeze({
      oldestWaitingForUserMs: null,
      oldestApprovedMs: null,
      oldestCommittingMs: null,
      oldestRetryingMs: null,
      oldestUnknownOutcomeMs: null,
      oldestPermanentFailureMs: null,
    }),
    retention: Object.freeze({
      dueExpiry: counts.dueExpiry ?? 0,
      retainedPlans: counts.retainedPlans ?? 0,
      retainedApprovals: counts.retainedApprovals ?? 0,
      retainedReceipts: counts.retainedReceipts ?? 0,
    }),
    dependency: 'available' as const,
    scannedAtMs: 1_720_200_000_000,
  });
}

function createStore(
  current: Phase4bMcpWriteOperationsSnapshot,
  actions: {
    readonly cancel?: (planId: string) => Phase4bMcpWriteActionResult | Promise<Phase4bMcpWriteActionResult>;
    readonly recover?: (planId: string) => Phase4bMcpWriteActionResult | Promise<Phase4bMcpWriteActionResult>;
  } = {},
): {
  readonly store: Phase4bMcpWriteOperationsStorePort;
  readonly setSnapshot: (value: Phase4bMcpWriteOperationsSnapshot) => void;
} {
  let snapshotValue = current;
  return Object.freeze({
    store: Object.freeze({
      async inspect() {
        return snapshotValue;
      },
      async cancel(planId: string) {
        return actions.cancel?.(planId) ?? Object.freeze({
          status: 'succeeded',
          action: 'cancel',
          planStatus: 'cancelled',
        });
      },
      async recover(planId: string) {
        return actions.recover?.(planId) ?? Object.freeze({
          status: 'succeeded',
          action: 'recover',
          planStatus: 'approved',
        });
      },
      async expireDuePlans() {
        return 0;
      },
      async purgeRetained() {
        return Object.freeze({ receipts: 0, approvals: 0, plans: 0 });
      },
    }),
    setSnapshot(value: Phase4bMcpWriteOperationsSnapshot) {
      snapshotValue = value;
    },
  });
}

function createOperations(
  store: Phase4bMcpWriteOperationsStorePort,
  overrides: Readonly<Partial<Omit<
    Parameters<typeof createPhase4bMcpWriteOperations>[0],
    'metrics' | 'store'
  >>> = Object.freeze({}),
): {
  readonly operations: ReturnType<typeof createPhase4bMcpWriteOperations>;
  readonly metrics: RecordingMetrics;
} {
  const metrics = new RecordingMetrics();
  const operations = createPhase4bMcpWriteOperations({
    metrics,
    store,
    enabled: true,
    waitingForUserDegraded: 1,
    expiredDegraded: 1,
    retryBacklogDegraded: 1,
    concurrentCommitDegraded: 1,
    unknownOutcomeNotReady: 1,
    permanentFailureNotReady: 1,
    maxBacklogNotReady: 100,
    ...overrides,
  });
  return { operations, metrics };
}

test('MCP-W09 inspection publishes fixed low-sensitivity metric series', async () => {
  const { store, setSnapshot } = createStore(snapshot());
  setSnapshot(snapshot({
    plans: 7,
    pending: 2,
    approved: 1,
    committing: 2,
    consumed: 1,
    expired: 1,
    waitingForUser: 1,
    retrying: 1,
    concurrentCommit: 1,
    unknownOutcome: 1,
    permanentlyFailed: 1,
    highRisk: 4,
    lowRisk: 2,
    mediumRisk: 1,
    approvals: 3,
    approvalsConsumed: 1,
    incompleteReceipts: 4,
    completedReceipts: 1,
  }));
  const { operations, metrics } = createOperations(store);
  const inspected = await operations.inspect();
  assert.equal(inspected.counts.plans, 7);
  assert.equal(JSON.stringify(inspected).includes('inspection-secret-marker'), false);

  for (let index = 0; index < 10; index += 1) {
    await operations.inspect();
  }
  const unique = new Set(metrics.names);
  assert.ok(unique.size > 20);
  for (const name of unique) {
    assert.match(name, /^mcp\.write\.[a-z0-9_.]+$/u, `unstable metric name ${name}`);
    assert.doesNotMatch(
      name,
      /(?:principal|client|credential|origin|token|secret|content|request_state|id)/iu,
      `identity or content label leaked into ${name}`,
    );
  }
  assert.ok(metrics.names.includes('mcp.write.inspect.total'));
  assert.ok(metrics.names.includes('mcp.write.plans'));
  assert.ok(metrics.names.includes('mcp.write.backlog.unknown_outcome'));
});

test('MCP-W09 readiness exposes stable state reasons and Write rollback is isolated', async () => {
  const { store, setSnapshot } = createStore(snapshot());
  const { operations } = createOperations(store);
  assert.deepEqual((await operations.readiness()).reasons, []);
  assert.equal((await operations.readiness()).status, 'ready');

  setSnapshot(snapshot({
    plans: 6,
    waitingForUser: 1,
    expired: 1,
    retrying: 1,
    concurrentCommit: 1,
    unknownOutcome: 1,
    permanentlyFailed: 1,
  }));
  const degraded = await operations.readiness();
  assert.equal(degraded.status, 'not_ready');
  for (const reason of [
    'mcp_write_waiting_for_user',
    'mcp_write_expired',
    'mcp_write_retry_backlog',
    'mcp_write_concurrent_commit',
    'mcp_write_unknown_outcome',
    'mcp_write_permanent_failure',
  ]) {
    assert.ok(degraded.reasons.includes(reason), `missing readiness reason ${reason}`);
  }

  operations.disable();
  const disabled = await operations.readiness();
  assert.equal(disabled.status, 'not_ready');
  assert.ok(disabled.reasons.includes('mcp_write_disabled'));
  assert.equal(disabled.enabled, false);

  operations.enable();
  assert.equal((await operations.readiness()).enabled, true);

  setSnapshot(snapshot({ plans: 200 }));
  const capacity = await operations.readiness();
  assert.equal(capacity.status, 'not_ready');
  assert.ok(capacity.reasons.includes('mcp_write_capacity_exhausted'));
});

test('MCP-W09 readiness fails closed when the durable store is unavailable', async () => {
  const failingStore: Phase4bMcpWriteOperationsStorePort = Object.freeze({
    async inspect() {
      throw new Error('postgres unavailable');
    },
    async cancel() {
      throw new Error('postgres unavailable');
    },
    async recover() {
      throw new Error('postgres unavailable');
    },
    async expireDuePlans() {
      throw new Error('postgres unavailable');
    },
    async purgeRetained() {
      throw new Error('postgres unavailable');
    },
  });
  const { operations, metrics } = createOperations(failingStore);
  const readiness = await operations.readiness();
  assert.equal(readiness.status, 'not_ready');
  assert.ok(readiness.reasons.includes('mcp_write_dependency_unavailable'));
  assert.equal(metrics.get('mcp.write.inspect.error'), 1);
  assert.equal(JSON.stringify(readiness).includes('postgres unavailable'), false);
});

test('MCP-W09 cancel/recover actions record outcomes and never label raw errors', async () => {
  const { store } = createStore(snapshot(), {
    cancel: () => Object.freeze({ status: 'succeeded', action: 'cancel', planStatus: 'cancelled' }),
    recover: (planId) => {
      if (planId === 'plan-c') {
        throw new Error('postgres unavailable');
      }
      return Object.freeze({
        status: 'unknown_outcome',
        action: 'recover',
        reason: 'completed_receipt_present',
      });
    },
  });
  const { operations, metrics } = createOperations(store);
  const cancelled = await operations.cancel('plan-a');
  assert.equal(cancelled.status, 'succeeded');
  assert.equal(metrics.get('mcp.write.action.cancel.succeeded'), 1);

  const recovered = await operations.recover('plan-b');
  assert.equal(recovered.status, 'unknown_outcome');
  assert.equal(metrics.get('mcp.write.action.recover.unknown_outcome'), 1);
  assert.equal(metrics.get('mcp.write.action.unknown_outcome'), 1);

  await assert.rejects(
    () => operations.recover('plan-c'),
    /postgres unavailable/u,
  );
  assert.equal(metrics.get('mcp.write.action.error.internal'), 1);
  assert.equal(
    metrics.names.some((name) => /raw|stack|postgres|unavailable/iu.test(name)),
    false,
  );
});

test('MCP-W09 commit result and error metrics stay low cardinality', () => {
  const { store } = createStore(snapshot());
  const { operations, metrics } = createOperations(store);
  for (const result of ['committed', 'replayed', 'cancelled', 'expired', 'rejected'] as const) {
    operations.recordCommitResult(result);
  }
  for (const category of [
    'binding',
    'digest',
    'revision',
    'scope',
    'rate',
    'impact',
    'expiry',
    'concurrent',
    'unknown',
  ] as const) {
    operations.recordCommitError(category);
  }
  assert.equal(metrics.get('mcp.write.commit.result.committed'), 1);
  assert.equal(metrics.get('mcp.write.commit.error.concurrent'), 1);
  assert.equal(
    metrics.names.some((name) => /plan|principal|content|request_state|token|secret/iu.test(name)),
    false,
  );
});

test('MCP-W09 expiry and retention controls publish bounded cleanup metrics', async () => {
  const { store } = createStore(snapshot());
  const { operations, metrics } = createOperations(store);
  assert.equal(await operations.expireDuePlans(), 0);
  assert.deepEqual(await operations.purgeRetained(), { receipts: 0, approvals: 0, plans: 0 });
  assert.equal(metrics.get('mcp.write.expiry.applied'), 0);
  assert.equal(metrics.get('mcp.write.retention.purged_receipts'), 0);
  assert.equal(metrics.get('mcp.write.retention.purged_approvals'), 0);
  assert.equal(metrics.get('mcp.write.retention.purged_plans'), 0);
});

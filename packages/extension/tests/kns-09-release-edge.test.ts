import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  KNS09_METRICS, KNS09_MUTATION_STORAGE_KEY, KNS09_STOP_METRICS,
  diagnoseKns09Fault, kns09MutationSwitchesSnapshot, kns09Paused, loadKns09MutationSwitches,
  observeKns09, observeKns09EngineWake, observeKns09PushReceipt, recordKns09Counter,
  recordKns09FirstRun, recordKns09MergeAttention, recordKns09PausedDrop, recordKns09ReconcileFailure,
  resetKns09MetricsForTests, setKns09MutationSwitchesForTests, snapshotKns09Metrics,
  type Kns09FaultFixture, type Kns09FirstRunOutcome,
} from '../src/kns-09-release.js';
import { KNS09_METRICS_STORAGE_KEY, persistKns09Metrics } from '../src/kns-09-metrics.js';
import type { QueueOperation } from '../src/sync-state/types.js';

const scope = { collectionId: 'release-private-collection', replicaId: 'release-private-replica' };
beforeEach(() => { resetKns09MetricsForTests(); setKns09MutationSwitchesForTests(); });
afterEach(async () => {
  await persistKns09Metrics();
  resetKns09MetricsForTests(); setKns09MutationSwitchesForTests();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

test('durable mutation switches interpret only explicit false as a pause and keep lanes independent', async () => {
  let value: unknown = { coordinator: false, ui: true };
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (key: string) => ({ [key]: key === KNS09_MUTATION_STORAGE_KEY ? value : undefined }),
    set: async () => undefined,
  } } });
  assert.deepEqual(await loadKns09MutationSwitches(), { coordinator: false, ui: true });
  assert.equal(await kns09Paused('pull'), true);
  assert.equal(await kns09Paused('ingress'), true);
  assert.equal(await kns09Paused('ui'), false);
  value = { coordinator: 'false', ui: false };
  assert.deepEqual(await loadKns09MutationSwitches(), { coordinator: true, ui: false });
  assert.equal(await kns09Paused('pull'), false);
  assert.equal(await kns09Paused('ui'), true);
  value = 'invalid old storage';
  assert.deepEqual(await loadKns09MutationSwitches(), { coordinator: true, ui: true });
  setKns09MutationSwitchesForTests({ coordinator: false, ui: false });
  assert.deepEqual(kns09MutationSwitchesSnapshot(), { coordinator: false, ui: false });
  assert.deepEqual(await loadKns09MutationSwitches(), { coordinator: false, ui: false });
  setKns09MutationSwitchesForTests();
  assert.deepEqual(kns09MutationSwitchesSnapshot(), { coordinator: true, ui: true });
});

test('unknown metric names and invalid first-run outcomes produce no counters or private locator data', async () => {
  assert.throws(() => recordKns09Counter('unregistered.private-title', scope), /kns09_metric_unknown/);
  assert.throws(() => observeKns09('unregistered.private-url', 5, scope), /kns09_metric_unknown/);
  recordKns09FirstRun('unregistered' as Kns09FirstRunOutcome, scope, 'run');
  recordKns09MergeAttention(scope, 0, 0);
  assert.deepEqual(snapshotKns09Metrics().counters, {});
  assert.deepEqual(snapshotKns09Metrics().locators, []);
  recordKns09FirstRun('completed', scope, 'same-run');
  recordKns09FirstRun('completed', scope, 'same-run');
  recordKns09FirstRun('started', scope, 'same-run');
  await persistKns09Metrics();
  assert.equal(snapshotKns09Metrics().counters[`${KNS09_METRICS.firstRun}.completed`], 1);
  assert.equal(snapshotKns09Metrics().counters[`${KNS09_METRICS.firstRun}.started`], undefined);
});

test('paused drops and reconcile failures persist diagnostics without requiring a locator', async () => {
  const saved: Record<string, unknown> = {};
  vi.stubGlobal('chrome', { storage: { local: {
    get: async (key: string) => ({ [key]: structuredClone(saved[key]) }),
    set: async (items: Record<string, unknown>) => { Object.assign(saved, structuredClone(items)); },
  } } });
  recordKns09PausedDrop();
  recordKns09ReconcileFailure(scope);
  recordKns09Counter(KNS09_METRICS.permissionRevoked);
  await persistKns09Metrics();
  const persisted = saved[KNS09_METRICS_STORAGE_KEY] as {
    ring: Array<{ kind: string }>; counters: Record<string, number>;
  };
  assert.deepEqual(persisted.ring.map(row => row.kind), ['kns09.mutation_paused_drop']);
  assert.equal(persisted.counters[KNS09_METRICS.scopeReconcileFailure], 1);
  assert.equal(persisted.counters[KNS09_METRICS.permissionRevoked], 1);
  assert.doesNotMatch(JSON.stringify(persisted), /release-private-collection|release-private-replica/);
});

test('engine diagnostics distinguish recovery loops, identity failures and ordinary empty wakes', () => {
  observeKns09EngineWake({ scope, frozenBefore: false, frozenAfter: false, pendingCount: 0, backlogAgeMs: null });
  assert.deepEqual(snapshotKns09Metrics().counters, {});
  assert.deepEqual(snapshotKns09Metrics().histograms, {});
  for (const lastError of ['mapping_identity_conflict', 'recovery_identity_unproven']) {
    observeKns09EngineWake({ scope, frozenBefore: true, frozenAfter: true,
      pendingCount: 1, backlogAgeMs: 200, lastError });
  }
  const snapshot = snapshotKns09Metrics();
  assert.equal(snapshot.counters[KNS09_METRICS.pullRecovery], 2);
  assert.equal(snapshot.counters[KNS09_STOP_METRICS.mappingIdentityCollision], 2);
  assert.equal(snapshot.counters[KNS09_STOP_METRICS.recoveryLoop], 2);
  assert.equal(snapshot.histograms[KNS09_METRICS.queueBacklogAgeMs]?.counts.reduce((sum, count) => sum + count, 0), 2);
});

test('receipt latency is based on the captured attempt, clamps future clock drift and records missing evidence as unknown', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const retry = { attempt: 0, notBefore: 0 };
  const attempt = (startedAt: number): QueueOperation['attempt'] => ({ sessionId: 'session', batchId: 'batch',
    idempotencyKey: 'key', endpointIdentity: 'syncPush', mediaType: 'application/json',
    body: '{}', bodyDigest: 'sha256:body', startedAt });
  observeKns09PushReceipt(scope, { retry, attempt: attempt(880) });
  observeKns09PushReceipt(scope, { retry, attempt: attempt(1_100) });
  observeKns09PushReceipt(scope, { retry });
  const histogram = snapshotKns09Metrics().histograms[KNS09_METRICS.pushReceiptLatencyMs];
  assert.ok(histogram);
  assert.equal(histogram.counts[0], 1, 'future timestamps clamp to zero rather than a negative duration');
  assert.equal(histogram.counts[2], 1, '120ms is measured from dispatch, not the retry schedule');
  assert.equal(histogram.unknown, 1);
});

function fault(overrides: Partial<Kns09FaultFixture> = {}): Kns09FaultFixture {
  return { schemaVersion: 1, id: 'edge', databaseVersion: 21,
    coordinatorMutations: false, uiMutations: false, firstRun: 'completed', mappingCount: 0, queue: [],
    engine: { phase: 'idle', recoveryFrozen: false, lastError: null },
    stopCounts: { duplicateNode: 0, outOfScopeUpload: 0, unconfirmedDelete: 0,
      cursorDivergence: 0, recoveryLoop: 0, mappingIdentityCollision: 0 }, ...overrides };
}

test('rollback diagnosis keeps terminal queues idle and identifies pending writes before draining', () => {
  const terminal = [{ status: 'terminal', payloadType: 'create_node', retryAttempt: 0, opIdHash: 'done' },
    { status: 'rejected', payloadType: 'create_node', retryAttempt: 1, opIdHash: 'rejected' }];
  assert.equal(diagnoseKns09Fault(fault({ queue: terminal })).conclusion, 'paused_idle');
  const pending = [{ status: 'pending', payloadType: 'delete_subtree', retryAttempt: 0, opIdHash: 'delete' }];
  const open = diagnoseKns09Fault(fault({ queue: pending, coordinatorMutations: true, uiMutations: true }));
  assert.equal(open.conclusion, 'close_mutation_switches_then_drain');
  assert.equal(open.drainSafe, false);
  assert.equal(open.silentDelete, true);
  assert.equal(open.duplicatePushRisk, false);
  assert.equal(diagnoseKns09Fault(fault({ queue: pending })).conclusion, 'pause_mutations_and_drain');
});

test('rollback stop evidence outranks draining while an incompatible schema refuses the older binary', () => {
  const claimed = { status: 'claimed', payloadType: 'delete_node', retryAttempt: 2, opIdHash: 'same-hash' };
  const input = fault({ queue: [claimed, claimed],
    stopCounts: { ...fault().stopCounts, duplicateNode: 1 } });
  const stopped = diagnoseKns09Fault(input);
  assert.equal(stopped.duplicatePushRisk, true);
  assert.equal(stopped.stopExpansion, true);
  assert.equal(stopped.silentDelete, false);
  assert.equal(stopped.conclusion, 'halt_rollout');
  const incompatible = diagnoseKns09Fault({ ...input, databaseVersion: 9 });
  assert.equal(incompatible.conclusion, 'refuse_v9_binary');
  assert.equal(incompatible.rollbackBinary, 'do-not-install-older');
});

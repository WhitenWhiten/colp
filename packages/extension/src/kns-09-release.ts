import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { QueueOperation, SyncScope } from './sync-state/types.js';
import {
  incrementCounter, observeDuration, persistKns09Metrics, pushDiagnosis, putLocator, rememberFirstRunOutcome,
  resetKns09DurableMetricsForTests, restoreKns09Metrics, snapshotKns09DurableMetrics, clearCounter,
} from './kns-09-metrics.js';

export const KNS09_SCHEMA_VERSION = 21;
export const KNS09_MUTATION_STORAGE_KEY = 'known.kns09.mutations.v1';
export const KNS09_DEFAULT_MUTATIONS = Object.freeze({ coordinator: true, ui: true });

export const KNS09_METRICS = Object.freeze({
  firstRun: 'kns09.first_run_total',
  queueBacklogAgeMs: 'kns09.queue_backlog_age_ms',
  pushReceiptLatencyMs: 'kns09.push_receipt_latency_ms',
  pullRecovery: 'kns09.pull_recovery_total',
  duplicateCandidate: 'kns09.duplicate_candidate_total',
  conflict: 'kns09.conflict_total',
  permissionRevoked: 'kns09.permission_revoked_total',
  scopeReconcileFailure: 'kns09.scope_reconcile_failure_total',
  trashRestoreApplied: 'sync_trash_restore_total.applied',
  trashRestorePurged: 'sync_trash_restore_total.purged',
});

export const KNS09_FIRST_RUN_OUTCOMES = Object.freeze([
  'started', 'completed', 'attention', 'paused', 'failed',
] as const);

export const KNS09_STOP_METRICS = Object.freeze({
  duplicateNode: 'kns09.stop.duplicate_node',
  outOfScopeUpload: 'kns09.stop.out_of_scope_upload',
  unconfirmedDelete: 'kns09.stop.unconfirmed_delete',
  cursorDivergence: 'kns09.stop.cursor_divergence',
  recoveryLoop: 'kns09.stop.recovery_loop',
  mappingIdentityCollision: 'kns09.stop.mapping_identity_collision',
});

export type Kns09FirstRunOutcome = (typeof KNS09_FIRST_RUN_OUTCOMES)[number];
export type Kns09MutationLane = 'coordinator' | 'ui' | 'ingress' | 'pull';
export type Kns09MutationSwitches = { readonly coordinator: boolean; readonly ui: boolean };
export type Kns09StopReason = keyof typeof KNS09_STOP_METRICS;
export type Kns09Locator = { readonly collectionHash: string; readonly replicaHash: string };

export type Kns09FaultQueueRow = {
  readonly status: string; readonly payloadType: string; readonly retryAttempt: number;
  readonly opIdHash: string;
};
export type Kns09FaultFixture = {
  readonly schemaVersion: 1; readonly id: string; readonly databaseVersion: number;
  readonly coordinatorMutations: boolean; readonly uiMutations: boolean;
  readonly firstRun: string; readonly mappingCount: number;
  readonly queue: readonly Kns09FaultQueueRow[];
  readonly engine: { readonly phase: string; readonly recoveryFrozen: boolean; readonly lastError: string | null };
  readonly stopCounts: Readonly<Record<Kns09StopReason, number>>;
};
export type Kns09Diagnosis = {
  readonly readableSchema: boolean; readonly rollbackBinary: 'keep-v20' | 'do-not-install-older';
  readonly drainSafe: boolean; readonly silentDelete: boolean; readonly duplicatePushRisk: boolean;
  readonly stopExpansion: boolean; readonly conclusion: string;
};

const HASH_PREFIX = 'kns09:v1:';
let mutationOverride: Kns09MutationSwitches | undefined;

export function kns09Locator(scope: Pick<SyncScope, 'collectionId' | 'replicaId'>): Kns09Locator {
  return {
    collectionHash: locatorHash(scope.collectionId),
    replicaHash: locatorHash(scope.replicaId),
  };
}

export function locatorHash(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(`${HASH_PREFIX}${value}`))).slice(0, 16);
}

export function setKns09MutationSwitchesForTests(next?: Kns09MutationSwitches): void {
  mutationOverride = next;
}

export function kns09MutationSwitchesSnapshot(): Kns09MutationSwitches {
  return mutationOverride ?? KNS09_DEFAULT_MUTATIONS;
}

export async function loadKns09MutationSwitches(): Promise<Kns09MutationSwitches> {
  await hydrateKns09Metrics();
  if (mutationOverride) return mutationOverride;
  try {
    const stored = await chrome.storage.local.get(KNS09_MUTATION_STORAGE_KEY);
    const value = stored[KNS09_MUTATION_STORAGE_KEY];
    if (value && typeof value === 'object') {
      const row = value as { coordinator?: unknown; ui?: unknown };
      return { coordinator: row.coordinator !== false, ui: row.ui !== false };
    }
  } catch { /* Unit tests and missing chrome stay on the default-on path. */ }
  return KNS09_DEFAULT_MUTATIONS;
}

export async function kns09Paused(lane: Kns09MutationLane): Promise<boolean> {
  const switches = await loadKns09MutationSwitches();
  if (lane === 'pull') return switches.coordinator !== true;
  if (lane === 'ingress') {
    return switches.coordinator !== true
      || (snapshotKns09DurableMetrics().counters[KNS09_STOP_METRICS.outOfScopeUpload] ?? 0) > 0;
  }
  return switches[lane] !== true;
}

/** Reopen mutation lanes after an operator pause while retaining diagnostics. */
export async function resumeKns09Mutations(): Promise<void> {
  // Hydrate before clearing: persistKns09Metrics restores first when this
  // worker has not loaded durable metrics yet, and the merge would resurrect
  // the persisted stop counter right after clearCounter removed it.
  await hydrateKns09Metrics();
  mutationOverride = { coordinator: true, ui: true };
  clearCounter(KNS09_STOP_METRICS.outOfScopeUpload);
  pushDiagnosis('kns09.mutations.resumed');
  try { await chrome.storage.local.set({ [KNS09_MUTATION_STORAGE_KEY]: mutationOverride }); } catch { /* tests/no chrome */ }
  await persistKns09Metrics();
}

export function recordKns09PausedDrop(): void {
  pushDiagnosis('kns09.mutation_paused_drop');
  void persistKns09Metrics();
}

export function resetKns09MetricsForTests(): void {
  resetKns09DurableMetricsForTests();
}

export function snapshotKns09Metrics(): {
  readonly counters: Readonly<Record<string, number>>;
  readonly observations: Readonly<Record<string, readonly number[]>>;
  readonly histograms: ReturnType<typeof snapshotKns09DurableMetrics>['histograms'];
  readonly locators: readonly Kns09Locator[];
  readonly ringLength: number;
} {
  const durable = snapshotKns09DurableMetrics();
  return {
    counters: durable.counters,
    observations: Object.fromEntries(Object.entries(durable.histograms).map(([name, row]) => [
      name, row.counts,
    ])),
    histograms: durable.histograms,
    locators: durable.locators,
    ringLength: durable.ringLength,
  };
}

export function recordKns09Counter(name: string, scope?: Pick<SyncScope, 'collectionId' | 'replicaId'>,
  value = 1): void {
  assertMetricName(name);
  incrementCounter(name, value);
  rememberLocator(scope);
  void persistKns09Metrics();
}

export function observeKns09(name: string, value: number | null,
  scope?: Pick<SyncScope, 'collectionId' | 'replicaId'>): void {
  assertMetricName(name);
  observeDuration(name, value);
  rememberLocator(scope);
  void persistKns09Metrics();
}

export function recordKns09FirstRun(outcome: Kns09FirstRunOutcome, scope: Pick<SyncScope, 'collectionId' | 'replicaId'>,
  runKey?: string): void {
  if (!KNS09_FIRST_RUN_OUTCOMES.includes(outcome)) return;
  if (runKey && !rememberFirstRunOutcome(runKey, outcome)) return;
  recordKns09Counter(`${KNS09_METRICS.firstRun}.${outcome}`, scope);
}

export function recordKns09MergeAttention(scope: Pick<SyncScope, 'collectionId' | 'replicaId'>,
  candidates: number, conflicts: number): void {
  if (candidates > 0) recordKns09Counter(KNS09_METRICS.duplicateCandidate, scope, candidates);
  if (conflicts > 0) recordKns09Counter(KNS09_METRICS.conflict, scope, conflicts);
}

export function recordKns09PermissionRevoked(scope: Pick<SyncScope, 'collectionId' | 'replicaId'>): void {
  recordKns09Counter(KNS09_METRICS.permissionRevoked, scope);
}

export function recordKns09ReconcileFailure(scope: Pick<SyncScope, 'collectionId' | 'replicaId'>): void {
  recordKns09Counter(KNS09_METRICS.scopeReconcileFailure, scope);
}

export function recordKns09Stop(reason: Kns09StopReason, scope?: Pick<SyncScope, 'collectionId' | 'replicaId'>): void {
  recordKns09Counter(KNS09_STOP_METRICS[reason], scope);
  pushDiagnosis(KNS09_STOP_METRICS[reason]);
  void persistKns09Metrics();
}

export function observeKns09EngineWake(input: {
  readonly scope: Pick<SyncScope, 'collectionId' | 'replicaId'>;
  readonly frozenBefore: boolean; readonly frozenAfter: boolean; readonly pendingCount: number;
  readonly backlogAgeMs: number | null; readonly lastError?: string;
}): void {
  if (input.pendingCount > 0) observeKns09(KNS09_METRICS.queueBacklogAgeMs, input.backlogAgeMs, input.scope);
  if (input.frozenBefore) recordKns09Counter(KNS09_METRICS.pullRecovery, input.scope);
  if (input.lastError === 'mapping_identity_conflict' || input.lastError === 'recovery_identity_unproven') {
    recordKns09Stop('mappingIdentityCollision', input.scope);
  }
  if (input.frozenBefore && input.frozenAfter && input.lastError) recordKns09Stop('recoveryLoop', input.scope);
  void input.frozenAfter;
}

export function observeKns09PushReceipt(scope: Pick<SyncScope, 'collectionId' | 'replicaId'>,
  queue: Pick<QueueOperation, 'retry' | 'attempt'>): void {
  const started = queue.attempt?.startedAt ?? null;
  observeKns09(KNS09_METRICS.pushReceiptLatencyMs, started === null ? null : Math.max(0, Date.now() - started), scope);
}

export async function hydrateKns09Metrics(): Promise<void> {
  await restoreKns09Metrics();
}

export function diagnoseKns09Fault(fixture: Kns09FaultFixture): Kns09Diagnosis {
  const readableSchema = fixture.databaseVersion === KNS09_SCHEMA_VERSION;
  const rollbackBinary = readableSchema ? 'keep-v20' : 'do-not-install-older';
  const drainSafe = fixture.coordinatorMutations === false && fixture.uiMutations === false;
  const deletes = fixture.queue.filter((row) => row.payloadType === 'delete_node' || row.payloadType === 'delete_subtree');
  const silentDelete = deletes.length > 0 && fixture.uiMutations === true;
  const claimed = fixture.queue.filter((row) => row.status === 'claimed');
  const hashes = claimed.map((row) => row.opIdHash);
  const duplicatePushRisk = hashes.some((hash, index) => hashes.indexOf(hash) !== index);
  const stopExpansion = Object.values(fixture.stopCounts).some((count) => count > 0);
  const live = fixture.queue.some((row) => row.status !== 'terminal' && row.status !== 'rejected');
  const conclusion = !readableSchema ? 'refuse_v9_binary'
    : stopExpansion ? 'halt_rollout'
      : live && drainSafe ? 'pause_mutations_and_drain'
        : live ? 'close_mutation_switches_then_drain'
          : 'paused_idle';
  return { readableSchema, rollbackBinary, drainSafe, silentDelete, duplicatePushRisk, stopExpansion, conclusion };
}

function rememberLocator(scope?: Pick<SyncScope, 'collectionId' | 'replicaId'>): void {
  if (!scope) return;
  putLocator(kns09Locator(scope));
}

function assertMetricName(name: string): void {
  const allowed = new Set<string>([
    ...Object.values(KNS09_METRICS),
    ...Object.values(KNS09_STOP_METRICS),
    ...KNS09_FIRST_RUN_OUTCOMES.map((outcome) => `${KNS09_METRICS.firstRun}.${outcome}`),
  ]);
  if (!allowed.has(name)) throw new TypeError('kns09_metric_unknown');
}

import { holdsUnprovenIdentity, needsReplicaRebuild } from './sync-failure-class.js';
import { bootstrapAttentionPhase, publicAttentionSummary } from './bootstrap/attention-report.js';
import type { SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getEngineState' | 'getScope' | 'listBootstrapRuns'
  | 'getRecoveryHeader' | 'listAckIntents' | 'listProjectionIntents' | 'listQueue'>;

/** Copy only operational facts. Never include scope ids, cursors or bookmark content. */
export async function collectSyncDiagnostics(store: Store, scope: SyncScope) {
  const [engine, recorded, runs, recovery, acks, projections] = await Promise.all([
    store.getEngineState(scope), store.getScope(scope), store.listBootstrapRuns(scope),
    store.getRecoveryHeader(scope), store.listAckIntents(scope), store.listProjectionIntents(scope),
  ]);
  const run = [...runs].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  let pendingUploads = 0;
  for (const status of ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside'] as const) {
    let after = 0;
    for (;;) {
      const rows = await store.listQueue(scope, status, after, 1_000);
      pendingUploads += rows.length;
      if (rows.length < 1_000) break;
      after = rows.at(-1)!.sequence;
    }
  }
  const code = engine?.lastError;
  const terminal = engine?.recoveryFrozen === true && (code === 'payload_too_large'
    || holdsUnprovenIdentity(code) || needsReplicaRebuild(code));
  return {
    engine: { phase: engine?.phase ?? 'idle', errorCode: engine?.lastError ?? null,
      recoveryFrozen: engine?.recoveryFrozen === true, authorityRefreshRequired: engine?.authorityRefreshRequired === true,
      retryAutomatic: engine?.phase !== 'error' && !terminal, retryAt: engine?.notBefore || null },
    // A breaker that tripped is why sync paused after repeated errors; its deadline is `retryAt` above.
    breaker: { trips: engine?.circuitBreaker?.trips ?? 0, deadline: engine?.circuitBreaker?.retryAt ?? null },
    firstRun: { state: recorded?.firstRun ?? 'none', phase: run ? bootstrapAttentionPhase(run) : 'draft', retryReason: run?.retryReason ?? null,
      pendingReviews: run?.attention ? publicAttentionSummary(run.attention).pendingCount : 0 },
    recovery: { staged: recovery !== null, complete: recovery?.complete ?? false,
      pendingProjections: projections.filter(row => row.state !== 'terminal').length,
      pendingAcknowledgements: acks.filter(row => row.state === 'pending').length },
    pendingUploads,
  };
}

import { holdsUnprovenIdentity, needsReplicaRebuild } from './durable-sync-engine-errors.js';
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
  for (const status of ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown'] as const) {
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
    firstRun: { state: recorded?.firstRun ?? 'none', phase: run?.phase ?? 'draft', retryReason: run?.retryReason ?? null,
      pendingReviews: run?.attention?.items.filter(item => item.decision === 'open').length ?? 0 },
    recovery: { staged: recovery !== null, complete: recovery?.complete ?? false,
      pendingProjections: projections.filter(row => row.state !== 'terminal').length,
      pendingAcknowledgements: acks.filter(row => row.state === 'pending').length },
    pendingUploads,
  };
}

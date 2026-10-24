import { syncStopState } from './sync-stop-state.js';
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
  // The same reading of "has sync stopped" as the Status card, the chip and the report (sync-stop-state.ts).
  const stop = syncStopState({ ...(engine?.lastError ? { lastError: engine.lastError } : {}),
    ...(typeof recorded?.metadata?.recoveryCode === 'string' ? { recoveryCode: recorded.metadata.recoveryCode } : {}),
    ...(engine?.phase ? { phase: engine.phase } : {}), ...(engine?.circuitBreaker ? { breaker: engine.circuitBreaker } : {}) });
  return {
    engine: { phase: engine?.phase ?? 'idle', errorCode: engine?.lastError ?? null,
      recoveryFrozen: engine?.recoveryFrozen === true, authorityRefreshRequired: engine?.authorityRefreshRequired === true,
      retryAutomatic: engine?.phase !== 'error' && stop?.kind !== 'terminal', retryAt: engine?.notBefore || null,
      // terminal | stopped | stalled | cooling: which way out the stop has (null: not stopped).
      stop: stop?.kind ?? null },
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

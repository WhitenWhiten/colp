/**
 * S7 / B2 (SR-09 · SR-11 · SR-13): the read-only service-worker side of the
 * popup/settings attention exits.
 *
 * Everything here is a read. The two facts the UI cannot get from an existing
 * channel are the scope's `metadata.recoveryCode` (the code the terminal freeze
 * actually recorded, see `freezeScopeRecovery`) and a queue projection computed
 * from live rows; both come from the same pure helpers the public engine state
 * uses (`queueStatusProjection`/`hasConflictBarrier`/`hasRejectedBarrier`), so
 * the aggregate can never disagree with `known.sync.engine.status` about what
 * the queue is doing. No engine wake, no write, no user gesture.
 */
import { hasConflictBarrier, hasRejectedBarrier, queueStatusProjection } from '../engine-public-stability.js';
import { projectNativeWaits, type NativeWaitStore } from '../native-wait.js';
import { syncAttentionTerminalCode } from '../sync-attention-ui.js';
import type { SyncAttentionResponse } from '../types.js';
import type { createSyncStateStore, SyncScope } from '../sync-state-store.js';

export type SyncAttentionStore = NativeWaitStore & Pick<ReturnType<typeof createSyncStateStore>,
  'getEngineState' | 'listQueue'>;

export interface SyncAttentionDeps {
  readonly scope: () => Promise<SyncScope>;
  readonly store: SyncAttentionStore;
  readonly rebuildPending?: () => Promise<boolean>;
}

/** Same status set `pendingDurableWorkFacts` live-scans (engine.ts), bounded to one page each. */
const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'rejected', 'set_aside'] as const;
const QUEUE_PAGE = 1_000;

export async function handleSyncAttentionRequest(deps: SyncAttentionDeps): Promise<SyncAttentionResponse> {
  if (await deps.rebuildPending?.()) return { ok: true, attention: {
    recoveryFrozen: true, queueProjection: 'idle', conflictPending: false, rejectedPending: false,
    nativeWaitPending: false, waitCount: 0, terminal: true, terminalCode: 'replica_rebuild_pending', phase: 'recovery',
    lastError: 'replica_rebuild_pending',
  } };
  let scope: SyncScope;
  try { scope = await deps.scope(); } catch { return { ok: false, error: 'not_connected' }; }
  try {
    const [recorded, engine, waits] = await Promise.all([
      deps.store.getScope(scope),
      deps.store.getEngineState(scope),
      projectNativeWaits(deps.store, scope).catch(() => []),
    ]);
    const recoveryCode = typeof recorded?.metadata?.recoveryCode === 'string'
      ? recorded.metadata.recoveryCode : undefined;
    const lastError = engine?.lastError;
    const terminalCode = syncAttentionTerminalCode(lastError, recoveryCode);
    const queue = await queueFacts(deps.store, scope);
    return { ok: true, attention: {
      ...(engine?.phase ? { phase: engine.phase } : {}),
      recoveryFrozen: engine?.recoveryFrozen === true,
      retryAutomatic: engine?.phase !== 'error' && terminalCode === undefined,
      ...(engine?.notBefore ? { retryAt: engine.notBefore } : {}),
      ...queue,
      nativeWaitPending: waits.length > 0,
      waitCount: waits.length,
      ...(lastError ? { lastError } : {}),
      ...(recoveryCode ? { recoveryCode } : {}),
      terminal: terminalCode !== undefined,
      ...(terminalCode ? { terminalCode } : {}),
    } };
  } catch { return { ok: false, error: 'state_unavailable' }; }
}

/** Best-effort like `sw/remote-delete.ts#status`: a failed queue read still leaves the freeze visible. */
async function queueFacts(store: SyncAttentionStore, scope: SyncScope) {
  const live: Array<{ readonly status?: string; readonly recovery?: { readonly code?: string } }> = [];
  try {
    for (const status of LIVE_STATUSES) live.push(...await store.listQueue(scope, status, 0, QUEUE_PAGE));
  } catch {
    return { queueProjection: 'idle' as const, conflictPending: false, rejectedPending: false };
  }
  return { queueProjection: queueStatusProjection(live), conflictPending: hasConflictBarrier(live),
    rejectedPending: hasRejectedBarrier(live) };
}

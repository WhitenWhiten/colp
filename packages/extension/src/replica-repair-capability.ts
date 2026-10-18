import { readOpenSyncIssues, type OpenSyncIssues, type SyncIssueStore } from './sync-issues.js';
import type { createSyncStateStore, SyncScope, QueueOperation } from './sync-state-store.js';

type Store = SyncIssueStore & Pick<ReturnType<typeof createSyncStateStore>, 'listQueue' | 'getEngineState'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'getQueueReceipt'>>;
/** Rebuild archives unsent work. It cannot abandon an upload whose execution remains unsettled. */
export async function readReplicaRepairCapability(store: Store, scope: SyncScope, open?: OpenSyncIssues) {
  const state = await store.getEngineState(scope);
  const issues = open ?? await readOpenSyncIssues(store, scope);
  const live: QueueOperation[] = [];
  for (const status of ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside'] as const) {
    let after = 0;
    for (;;) {
      const rows = await store.listQueue(scope, status, after, 1000); live.push(...rows);
      if (rows.length < 1000) break;
      after = rows.at(-1)!.sequence;
    }
  }
  let unsettled = false;
  for (const row of live) {
    if (row.status === 'set_aside' || !row.attempt && row.status !== 'claimed') continue;
    const receipt = await store.getQueueReceipt?.(scope, row.sequence);
    if (receipt?.kind !== 'terminal' || receipt.opId !== row.opId) { unsettled = true; break; }
  }
  const required = state?.recoveryFrozen === true || issues.operationalTotal > 0;
  return { state, queuedOperations: live.length, rebuildAvailable: required && !unsettled,
    reason: unsettled ? 'upload_outcome_unsettled' : required ? undefined : 'rebuild_not_required' };
}

import { readOpenSyncIssues, type OpenSyncIssues, type SyncIssueStore } from './sync-issues.js';
import type { createSyncStateStore, SyncScope, QueueOperation } from './sync-state-store.js';

type Store = SyncIssueStore & Pick<ReturnType<typeof createSyncStateStore>, 'listQueue' | 'getEngineState'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'getQueueReceipt'>>;
/** Unsettled uploads require a server retirement before archive. Native unknowns always block. */
export async function readReplicaRepairCapability(store: Store, scope: SyncScope, open?: OpenSyncIssues,
  options: { readonly serverRetirement?: boolean } = {}) {
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
    if (row.status === 'set_aside' || row.status === 'pending' && !row.attempt) continue;
    const receipt = await store.getQueueReceipt?.(scope, row.sequence);
    if (receipt?.kind !== 'terminal' || receipt.opId !== row.opId) { unsettled = true; break; }
  }
  const nativeUnknown = issues.waits.some(wait => wait.waitReason === 'native_result_unknown');
  const required = state?.recoveryFrozen === true || issues.operationalTotal - issues.local.filter(issue => issue.recovery === 'automatic').length > 0;
  return { state, queuedOperations: live.length, retirementRequired: unsettled,
    rebuildAvailable: required && (!unsettled || options.serverRetirement === true) && !nativeUnknown,
    reason: nativeUnknown ? 'native_outcome_unsettled' : unsettled && !options.serverRetirement
      ? 'upload_outcome_unsettled' : required ? undefined : 'rebuild_not_required' };
}

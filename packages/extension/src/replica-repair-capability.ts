import { stalledUploadHead } from './engine-public-stability.js';
import { readOpenSyncIssues, type OpenSyncIssues, type SyncIssueStore } from './sync-issues.js';
import type { createSyncStateStore, SyncScope, QueueOperation } from './sync-state-store.js';

type Store = SyncIssueStore & Pick<ReturnType<typeof createSyncStateStore>, 'listQueue' | 'getEngineState'>
  & Partial<Pick<ReturnType<typeof createSyncStateStore>, 'getQueueReceipt' | 'listUnreadableQueue'>>;

/**
 * K3: what a local "Reset sync on this device" can do from the current state.
 *
 * - `local`: nothing the server may own is outstanding; the old scope is archived and replaced.
 * - `server_fenced`: an upload may already be on the server (or the local record of it cannot be read),
 *   so the old replica is first retired on the server; that fence is what makes archiving it safe.
 *   It needs a connection: offline, `rebuildBlockedReason` is `offline` and nothing is lost by waiting.
 */
export interface ReplicaRepairCapability {
  readonly state: Awaited<ReturnType<Store['getEngineState']>> | undefined;
  readonly queuedOperations: number;
  readonly rebuildAvailable: boolean;
  readonly rebuildMode: 'local' | 'server_fenced';
  /** A code, set only when a Reset is needed but cannot be done now (`offline`, `native_outcome_unsettled`). */
  readonly rebuildBlockedReason?: string;
  /** Why the button is absent: `rebuild_not_required` in a healthy state, otherwise the blocked reason. */
  readonly reason?: string;
  /** The local state could not be read; the Reset archives it raw. */
  readonly unreadable?: true;
}

const browserOnline = () => typeof navigator === 'undefined' || (navigator as { onLine?: boolean }).onLine !== false;

/**
 * Rebuild archives unsent work. A sent upload whose outcome is unsettled makes the Reset server-fenced
 * instead of unavailable; a state that cannot be read at all (B-09) is a stuck state with a way out too.
 */
export async function readReplicaRepairCapability(store: Store, scope: SyncScope, open?: OpenSyncIssues,
  env: { readonly online?: () => boolean } = {}): Promise<ReplicaRepairCapability> {
  const online = (env.online ?? browserOnline)();
  let state: ReplicaRepairCapability['state']; let issues: OpenSyncIssues; const live: QueueOperation[] = [];
  let unsettled = false; let unreadableSent = false;
  try {
    state = await store.getEngineState(scope);
    issues = open ?? await readOpenSyncIssues(store, scope);
    for (const status of ['pending', 'claimed', 'deferred', 'gap', 'blocked', 'unknown', 'set_aside'] as const) {
      let after = 0;
      for (;;) {
        const rows = await store.listQueue(scope, status, after, 1000); live.push(...rows);
        if (rows.length < 1000) break;
        after = rows.at(-1)!.sequence;
      }
    }
    for (const row of live) {
      if (row.status === 'set_aside' || row.status === 'pending' && !row.attempt) continue;
      const receipt = await store.getQueueReceipt?.(scope, row.sequence);
      if (receipt?.kind !== 'terminal' || receipt.opId !== row.opId) { unsettled = true; break; }
    }
    unreadableSent = (await store.listUnreadableQueue?.(scope) ?? []).some(row => row.kind === 'sent');
  } catch {
    return { state: undefined, queuedOperations: 0, rebuildMode: 'server_fenced', rebuildAvailable: online, unreadable: true,
      ...(online ? {} : { rebuildBlockedReason: 'offline', reason: 'offline' }) };
  }
  const nativeUnknown = issues.waits.some(wait => wait.waitReason === 'native_result_unknown');
  const required = state?.phase === 'error' || state?.recoveryFrozen === true
    || issues.operationalTotal - issues.local.filter(issue => issue.recovery === 'automatic').length > 0
    || stalledUploadHead(live) !== undefined || unreadableSent;
  const fenced = unsettled || unreadableSent;
  // An unknown native side effect is settled through its own wait decision, which is its way out.
  const blocked = nativeUnknown ? 'native_outcome_unsettled' : required && fenced && !online ? 'offline' : undefined;
  return { state, queuedOperations: live.length, rebuildMode: fenced ? 'server_fenced' : 'local',
    rebuildAvailable: required && blocked === undefined, ...(blocked ? { rebuildBlockedReason: blocked } : {}),
    reason: blocked ?? (required ? undefined : 'rebuild_not_required') };
}

import { retrySetAsidePullItems } from '../pull-item-retry.js';
import { reasonCode } from '../push-error-code.js';
import type { RecaptureQueueRow } from '../queue-recapture.js';
import { pullLocalActions, pushLocalActions } from '../sync-issue-local-actions.js';
import { pullIssueId, queueIssueCode, queueIssueId } from '../sync-issue-snapshot.js';
import { readOpenSyncIssues, type SyncIssueStore } from '../sync-issues.js';
import type { createSyncStateStore, QueueOperation, SyncScope } from '../sync-state-store.js';
import type { SyncIssueActionRequest, SyncIssueActionResponse } from '../types.js';
import { retryQueueIssue } from './issue-retry.js';

/** The whole store: Try again for a remote item hands it to the pull layer's own entry point (`pull-item-retry.ts`). */
type Store = ReturnType<typeof createSyncStateStore> & SyncIssueStore;

export interface SyncIssueActionDeps {
  readonly scope: () => Promise<SyncScope>;
  readonly store: Store;
  /** Runs changes to the upload queue where a push pass cannot race them. */
  readonly run: <T>(work: () => Promise<T>) => Promise<T>;
  /** Captures a held change afresh from the browser. */
  readonly recapture: (scope: SyncScope) => RecaptureQueueRow;
  /** Starts a manual sync pass, for what was released. */
  readonly wake: () => unknown;
}

/**
 * Try again and Dismiss on the Status card (K5). The items are named by the display ids the card shows, never
 * by a storage key, and every one is checked again against what is open now: an item that is gone, or whose
 * kind does not offer the action, is skipped and counted, never forced.
 *
 * Try again for a remote item (D3) puts its held change from the library back for the engine's next apply pass,
 * which this starts; the item is not listed until that pass has run, and then it is gone or back with its new
 * reason. The pull layer decides each one: `retried`, `superseded` (nothing left to do) or `unavailable`.
 */
export async function handleSyncIssueAction(deps: SyncIssueActionDeps, request: SyncIssueActionRequest): Promise<SyncIssueActionResponse> {
  let scope: SyncScope;
  try { scope = await deps.scope(); } catch { return { ok: false, error: 'not_connected' }; }
  try {
    // An item whose bookmark is here by now needs nothing, whatever was pressed.
    await deps.store.closeLandedPullIssues(scope).catch(() => 0);
    const open = await readOpenSyncIssues(deps.store, scope);
    const queue = new Map(open.queue.map(row => [queueIssueId(row, queueIssueCode(row)), row] as const));
    const pull = new Map(open.pull.map(row => [pullIssueId(row.nodeId), row] as const));
    const rows: QueueOperation[] = []; const nodes: string[] = []; let skipped = 0;
    for (const id of new Set(request.issueIds)) {
      const upload = queue.get(id); const remote = pull.get(id);
      if (upload && pushLocalActions(upload).includes(request.action)) rows.push(upload);
      else if (remote && pullLocalActions(remote).includes(request.action)) nodes.push(remote.nodeId);
      else skipped += 1;
    }
    if (request.action === 'dismiss') {
      const uploads = rows.length ? await deps.run(() => deps.store.dismissQueueIssues(scope, rows.map(row => row.opId))) : undefined;
      const remote = nodes.length ? await deps.store.dismissPullIssues(scope, nodes) : undefined;
      return { ok: true, done: (uploads?.closed.length ?? 0) + (remote?.closed.length ?? 0),
        skipped: skipped + (uploads?.refused.length ?? 0) + (remote?.refused.length ?? 0), failed: 0 };
    }
    let done = 0; let failed = 0; let code: string | undefined;
    let remote = 0; let superseded = 0; let unavailable = 0;
    const recapture = deps.recapture(scope);
    await deps.run(async () => {
      for (const row of rows) {
        try { await retryQueueIssue(deps.store, scope, row, recapture); done += 1; }
        catch (error) { failed += 1; code ??= reasonCode(error, 'retry_failed'); }
      }
      if (nodes.length === 0) return;
      try {
        for (const answer of (await retrySetAsidePullItems({ store: deps.store, scope }, nodes)).values()) {
          if (answer === 'retried') { done += 1; remote += 1; } else if (answer === 'superseded') superseded += 1; else unavailable += 1;
        }
      } catch (error) { failed += nodes.length; code ??= reasonCode(error, 'retry_failed'); }
    });
    // The pass runs on its own; the card does not wait for it.
    if (done > 0) void Promise.resolve(deps.wake()).catch(() => undefined);
    return { ok: true, done, skipped, failed, ...(code ? { code } : {}), ...(done > 0 ? { woke: true } : {}),
      ...(remote > 0 ? { remote } : {}), ...(superseded > 0 ? { superseded } : {}), ...(unavailable > 0 ? { unavailable } : {}) };
  } catch (error) { return { ok: false, error: reasonCode(error, 'state_unavailable') }; }
}

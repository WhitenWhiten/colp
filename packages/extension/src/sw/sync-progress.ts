import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { scanBoundary } from '../bookmark-boundary.js';
import { createChromeBookmarkTreeAdapter } from '../chrome-bookmark-tree.js';
import { projectSyncProgress } from '../sync-progress.js';
import { readOpenSyncIssues } from '../sync-issues.js';
import { syncStopState } from '../sync-stop-state.js';
import type { SyncScope } from '../sync-state-store.js';
import type { SyncProgressResponse } from '../types.js';
import { hasBookmarkPermission, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';

/** Rows the lane can still drain. Isolated or rejected changes are reported as issues. */
const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'unknown', 'gap', 'blocked'] as const;

/**
 * `known.sync.progress.get`: read-only, parameterless, like the attention
 * read. No lane, no wake, no gesture. Signed out or sync not set up answers
 * `progress: null`; the pages then show nothing. Sync that is set up but has
 * lost bookmark access has no tree to count, so it says why (`permissionRequired`)
 * instead of leaving the bar to vanish.
 */
export async function handleSyncProgressRequest(): Promise<SyncProgressResponse> {
  let scope: SyncScope;
  try { scope = await currentSyncScope({ allowStopped: true }); } catch { return { ok: true, progress: null }; }
  const recorded = await syncState.getScope(scope);
  const firstRun = recorded?.firstRun ?? 'none';
  if (firstRun === 'none' || firstRun === 'deferred') return { ok: true, progress: null };
  if (!await hasBookmarkPermission()) return { ok: true, progress: null, permissionRequired: true };
  const run = [...await syncState.listBootstrapRuns(scope)].sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const preview = run?.previewId ? await syncState.getScopePreview(scope, run.previewId) : null;
  const [bindings, mappings] = await Promise.all([syncState.listMountBindings(scope), syncState.listMappings(scope)]);
  const nativeByColp = new Map(mappings.map((row) => [row.colpId, row.nativeId]));
  const selected = [...new Set([
    ...bindings.filter((row) => row.status === 'active').map((row) => row.nativeRootId),
    ...(preview?.boundary.selectedNativeIds ?? []),
    ...(recorded?.selectedRoots ?? []).flatMap((id) => nativeByColp.get(id) ?? []),
  ])];
  const privateNativeIds = (recorded?.privateRoots ?? []).flatMap((id) => nativeByColp.get(id) ?? []);
  // Plain read of the personal tree (subscription folders filtered out). Not the
  // capability-wrapped port: a paused sync must still report how far it got.
  const tree = await createChromeBookmarkTreeAdapter(personalTreeApi()).read();
  const scan = scanBoundary({ roots: tree.roots, selectedNativeIds: selected,
    excludedNativeIds: preview?.boundary.excludedNativeIds ?? [], privateNativeIds });
  let liveWork = false;
  for (const status of LIVE_STATUSES) {
    if ((await syncState.listQueue(scope, status, 0, 1)).length > 0) { liveWork = true; break; }
  }
  const [engine, captures, acknowledgements, issues] = await Promise.all([syncState.getEngineState(scope),
    syncState.listBookmarkEventsByStatus(scope, 'pending', 0, 1), syncState.listAckIntents(scope),
    readOpenSyncIssues(syncState, scope, { mappings })]);
  const unsettled = engine?.recoveryFrozen === true || captures.length > 0
    || acknowledgements.some(row => row.state === 'pending')
    || Boolean(engine?.lastPublishedCursor && engine.lastPublishedCursor !== engine.lastAckedCursor);
  // The same reading of "has sync stopped" as the Status card, the report and the copied details.
  const stop = syncStopState({ ...(engine?.lastError ? { lastError: engine.lastError } : {}),
    ...(typeof recorded?.metadata?.recoveryCode === 'string' ? { recoveryCode: recorded.metadata.recoveryCode } : {}),
    ...(engine?.phase ? { phase: engine.phase } : {}), ...(engine?.circuitBreaker ? { breaker: engine.circuitBreaker } : {}) });
  return { ok: true, progress: projectSyncProgress({
    issueCount: issues.total,
    ...(engine?.phase === 'error' || stop?.kind === 'terminal' ? { retryAutomatic: false } : {}),
    // A breaker that tripped on something that ends by itself is a pause, and says when it ends.
    ...(stop?.kind === 'cooling' ? { coolingDown: true } : {}),
    firstRun, ...(run ? { runPhase: run.phase } : {}), roots: tree.roots, classifications: scan.classifications,
    // Provisional identities exist before a create has a server receipt.
    mappedNativeIds: new Set(mappings.filter((row) => !/^(pending-|local-|mount:)/u.test(row.colpId)
      && row.projection?.revision !== 'local-root')
      .map((row) => row.nativeId)), liveWork, unsettled,
  }) };
}

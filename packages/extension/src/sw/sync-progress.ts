import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { scanBoundary } from '../bookmark-boundary.js';
import { createChromeBookmarkTreeAdapter } from '../chrome-bookmark-tree.js';
import { projectSyncProgress } from '../sync-progress.js';
import { syncAttentionTerminalCode } from '../sync-attention-ui.js';
import type { SyncScope } from '../sync-state-store.js';
import type { SyncProgressResponse } from '../types.js';
import { hasBookmarkPermission, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';

/** Queue rows that still have to reach the server, held ones included. `rejected` is settled history. */
const LIVE_STATUSES = ['pending', 'claimed', 'deferred', 'unknown', 'gap', 'blocked', 'set_aside'] as const;

/**
 * `known.sync.progress.get`: read-only, parameterless, like the attention
 * read. No lane, no wake, no gesture. Signed out, sync not set up, or no
 * bookmark access answers `progress: null`; the pages then show nothing.
 */
export async function handleSyncProgressRequest(): Promise<SyncProgressResponse> {
  let scope: SyncScope;
  try { scope = await currentSyncScope({ allowStopped: true }); } catch { return { ok: true, progress: null }; }
  if (!await hasBookmarkPermission()) return { ok: true, progress: null };
  const recorded = await syncState.getScope(scope);
  const firstRun = recorded?.firstRun ?? 'none';
  if (firstRun === 'none' || firstRun === 'deferred') return { ok: true, progress: null };
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
  const [engine, captures, acknowledgements] = await Promise.all([syncState.getEngineState(scope),
    syncState.listBookmarkEventsByStatus(scope, 'pending', 0, 1), syncState.listAckIntents(scope)]);
  const unsettled = engine?.recoveryFrozen === true || captures.length > 0
    || acknowledgements.some(row => row.state === 'pending')
    || Boolean(engine?.lastPublishedCursor && engine.lastPublishedCursor !== engine.lastAckedCursor);
  return { ok: true, progress: projectSyncProgress({
    ...(engine?.phase === 'error' || syncAttentionTerminalCode(engine?.lastError,
      typeof recorded?.metadata?.recoveryCode === 'string' ? recorded.metadata.recoveryCode : undefined)
      ? { retryAutomatic: false } : {}),
    firstRun, ...(run ? { runPhase: run.phase } : {}), roots: tree.roots, classifications: scan.classifications,
    // Provisional identities exist before a create has a server receipt.
    mappedNativeIds: new Set(mappings.filter((row) => !/^(pending-|local-|mount:)/u.test(row.colpId)
      && row.projection?.revision !== 'local-root')
      .map((row) => row.nativeId)), liveWork, unsettled,
  }) };
}

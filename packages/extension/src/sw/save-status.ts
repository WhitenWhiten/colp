import { resolveIngressBoundary } from '../bookmark-event-ingress.js';
import { folderIsInSyncRange, readDefaultFolder, walkAncestorIds } from '../save-folder.js';
import { collectSaveStatusFacts } from '../save-status-facts.js';
import { projectSaveStatus, readLastSave } from '../save-status.js';
import { projectSyncStatus, type SyncStatus } from '../sync-status.js';
import { hasBookmarkPermission, syncState } from './runtime.js';
import { currentSyncScope } from './scope.js';

export type SaveStatusOk = {
  readonly ok: true;
  readonly status: SyncStatus;
  readonly localOnly: boolean;
  readonly privateNativeIds: readonly string[];
  readonly mountNativeIds: readonly string[];
  readonly nativeId?: string;
  readonly defaultFolderId?: string;
};

export async function handleSaveStatus(nativeId?: string): Promise<SaveStatusOk | { readonly ok: false; readonly error: string }> {
  const last = await readLastSave();
  const targetId = nativeId ?? last?.nativeId;
  let mountNativeIds: string[] = [];
  let privateNativeIds: string[] = [];
  const online = navigator.onLine === true;
  try {
    const scope = await currentSyncScope();
    const boundary = await resolveIngressBoundary(syncState, scope);
    privateNativeIds = [...boundary.privateNative];
    mountNativeIds = [...boundary.selectedNative];
    let inSyncRange = mountNativeIds.length > 0;
    if (targetId && await hasBookmarkPermission()) {
      const ancestors = await walkAncestorIds(targetId, async (id) => {
        const nodes = await chrome.bookmarks.get(id).catch(() => []);
        return nodes[0]?.parentId;
      });
      inSyncRange = folderIsInSyncRange(targetId, ancestors, boundary.selectedNative, boundary.privateNative);
    } else if (last?.localOnly === true) {
      inSyncRange = false;
    }
    const defaultFolderId = (await readDefaultFolder())?.folderNativeId;
    if (!targetId) {
      const recorded = await syncState.getScope(scope);
      const incomplete = recorded?.firstRun !== 'completed' && recorded?.firstRun !== 'running';
      const kind = projectSaveStatus({
        paint: 'projected', localCreateSucceeded: false, inSyncRange, firstRunIncomplete: incomplete,
        online, pendingWork: false, needsAttention: false, hasAuthoritativeReceipt: false, hasApplyEvidence: false,
      });
      return { ok: true, status: projectSyncStatus(kind), localOnly: !inSyncRange || incomplete, mountNativeIds, privateNativeIds,
        ...(defaultFolderId ? { defaultFolderId } : {}) };
    }
    const facts = await collectSaveStatusFacts({
      store: syncState, scope, nativeId: targetId, inSyncRange, paint: 'projected',
      localCreateSucceeded: true, online,
    });
    return {
      ok: true, status: projectSyncStatus(projectSaveStatus(facts)), localOnly: !inSyncRange || facts.firstRunIncomplete,
      mountNativeIds, privateNativeIds, nativeId: targetId, ...(defaultFolderId ? { defaultFolderId } : {}),
    };
  } catch {
    const kind = projectSaveStatus({
      paint: 'projected', localCreateSucceeded: Boolean(targetId), inSyncRange: false,
      firstRunIncomplete: true, online, pendingWork: false, needsAttention: false,
      hasAuthoritativeReceipt: false, hasApplyEvidence: false,
    });
    return { ok: true, status: projectSyncStatus(kind), localOnly: true, mountNativeIds, privateNativeIds, ...(targetId ? { nativeId: targetId } : {}) };
  }
}

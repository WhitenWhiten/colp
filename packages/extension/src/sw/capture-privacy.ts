import type { CaptureTask } from '../capture/contracts.js';
import { captureOwnerKey } from '../capture/contracts.js';
import { decideIngressPrivacy, resolveIngressBoundary } from '../bookmark-event-ingress.js';
import { nativeIsLocallyExcluded } from '../remote-delete-exclusion.js';
import { assertPersonalCapture } from '../bookmark-subscriptions/capture-boundary.js';
import { currentCaptureScope, assertCaptureScope } from './capture-native.js';
import { currentSyncScope } from './scope.js';
import { hasBookmarkPermission, syncState } from './runtime.js';

/** Sync labels and cached mappings cannot authorize disclosure of page data. */
export async function captureIsInSyncRange(task: CaptureTask): Promise<boolean> {
  try {
    const current = await currentCaptureScope();
    if (!current.accountId || !current.collectionId || captureOwnerKey(current) !== captureOwnerKey(task.scope)
      || current.collectionId !== task.scope.collectionId || !await hasBookmarkPermission()) return false;
    // A duplicate elsewhere in the browser is not authorized by the requested destination.
    const nativeId = task.nativeId ?? (task.disposition === 'new' && task.save !== 'local-saved' ? task.targetNativeId : undefined);
    if (!nativeId) return false;
    await assertPersonalCapture(task);
    const scope = await currentSyncScope();
    if (scope.accountId !== current.accountId || scope.collectionId !== current.collectionId) return false;
    const boundary = await resolveIngressBoundary(syncState, scope);
    const ancestors: string[] = [];
    let cursor: string | undefined = nativeId;
    let managed = false;
    while (cursor) {
      if (ancestors.includes(cursor) || ancestors.length >= 64) return false;
      const [node] = await chrome.bookmarks.get(cursor);
      if (!node) return false;
      ancestors.push(cursor); managed ||= Boolean(node.unmodifiable);
      cursor = node.parentId;
    }
    if (await nativeIsLocallyExcluded(syncState, scope, nativeId, ancestors)) return false;
    const { privacy } = decideIngressPrivacy({ rootStatus: boundary.rootStatus, mapped: false,
      selected: ancestors.some(id => boundary.selectedNative.has(id)),
      privateLocal: ancestors.some(id => boundary.privateNative.has(id)), managed, allowUnmappedSelected: true });
    await assertCaptureScope(current);
    return privacy.allowOperationCandidate;
  } catch {
    // Missing permission, unavailable storage/tree, or changed authority keeps data local.
    return false;
  }
}

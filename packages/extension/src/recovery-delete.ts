import { lookupBookmark } from './bookmark-api-error.js';
import { unqueuedNativeContentFields } from './pull-native-content-barrier.js';
import { performCheckedNativeWrite, prepareNativeWriteCheck, type NativeWriteBoundaryStore } from './pull-native-write-boundary.js';
import { nativeContent } from './pull-projection.js';
import { assertSnapshotNativeBoundary } from './snapshot-native-boundary.js';
import { SnapshotItemPreconditionError } from './snapshot-item-precondition.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { SyncScope } from './sync-state-store.js';

/** A complete Snapshot proves remote absence. It does not authorize erasing a
 * new native edit, and a retry must not adopt that edit as its old preimage. */
export async function applySnapshotDeletion(input: {
  readonly store: NativeWriteBoundaryStore; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly colpId: string; readonly nativeId: string; readonly selectedRootNativeId: string;
}): Promise<void> {
  const { store, scope, api, nativeId, colpId } = input;
  const existing = await lookupBookmark(id => api.get(id), nativeId);
  if (existing.class === 'not_found') return;
  if (existing.class !== 'present') throw new Error(existing.message);
  const target = await store.getMappingByColpId(scope, colpId), current = existing.nodes[0];
  if (!target || target.nativeId !== nativeId || !current) throw new SyncFailureError('need_authority');
  const boundary = () => assertSnapshotNativeBoundary({ store, scope, api, mapping: target,
    kind: 'delete', legacyRootNativeId: input.selectedRootNativeId });
  await boundary();
  if (Object.keys(unqueuedNativeContentFields(current, nativeContent(target.projection.content ?? {}), {})).length
      || target.parentNativeId !== undefined && current.parentId !== target.parentNativeId) {
    throw new SnapshotItemPreconditionError('concurrent_local_mutation', { nodeId: colpId, nativeId });
  }
  const unchanged = await prepareNativeWriteCheck({ store, scope, api, mapping: target, preimage: current });
  const beforeNative = async () => { await boundary(); await unchanged(); };
  // The plan orders explicit members child-first. Chrome's non-recursive,
  // atomic non-empty check protects children that the plan never authorized.
  await performCheckedNativeWrite(api, beforeNative, check => api.remove(nativeId, check));
}

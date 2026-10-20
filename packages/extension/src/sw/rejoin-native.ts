import type { RejoinChrome } from '../scope-rejoin-mutation.js';
import type { SyncScope } from '../sync-state-store.js';
import { personalTreeApi } from '../bookmark-subscriptions/personal-boundary.js';
import { createChromeBookmarkTreeAdapter } from '../chrome-bookmark-tree.js';
import { discoveredFromRoots } from '../scope-range.js';
import { readSnapshotAuthority } from './advanced-first-run.js';
import type { BoundaryAttempt } from './boundary-attempt.js';
import { nativeChromeFacts } from './native-chrome.js';
import type { PreparedRangeCommand } from './range-command.js';
import { syncState } from './runtime.js';

/** A fresh complete snapshot and every native call share the original attempt. */
export async function rejoinNative(scope: SyncScope, attempt: BoundaryAttempt,
  admittedNativeRootIds: readonly string[] = []): Promise<RejoinChrome> {
  return attempt.nativeApi({ ...nativeChromeFacts(), admittedNativeRootIds,
    readRemoteSnapshot: async () => {
      await attempt.assertCurrent();
      const { snapshot } = await readSnapshotAuthority(scope);
      await attempt.assertCurrent();
      return snapshot;
    } });
}

/** Only a still-owned, explicitly confirmed range journal can authorize a
 * newly selected root before its final root-authority phase. Detached mounts
 * alone never grant admission, including when GET resumes an accepted choice. */
export async function pendingRejoinAdmission(scope: SyncScope, attempt: BoundaryAttempt): Promise<string[]> {
  const recorded = await syncState.getScope(scope);
  const commands = (await syncState.listPendingBoundaryCommands(scope)).filter(row => row.kind === 'range');
  if (!commands.length) return [];
  if (commands.length !== 1 || !recorded) throw new Error('rejoin_boundary_changed');
  const command = commands[0]!;
  const preview = await syncState.getScopePreview(scope, command.previewId);
  if (command.boundaryVersion !== (recorded.boundaryVersion ?? '0') || !preview
    || preview.consumedBy !== command.commandId || preview.boundaryVersion !== command.boundaryVersion
    || preview.treeDigest !== command.treeDigest) throw new Error('rejoin_boundary_changed');
  const plan = command.payload as unknown as PreparedRangeCommand;
  if (plan.libraryId !== scope.collectionId || !Array.isArray(plan.selectedNativeIds)
    || !Array.isArray(plan.rejoinNativeIds)) throw new Error('rejoin_boundary_changed');
  const selected = new Set(preview.boundary.selectedNativeIds.filter(id => plan.selectedNativeIds.includes(id)));
  const mounts = new Set((await syncState.listMountBindings(scope)).map(row => row.nativeRootId));
  const tree = await createChromeBookmarkTreeAdapter(await attempt.nativeApi(personalTreeApi())).read();
  const discovered = discoveredFromRoots(tree.roots);
  await attempt.assertCurrent();
  return plan.rejoinNativeIds.filter(id => typeof id === 'string' && mounts.has(id) && discovered.has(id)
    && [id, ...discovered.get(id)!].some(ancestor => selected.has(ancestor)));
}

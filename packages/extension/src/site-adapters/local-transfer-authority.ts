import { nativeIsLocallyExcluded } from '../remote-delete-exclusion.js';
import { assertSourceRoot } from '../sw/planned-capture.js';
import { managedLibraryKey } from './copy-identity.js';
import type { LocalCopyTransfer } from './local-identity.js';
import { currentSyncScope } from '../sw/scope.js';
import { syncState } from '../sw/runtime.js';
export async function assertTransferCurrent(transfer: LocalCopyTransfer) {
  if (!transfer.owner) throw Error('sourceSyncOwnerChanged');
  const scope = await currentSyncScope();
  if (managedLibraryKey(scope) !== managedLibraryKey(transfer.owner)) throw Error('sourceSyncOwnerChanged');
  if (await nativeIsLocallyExcluded(syncState, scope, transfer.native.nativeId, [transfer.parent.nativeId])) throw Error('sourceSyncOwnerChanged');
  if (!(await assertSourceRoot(transfer.parent)).inRange) throw Error('sourceSyncOwnerChanged');
  const native = (await chrome.bookmarks.get(transfer.native.nativeId).catch(() => []))[0];
  if (!native) throw Error('sourceCopySuppressed');
  if (native.dateAdded !== transfer.native.dateAdded || native.parentId !== transfer.parent.nativeId || native.title !== transfer.title
    || (native.url ?? null) !== transfer.url) throw Error('sourceCopyDetached');
  return { scope, native, owner: transfer.owner };
}

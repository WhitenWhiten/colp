import { requestValue } from '../sync-state/idb.js';
import { siteLedger } from './source-runtime.js';
import type { LocalCopyTransfer } from './local-identity.js';
import type { Representation } from './contracts.js';
/** A duplicate folder waits for its source children, but personal or edited children require review. */
export async function assertConvergenceChildren(transfer: LocalCopyTransfer) {
  if (transfer.slot.kind !== 'folder' || !transfer.connectionId) return;
  const collection = transfer.slot.source.sourceCollectionId;
  const children = await chrome.bookmarks.getChildren(transfer.native.nativeId).catch(() => []);
  await siteLedger.db.transaction(['work', 'representations'], 'readonly', async tx => {
    if (await requestValue(tx.objectStore('work').index('connectionId').count(transfer.connectionId))) return;
    for (const child of children) {
      const owned = await requestValue(tx.objectStore('representations').index('nativeId').getAll(child.id)) as Representation[];
      if (!owned.some(r => r.connectionId === transfer.connectionId && r.purpose === 'sourceArchive' && r.sourceCollectionId === collection
        && r.state === 'active' && r.native.dateAdded === child.dateAdded)) throw Error('source_copy_convergence_review');
    }
  });
}

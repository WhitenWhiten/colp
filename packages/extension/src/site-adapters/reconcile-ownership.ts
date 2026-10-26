import type { Representation, SourceFolderReservation } from './contracts.js';
import type { ContentBindingRow } from './content-bindings.js';
import type { ReconcileDifference } from './reconcile-model.js';
import type { SourceDatabase } from './source-db.js';
import { representationKey } from './reservations.js';
import { requestValue } from '../sync-state/idb.js';

/** Revalidate only the affected native subtree, including ownership acquired after preview. */
export async function assertReconcileOwnershipRecords(db: SourceDatabase, connectionId: string, row: ReconcileDifference, nativeId: string) {
  const tree = (await chrome.bookmarks.getSubTree(nativeId))[0];
  if (!tree) throw new Error('source_copy_protected');
  const nodes: chrome.bookmarks.BookmarkTreeNode[] = [];
  const visit = (node: chrome.bookmarks.BookmarkTreeNode, depth = 0) => {
    if (depth > 128 || nodes.length >= 100000) throw new Error('capacity');
    nodes.push(node); for (const child of node.children ?? []) visit(child, depth + 1);
  }; visit(tree);
  await db.transaction(['representations', 'contentBindings', 'folderReservations', 'mounts'], 'readonly', async tx => {
    for (const node of nodes) {
      const [reps, bindings, folders, mounts] = await Promise.all([
        requestValue(tx.objectStore('representations').index('nativeId').getAll(node.id)) as Promise<Representation[]>,
        requestValue(tx.objectStore('contentBindings').index('nativeId').getAll(node.id)) as Promise<ContentBindingRow[]>,
        requestValue(tx.objectStore('folderReservations').index('nativeId').getAll(node.id)) as Promise<SourceFolderReservation[]>,
        requestValue(tx.objectStore('mounts').index('nativeId').count(node.id)),
      ]);
      const foreign = reps.some(r => row.folder
        ? r.connectionId !== connectionId || r.purpose !== 'sourceArchive' || r.sourceCollectionId !== row.collectionId || r.mountId !== row.folder.mountId
        : !row.representation || node.id !== nativeId || representationKey(r) !== representationKey(row.representation));
      if (node.unmodifiable || mounts || foreign || bindings.some(b => !b.supersededBy)
        || folders.some(f => !row.folder || f.id !== row.folder.id)) throw new Error('source_copy_protected');
    }
  });
}

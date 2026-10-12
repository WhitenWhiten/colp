import { createFolderDescriptionStore, descriptionMatchesFolder } from '../folder-description-store.js';
import { descriptionFoldersFromTree } from '../folder-description-native.js';
import type { FolderTreeNode } from '../save-folder.js';

export async function retainRemovedDescriptions(ids: readonly string[], tree: readonly FolderTreeNode[]) {
  const store = createFolderDescriptionStore();
  try { await store.remove(ids, [...descriptionFoldersFromTree(tree).values()]); } finally { store.close(); }
}
export async function restoreCreatedDescriptions(tree: readonly FolderTreeNode[]) {
  const store = createFolderDescriptionStore();
  try { for (const folder of descriptionFoldersFromTree(tree).values()) await store.restoreRemoved(folder); }
  finally { store.close(); }
}
export async function collectDescriptionGarbage(tree: readonly FolderTreeNode[]) {
  const store = createFolderDescriptionStore(), live = descriptionFoldersFromTree(tree);
  try {
    const stale = (await store.list()).filter(row => { const folder = live.get(row.nativeId); return !folder || !descriptionMatchesFolder(row, folder); });
    await store.remove(stale.map(row => row.nativeId));
    const removed = (await store.list(true)).filter(row => row.removedAt !== undefined);
    for (const folder of live.values()) if (removed.some(row => row.title === folder.title)) await store.restoreRemoved(folder);
    await store.pruneRemoved();
  } finally { store.close(); }
}

import { createFolderDescriptionStore, descriptionMatchesFolder } from './folder-description-store.js';
import type { FolderTreeNode } from './save-folder.js';

export function descriptionFoldersFromTree(roots: readonly FolderTreeNode[]): ReadonlyMap<string, FolderTreeNode> {
  const folders = new Map<string, FolderTreeNode>(), pending = roots.map(node => ({ node, parentId: undefined as string | undefined }));
  for (let index = 0; index < pending.length; index++) {
    const { node, parentId } = pending[index]!;
    if (node.url === undefined) folders.set(node.id, { ...node, parentId: node.parentId ?? parentId });
    for (const child of node.children ?? []) pending.push({ node: child, parentId: node.id });
  }
  return folders;
}

export async function readNativeFolderDescriptions(roots: readonly FolderTreeNode[]): Promise<ReadonlyMap<string, string | null>> {
  const store = createFolderDescriptionStore();
  try {
    const folders = descriptionFoldersFromTree(roots), descriptions = new Map<string, string | null>();
    for (const row of await store.list()) {
      const folder = folders.get(row.nativeId);
      if (folder && descriptionMatchesFolder(row, folder)) descriptions.set(row.nativeId, row.description);
    }
    return descriptions;
  } finally { store.close(); }
}

export const FOLDER_DESCRIPTION_NOTICE = 'known.folderDescription.changed';
export function validFolderDescriptionNotice(value: unknown): value is { readonly kind: typeof FOLDER_DESCRIPTION_NOTICE; readonly nativeId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.kind === FOLDER_DESCRIPTION_NOTICE && typeof raw.nativeId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/u.test(raw.nativeId) && Object.keys(raw).length === 2;
}

let workerListener: ((nativeId: string) => void) | undefined;
/** A runtime message never reaches its own sender, so the worker hears its own edits (delete undo, restores) here. */
export function listenToWorkerFolderDescriptionChanges(listener: (nativeId: string) => void): void { workerListener = listener; }
export async function notifyFolderDescriptionChanged(nativeId: string): Promise<void> {
  workerListener?.(nativeId);
  try { await chrome.runtime.sendMessage({ kind: FOLDER_DESCRIPTION_NOTICE, nativeId }); }
  catch { /* The local save is durable; the next ordinary sync wake resumes its upload. */ }
}

import type { FolderTreeNode } from './save-folder.js';

type NativeFolder = Pick<FolderTreeNode, 'url' | 'parentId' | 'folderType' | 'unmodifiable'>;
const BOOKMARK_ROOT_TYPES = new Set(['bookmarks-bar', 'other', 'mobile', 'managed']);
const LEGACY_BOOKMARK_ROOT_IDS = new Set(['1', '2', '3']);

/** Call only for peers of the bookmarks bar, under getTree()'s invisible root.
 * folderType identifies standard roots independently of language and native id.
 * Chromium 121–133 lacks folderType; its local bar, other and mobile roots reserve ids 1, 2 and 3.
 * Unknown browser containers are outside the supported bookmark tree. Titles never determine access.
 */
export function isSupportedBookmarkRoot(node: NativeFolder & { readonly id: string }): boolean {
  if (node.url !== undefined) return false;
  if (node.unmodifiable === 'managed') return true;
  return node.folderType !== undefined ? BOOKMARK_ROOT_TYPES.has(node.folderType) : LEGACY_BOOKMARK_ROOT_IDS.has(node.id);
}

/** Project a complete getTree() result, preserving native order and ordinary
 * descendants. Unsupported browser containers and their entire subtrees stay
 * outside extension views. Do not pass arbitrary folders or imported file trees.
 */
export function supportedBookmarkTree<T extends NativeFolder & { readonly id: string; readonly children?: readonly T[] }>(
  roots: readonly T[],
): T[] {
  return roots.map(root => {
    if (!root.children) return root;
    const children = root.children.filter(isSupportedBookmarkRoot);
    return children.length === root.children.length ? root : { ...root, children };
  });
}

/** Check live ancestry so remembered destinations and stale suggestions obey the same root policy. */
export async function isUnsupportedBookmarkFolder(nativeId: string,
  lookup: (id: string) => Promise<NativeFolder | undefined> = async id => (await chrome.bookmarks.get(id))[0],
): Promise<boolean> {
  if (nativeId === '0') return true;
  let id: string | undefined = nativeId;
  let child: (NativeFolder & { readonly id: string }) | undefined;
  const seen = new Set<string>();
  while (id) {
    if (seen.has(id) || seen.size >= 256) throw new Error('bookmark_ancestry_unproven');
    seen.add(id);
    const node = await lookup(id);
    if (!node) return false;
    if (node.parentId === '0') return !isSupportedBookmarkRoot({ ...node, id });
    if (!node.parentId) return child !== undefined && !isSupportedBookmarkRoot(child);
    child = { ...node, id };
    id = node.parentId;
  }
  return false;
}

export async function assertBookmarkFolderAllowed(nativeId: string | undefined): Promise<void> {
  if (nativeId && await isUnsupportedBookmarkFolder(nativeId)) throw new Error('bookmark_folder_unavailable');
}

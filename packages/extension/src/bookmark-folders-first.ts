import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import { isSupportedBookmarkRoot } from './bookmark-folder-policy.js';

type Node = chrome.bookmarks.BookmarkTreeNode;
type Api = Pick<typeof chrome.bookmarks, 'get' | 'getChildren' | 'getTree' | 'move'>;

/** Stable native grouping. Protected nodes anchor separate sortable runs. */
export async function sortNativeBookmarkFolder(api: Api, parentId: string,
  enabled: () => Promise<boolean>, excluded: (id: string) => Promise<boolean>,
  onMoved: () => void = () => undefined): Promise<boolean> {
  try {
    const parent = (await api.get(parentId))[0];
    if (!parent) return false;
    if (!parent.parentId || parent.unmodifiable || await excluded(parentId)) return true;
    const children = await api.getChildren(parentId);
    let nextFolderIndex = 0;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]!;
      if (child.unmodifiable || child.type === 'separator' || await excluded(child.id)) {
        nextFolderIndex = index + 1;
        continue;
      }
      if (child.url !== undefined) continue;
      if (index !== nextFolderIndex) {
        if (!await enabled()) return false;
        // A concurrent delete or cross-folder drag must never be undone by this pass.
        const live = (await api.get(child.id))[0];
        if (!live || live.parentId !== parentId || live.unmodifiable || await excluded(child.id)) return false;
        const current = await api.getChildren(parentId);
        if (current.length !== children.length || current.some((node, i) => node.id !== children[i]?.id)) return false;
        if (!await enabled()) return false;
        await api.move(child.id, { parentId, index: nextFolderIndex });
        onMoved();
        children.splice(index, 1);
        children.splice(nextFolderIndex, 0, child);
      }
      nextFolderIndex += 1;
    }
    return true;
  } catch (error) {
    // A folder removed while the pass was waiting no longer needs sorting.
    if (classifyBookmarkApiFailure(error) !== 'not_found') throw error;
    return false;
  }
}

/** Never reorder browser root containers or enter managed/unsupported roots. */
export function nativeBookmarkFolders(tree: readonly Node[], excluded: ReadonlySet<string>): string[] {
  const pending = tree.flatMap(root => (root.children ?? []).filter(isSupportedBookmarkRoot));
  const result: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.url !== undefined || node.unmodifiable || excluded.has(node.id)) continue;
    result.push(node.id);
    pending.push(...(node.children ?? []).filter(child => child.url === undefined));
  }
  return result;
}

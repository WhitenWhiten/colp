import { t } from './i18n.js';
import type { FolderTreeNode } from './save-folder.js';
import { isSupportedBookmarkRoot } from './bookmark-folder-policy.js';

export interface FolderRow {
  readonly id: string;
  readonly title: string;
  readonly depth: number;
  /** At or under a live mount of the bound library. Information only — never a gate or a sort key. */
  readonly synced: boolean;
}

/**
 * The picker's rows in the browser's own order, like the native bookmark
 * dialog: a depth-first walk from the top-level folders (Bookmarks bar, Other
 * bookmarks, …). It skips getTree()'s invisible root, which holds no
 * bookmarks, workspace subtrees, managed (`unmodifiable`) folders, and read-only subscription
 * subtrees, which the save guard would refuse anyway.
 */
export function buildFolderRows(roots: readonly FolderTreeNode[], input: {
  readonly mounts: ReadonlySet<string>; readonly excluded: ReadonlySet<string>;
}): FolderRow[] {
  const rows: FolderRow[] = [];
  const visit = (node: FolderTreeNode, depth: number, insideMount: boolean): void => {
    if (node.url !== undefined || node.unmodifiable || input.excluded.has(node.id)) return;
    const synced = insideMount || input.mounts.has(node.id);
    const title = node.title || (depth === 0 ? t('sync_folder', 'Folder') : t('common_untitledFolder', 'Untitled folder'));
    rows.push({ id: node.id, title, depth, synced });
    for (const child of node.children ?? []) visit(child, depth + 1, synced);
  };
  for (const root of roots) {
    for (const child of root.children ?? []) {
      if (isSupportedBookmarkRoot(child)) visit(child, 0, input.mounts.has(root.id));
    }
  }
  return rows;
}

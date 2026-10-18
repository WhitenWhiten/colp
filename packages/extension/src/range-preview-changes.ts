import type { BoundaryScan } from './bookmark-boundary.js';
import type { NormalizedBookmarkNode, NormalizedBookmarkRoot } from './chrome-bookmark-tree.js';

export interface AddedRangeFolder {
  readonly nativeId: string;
  readonly title: string;
  readonly path: string;
  /** Newly covered bookmarks directly in this folder; descendants have their own rows. */
  readonly bookmarkCount: number;
}

export interface RangePreviewChanges {
  readonly addedBookmarkCount: number;
  readonly addedFolders: readonly AddedRangeFolder[];
}

/** Compare actual coverage, not the number of normalized mount roots. */
export function rangePreviewChanges(roots: readonly NormalizedBookmarkRoot[], before: BoundaryScan,
  after: BoundaryScan): RangePreviewChanges {
  const included = (scan: BoundaryScan, id: string) => {
    const kind = scan.classifications.get(id);
    return kind === 'ordinary-folder' || kind === 'special-root';
  };
  const added = (id: string) => included(after, id) && !included(before, id);
  let addedBookmarkCount = 0;
  const addedFolders: AddedRangeFolder[] = [];
  const visit = (node: NormalizedBookmarkNode, ancestors: readonly string[]) => {
    if (node.kind === 'bookmark') {
      if (added(node.nativeId)) addedBookmarkCount += 1;
      return;
    }
    const path = [...ancestors, node.title];
    if (node.kind === 'folder' && added(node.nativeId)) {
      addedFolders.push({ nativeId: node.nativeId, title: node.title, path: path.join(' / '),
        bookmarkCount: node.children.filter(child => child.kind === 'bookmark' && added(child.nativeId)).length });
    }
    for (const child of node.children) visit(child, path);
  };
  for (const root of roots) visit(root, []);
  return { addedBookmarkCount, addedFolders };
}

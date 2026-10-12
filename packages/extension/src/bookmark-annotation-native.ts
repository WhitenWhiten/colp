import { annotationMatchesBookmark, createBookmarkAnnotationStore, type BookmarkAnnotation } from './bookmark-annotation-store.js';

interface AnnotationTreeNode { readonly id: string; readonly parentId?: string; readonly url?: string; readonly dateAdded?: number; readonly children?: readonly AnnotationTreeNode[] }

/** Every bookmark (not folder) under these roots, in tree order. */
export function annotatedBookmarksFromTree(roots: readonly AnnotationTreeNode[]): AnnotationTreeNode[] {
  const bookmarks: AnnotationTreeNode[] = [], pending = [...roots].reverse(), seen = new Set<string>();
  while (pending.length) {
    const node = pending.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.url !== undefined) bookmarks.push(node);
    for (let at = (node.children?.length ?? 0) - 1; at >= 0; at--) pending.push(node.children![at]!);
  }
  return bookmarks;
}

/** Annotations that still belong to a live bookmark under these roots. Rows left by a deleted or reused id are ignored. */
export async function readNativeBookmarkAnnotations(roots: readonly AnnotationTreeNode[]): Promise<ReadonlyMap<string, BookmarkAnnotation>> {
  const store = createBookmarkAnnotationStore();
  try {
    const bookmarks = new Map(annotatedBookmarksFromTree(roots).map(node => [node.id, node]));
    const found = new Map<string, BookmarkAnnotation>();
    for (const row of await store.list()) {
      const bookmark = bookmarks.get(row.nativeId);
      if (bookmark && annotationMatchesBookmark(row, bookmark)) found.set(row.nativeId, row);
    }
    return found;
  } finally { store.close(); }
}

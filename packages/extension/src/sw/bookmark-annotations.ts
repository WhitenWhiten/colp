import type { FolderTreeNode } from '../save-folder.js';
import { annotatedBookmarksFromTree } from '../bookmark-annotation-native.js';
import { annotationMatchesBookmark, createBookmarkAnnotationStore, type BookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import { collectDescriptionGarbage, retainRemovedDescriptions, restoreCreatedDescriptions } from './folder-description-retention.js';

/** Same optional-permission probe as the worker runtime, kept local so this module loads without the runtime's storage setup. */
const bookmarksGranted = () => chrome.permissions.contains({ permissions: ['bookmarks'] }).catch(() => false);

interface RemovedNode { readonly id: string; readonly title?: string; readonly url?: string; readonly dateAdded?: number; readonly children?: readonly RemovedNode[] }

/** Ids of a removed bookmark or of every node in a removed folder. */
export function removedNativeIds(nativeId: string, node?: RemovedNode | null): string[] {
  const ids = new Set([nativeId]), pending = node ? [node] : [];
  while (pending.length && ids.size < 100_000) {
    const next = pending.pop()!; ids.add(next.id);
    for (const child of next.children ?? []) pending.push(child);
  }
  return [...ids];
}

/** Removal inside or outside Know-N reaches the worker as the same native event; the annotation goes with the bookmark. */
export async function dropRemovedAnnotations(event: { readonly nativeId: string; readonly removal: { readonly node?: RemovedNode | null } },
  store: BookmarkAnnotationStore = createBookmarkAnnotationStore()): Promise<void> {
  try {
    const nodes: RemovedNode[] = [], pending = event.removal.node ? [event.removal.node] : [];
    while (pending.length) { const node = pending.pop()!; nodes.push(node); pending.push(...node.children ?? []); }
    await store.removeMany(removedNativeIds(event.nativeId, event.removal.node), nodes);
  }
  finally { store.close(); }
}

/**
 * Backstop for removals the worker never saw (it was asleep, or the permission was off): drop rows whose bookmark is gone,
 * is now a folder, or has a different creation date because the id was reused. It does nothing without bookmark access
 * or when the browser returns no tree, so a read failure can never erase notes.
 */
export async function collectAnnotationGarbage(store: BookmarkAnnotationStore = createBookmarkAnnotationStore()): Promise<number> {
  try {
    if (!await bookmarksGranted() || typeof chrome.bookmarks?.getTree !== 'function') return 0;
    const tree = await chrome.bookmarks.getTree();
    if (!tree[0]?.children?.length) return 0;
    const live = new Map(annotatedBookmarksFromTree(tree).map(node => [node.id, node]));
    const stale = (await store.list()).filter(row => { const node = live.get(row.nativeId); return !node || !annotationMatchesBookmark(row, node); })
      .map(row => row.nativeId);
    await store.removeMany(stale);
    const removed = (await store.list(true)).filter(row => row.removedAt !== undefined);
    for (const node of live.values()) if (removed.some(row => row.url === node.url)) await store.restoreRemoved(node);
    await store.pruneRemoved();
    await collectDescriptionGarbage(tree);
    return stale.length;
  } finally { store.close(); }
}

let annotationEvents = Promise.resolve();
export function restoreCreatedAnnotations(node: RemovedNode) {
  const work = annotationEvents.then(async () => {
    const store = createBookmarkAnnotationStore();
    try { await store.restoreRemoved(node); await restoreCreatedDescriptions(descriptionTree([node])); } finally { store.close(); }
  });
  annotationEvents = work.catch(() => undefined); return work;
}
export function retainRemovedAnnotations(event: Parameters<typeof dropRemovedAnnotations>[0]) {
  const work = annotationEvents.then(async () => {
    await dropRemovedAnnotations(event);
    await retainRemovedDescriptions(removedNativeIds(event.nativeId, event.removal.node), descriptionTree(event.removal.node ? [event.removal.node] : []));
  });
  annotationEvents = work.catch(() => undefined); return work;
}

function descriptionTree(nodes: readonly RemovedNode[]): FolderTreeNode[] {
  return nodes.map(node => ({ ...node, title: node.title ?? '', children: descriptionTree(node.children ?? []) }));
}

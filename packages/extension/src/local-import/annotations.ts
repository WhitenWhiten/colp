import { createBookmarkAnnotationStore } from '../bookmark-annotation-store.js';
import { createFolderDescriptionStore } from '../folder-description-store.js';
import type { LocalImportItem } from './contracts.js';

/**
 * Writes the tags and notes of imported bookmarks onto their new native ids. Saving an unchanged row is a no-op, so a
 * resumed import repeats this safely.
 */
export async function restoreItemAnnotations(items: readonly LocalImportItem[]): Promise<void> {
  const descriptions = items.filter(item => item.description !== undefined && item.url === undefined);
  if (descriptions.length) {
    const store = createFolderDescriptionStore();
    try { for (const item of descriptions) {
      if (!item.nativeId) throw new Error('local_import_item_missing');
      const [node] = await chrome.bookmarks.get(item.nativeId);
      if (!node || node.url !== undefined || node.unmodifiable) throw new Error('capture_target_unavailable');
      await store.save(node, item.description!);
    } } finally { store.close(); }
  }
  const annotated = items.filter(item => item.annotation && item.url !== undefined);
  if (!annotated.length) return;
  const store = createBookmarkAnnotationStore();
  try {
    for (const item of annotated) {
      if (!item.nativeId) throw new Error('local_import_item_missing');
      const [node] = await chrome.bookmarks.get(item.nativeId);
      if (!node || node.url === undefined) throw new Error('capture_target_unavailable');
      await store.save(node, item.annotation!, { preserveTags: true });
      // The restored order already has the pinned bookmarks first; only the flag needs writing.
      if (item.annotation!.pinned) await store.setPinned(node, true);
    }
  } finally { store.close(); }
}

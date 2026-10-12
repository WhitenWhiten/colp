import { annotationMatchesBookmark, createBookmarkAnnotationStore, type BookmarkAnnotation } from '../bookmark-annotation-store.js';
import { pinBlockers, sortPinnedBookmarks, type PinBlocker } from '../bookmark-pin-order.js';
import type { BookmarkPreferences } from '../bookmark-preferences.js';

type Node = chrome.bookmarks.BookmarkTreeNode;
export type PinIndex = ReadonlyMap<string, BookmarkAnnotation>;

/** Every live pinned row, read once per pass. */
export async function loadPinIndex(): Promise<PinIndex> {
  const store = createBookmarkAnnotationStore();
  try { return new Map((await store.list()).filter(row => row.pinned).map(row => [row.nativeId, row])); }
  finally { store.close(); }
}

export function pinnedChildIds(children: readonly Node[], pins: PinIndex): Set<string> {
  return new Set(children.filter(child => child.url !== undefined && pins.has(child.id)
    && annotationMatchesBookmark(pins.get(child.id)!, child)).map(child => child.id));
}

export async function folderPinBlockers(folderId: string, preferences: Pick<BookmarkPreferences, 'bookmarkInsertPosition' | 'foldersFirst'>,
  excluded: ReadonlySet<string>): Promise<PinBlocker[]> {
  const [folder] = await chrome.bookmarks.get(folderId).catch(() => [] as Node[]);
  if (!folder || folder.url !== undefined) return ['folder_read_only'];
  return pinBlockers({ preferences, folder, children: await chrome.bookmarks.getChildren(folderId), excluded });
}

/**
 * Keeps pinned bookmarks right after the folders in one folder, if pinning is
 * available there on this browser. Elsewhere pins stay paused: kept and synced,
 * but nothing moves.
 */
export async function sortFolderPins(folderId: string, pins: PinIndex,
  preferences: Pick<BookmarkPreferences, 'bookmarkInsertPosition' | 'foldersFirst'>, excluded: ReadonlySet<string>,
  enabled: () => Promise<boolean>, options: { readonly last?: string; readonly onMoved?: () => void } = {}): Promise<boolean> {
  const { last } = options;
  const children = await chrome.bookmarks.getChildren(folderId);
  const pinned = pinnedChildIds(children, pins);
  if (last) pinned.add(last);
  if (pinned.size === 0 || (await folderPinBlockers(folderId, preferences, excluded)).length > 0) return true;
  return sortPinnedBookmarks(chrome.bookmarks, folderId, pinned, enabled, options.onMoved, last);
}

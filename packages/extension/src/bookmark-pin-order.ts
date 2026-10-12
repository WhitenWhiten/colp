import { classifyBookmarkApiFailure } from './bookmark-api-error.js';
import type { BookmarkPreferences } from './bookmark-preferences.js';

/**
 * Pinned bookmarks. A pin is a flag kept with the bookmark's tags and note; the
 * order stays native. In a folder where pinning is available, its children read
 * [folders][pinned bookmarks][other bookmarks], each group in its own order.
 * The flag syncs as this Node extension, exactly `{ "pinned": true }`.
 */
export const BOOKMARK_PIN_EXTENSION = 'https://known.example/extensions/bookmark-pin-v1';

type Node = Pick<chrome.bookmarks.BookmarkTreeNode, 'id' | 'url' | 'unmodifiable'> & { readonly type?: string };
type Extensions = Readonly<Record<string, unknown>>;

export function extensionsPinned(extensions: unknown): boolean {
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return false;
  const value = (extensions as Extensions)[BOOKMARK_PIN_EXTENSION];
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (value as Extensions).pinned === true;
}

/** The node's extension map with only the pin namespace changed. */
export function withPinExtension(extensions: Extensions, pinned: boolean): Record<string, unknown> {
  const { [BOOKMARK_PIN_EXTENSION]: _pin, ...rest } = extensions;
  return pinned ? { ...rest, [BOOKMARK_PIN_EXTENSION]: { pinned: true } } : rest;
}
type Api = Pick<typeof chrome.bookmarks, 'get' | 'getChildren' | 'move'>;

/** Why a folder cannot take new pins on this browser. Empty means pinning is available. */
export type PinBlocker = 'insert_bottom' | 'folders_first_off' | 'folder_unorganized' | 'folder_read_only';

export function pinPreferenceBlockers(preferences: Pick<BookmarkPreferences, 'bookmarkInsertPosition' | 'foldersFirst'>): PinBlocker[] {
  return [
    ...(preferences.bookmarkInsertPosition === 'top' ? [] : ['insert_bottom' as const]),
    ...(preferences.foldersFirst ? [] : ['folders_first_off' as const]),
  ];
}

/**
 * Organized: no folder follows a bookmark, and every bookmark can move. A
 * read-only, subscription or separator item among the bookmarks would anchor
 * the order the way it anchors the folders-first sorter.
 */
export function isOrganizedFolder(children: readonly Node[], excluded: ReadonlySet<string>): boolean {
  let bookmarkSeen = false;
  for (const child of children) {
    if (child.url === undefined && child.type !== 'separator') {
      if (bookmarkSeen) return false;
      continue;
    }
    const fixed = Boolean(child.unmodifiable) || excluded.has(child.id) || child.type === 'separator';
    if (fixed && (bookmarkSeen || child.url !== undefined)) return false;
    bookmarkSeen ||= child.url !== undefined;
  }
  return true;
}

export function pinBlockers(input: {
  readonly preferences: Pick<BookmarkPreferences, 'bookmarkInsertPosition' | 'foldersFirst'>;
  readonly folder: (Pick<chrome.bookmarks.BookmarkTreeNode, 'id' | 'parentId' | 'unmodifiable'>) | undefined;
  readonly children: readonly Node[];
  readonly excluded: ReadonlySet<string>;
}): PinBlocker[] {
  const { folder } = input;
  if (!folder || !folder.parentId || folder.unmodifiable || input.excluded.has(folder.id)) return ['folder_read_only'];
  return [...pinPreferenceBlockers(input.preferences),
    ...(isOrganizedFolder(input.children, input.excluded) ? [] : ['folder_unorganized' as const])];
}

/** Where the unpinned section starts: after the folders and the pinned bookmarks that lead the bookmark run. */
export function unpinnedTopIndex(children: readonly Node[], pinned: ReadonlySet<string>): number {
  let index = children.findIndex(child => child.url !== undefined);
  if (index < 0) return children.length;
  while (index < children.length && children[index]!.url !== undefined && pinned.has(children[index]!.id)) index += 1;
  return index;
}

/**
 * Upward moves that bring every pinned bookmark directly after the folders,
 * keeping pinned and unpinned bookmarks in their relative order. Each move goes
 * up, so Chromium's same-parent index adjustment never applies.
 */
export function planPinnedMoves(children: readonly Node[], pinned: ReadonlySet<string>): { readonly id: string; readonly index: number }[] {
  const order = children.map(child => child.id);
  const kinds = new Map(children.map(child => [child.id, child.url !== undefined]));
  let next = order.findIndex(id => kinds.get(id));
  if (next < 0) return [];
  const moves: { id: string; index: number }[] = [];
  for (let index = next; index < order.length; index += 1) {
    const id = order[index]!;
    if (!kinds.get(id) || !pinned.has(id)) continue;
    if (index !== next) {
      moves.push({ id, index: next });
      order.splice(index, 1);
      order.splice(next, 0, id);
    }
    next += 1;
  }
  return moves;
}

/**
 * After a pin, the newly pinned bookmark belongs at the end of the pinned
 * section. One upward move per call brings the next pinned bookmark below it
 * up in front of it; repeat until the plan is empty.
 */
export function planPinAppend(children: readonly Node[], pinned: ReadonlySet<string>, id: string): { readonly id: string; readonly index: number }[] {
  const start = children.findIndex(child => child.url !== undefined);
  if (start < 0) return [];
  let end = start;
  while (end < children.length && children[end]!.url !== undefined && pinned.has(children[end]!.id)) end += 1;
  const at = children.findIndex(child => child.id === id);
  return at >= start && at < end - 1 ? [{ id: children[at + 1]!.id, index: at }] : [];
}

/**
 * Applies {@link planPinnedMoves} against live children, one move at a time, then
 * {@link planPinAppend} for `last`. A bookmark that left the folder stops the pass;
 * the next pass starts from the new order.
 */
export async function sortPinnedBookmarks(api: Api, parentId: string, pinned: ReadonlySet<string>,
  enabled: () => Promise<boolean>, onMoved: () => void = () => undefined, last?: string): Promise<boolean> {
  try {
    if (pinned.size === 0) return true;
    // Bringing the pins up takes at most one move per pinned bookmark, and moving `last` to the end of
    // the pinned section at most one more per pin, so twice the children always suffices.
    for (let guard = 2 * (await api.getChildren(parentId)).length; guard >= 0; guard -= 1) {
      const children = await api.getChildren(parentId);
      const [move] = planPinnedMoves(children, pinned).concat(last ? planPinAppend(children, pinned, last) : []);
      if (!move) return true;
      if (!await enabled()) return false;
      const live = (await api.get(move.id))[0];
      if (!live || live.parentId !== parentId) return false;
      await api.move(move.id, { parentId, index: move.index });
      onMoved();
    }
    return false;
  } catch (error) {
    if (classifyBookmarkApiFailure(error) !== 'not_found') throw error;
    return false;
  }
}

import type { BookmarkInsertPosition } from './bookmark-preferences.js';
import { isSupportedBookmarkRoot } from './bookmark-folder-policy.js';
import { unpinnedTopIndex } from './bookmark-pin-order.js';

export type { BookmarkInsertPosition } from './bookmark-preferences.js';

export interface BookmarkPlacementApi {
  getChildren(parentId: string): Promise<readonly { readonly id: string; readonly url?: string }[]>;
}

export interface BookmarkRootApi {
  getTree(): Promise<readonly {
    readonly id: string;
    readonly children?: readonly { readonly id: string; readonly url?: string;
      readonly folderType?: string; readonly unmodifiable?: string }[];
  }[]>;
}

/** Chromium omits parentId by placing bookmarks in the second native root. */
export async function resolveDefaultBookmarkParent(api: BookmarkRootApi): Promise<string> {
  const roots = await api.getTree();
  const children = roots[0]?.children?.filter((node) => !node.unmodifiable && isSupportedBookmarkRoot(node)) ?? [];
  const parent = children.find((node) => node.id === '2') ?? children.find((node) => node.folderType === 'other') ?? children[1];
  if (!parent) throw new Error('bookmark_default_parent_unavailable');
  return parent.id;
}

/**
 * Resolve one batch against the native sibling list once, then advance only
 * after a successful create. This preserves input order for top insertion:
 * [N1, N2] is created at indexes 0 and 1, never twice at index 0.
 */
export async function mapBookmarksAtPosition<Item, Result>(input: {
  readonly items: readonly Item[];
  readonly parentId: string;
  readonly position: BookmarkInsertPosition;
  readonly api: BookmarkPlacementApi;
  readonly resumeNativeIds?: readonly string[];
  /** With folders first, top is the start of the unpinned bookmarks; otherwise the very first child. */
  readonly afterPinned?: ReadonlySet<string>;
  readonly create: (item: Item, index: number) => Promise<Result>;
}): Promise<readonly Result[]> {
  const children = await input.api.getChildren(input.parentId);
  let index = input.position === 'bottom' ? children.length
    : input.afterPinned ? unpinnedTopIndex(children, input.afterPinned) : 0;
  if (input.resumeNativeIds?.length) {
    const positions = new Map(children.map((node, childIndex) => [node.id, childIndex]));
    let predecessorIndex = -1;
    for (const nativeId of input.resumeNativeIds) {
      const currentIndex = positions.get(nativeId);
      if (currentIndex === undefined || currentIndex <= predecessorIndex) {
        throw new Error('bookmark_resume_placement_unproven');
      }
      predecessorIndex = currentIndex;
    }
    index = predecessorIndex + 1;
  }
  const results: Result[] = [];
  for (const item of input.items) {
    const result = await input.create(item, index);
    results.push(result);
    index += 1;
  }
  return results;
}

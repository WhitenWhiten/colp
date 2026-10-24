import { withSubscriptionRead } from './bookmark-subscriptions/barrier.js';
import { assertPersonalNativeAllowed } from './bookmark-subscriptions/guards.js';
import { saveBookmarkWithFaviconCapture, type SaveBookmarkCaptureInput } from './favicon-save.js';
import {
  mapBookmarksAtPosition,
  type BookmarkInsertPosition,
} from './bookmark-placement.js';
import type { createFaviconSidecarStore } from './favicon-sidecar-store.js';
import { createBookmarkCreatePlacementStore } from './bookmark-create-placement.js';
import { t } from './i18n.js';
import { annotationMatchesBookmark, createBookmarkAnnotationStore } from './bookmark-annotation-store.js';

/** Every popup, shortcut, context-menu and window-tab save creates a native bookmark. KNS-04 ingress watches onCreated. */
export const NATIVE_SAVE_INGRESS = 'chrome.bookmarks.create';

export interface NativeSavePage {
  readonly title: string;
  readonly url: string;
  readonly favIconUrl?: string;
}

export interface NativeSaveResult {
  readonly nativeId: string;
  readonly captured: boolean;
  readonly parentId?: string;
}

export async function savePagesThroughNativeIngress(input: {
  readonly pages: readonly NativeSavePage[];
  readonly parentNativeId?: string;
  readonly insertPosition?: BookmarkInsertPosition;
  /** Confirmed prefix identities; resolve their current native positions on resume. */
  readonly resumeNativeIds?: readonly string[];
  readonly collectionId?: string;
  readonly bookmarks: SaveBookmarkCaptureInput['bookmarks'];
  readonly placementStore?: ReturnType<typeof createBookmarkCreatePlacementStore>;
  readonly placementRandomUUID?: () => string;
  readonly placementBatch?: {
    readonly id: string;
    readonly orderOffset: number;
    readonly totalSize: number;
  };
  readonly onPlacementReserved?: (record: import('./bookmark-create-placement.js').BookmarkCreatePlacementRecord) => Promise<void>;
  readonly onNativeCreated?: (node: { readonly id: string; readonly dateAdded?: number }) => Promise<void>;
  /** Folders first: a top save goes after the folders and the pinned bookmarks. */
  readonly foldersFirst?: boolean;
  readonly sidecar: ReturnType<typeof createFaviconSidecarStore>;
  readonly fetch?: typeof fetch; readonly randomUUID?: () => string; readonly now?: () => number;
}): Promise<readonly NativeSaveResult[]> {
  const placementParent = input.parentNativeId;
  if (!placementParent) throw new Error('folder_required');
  const placementStore = input.insertPosition && (input.collectionId || input.placementStore)
    ? input.placementStore ?? createBookmarkCreatePlacementStore()
    : undefined;
  const placementUuid = input.placementRandomUUID ?? (() => crypto.randomUUID());
  const batchId = placementStore ? input.placementBatch?.id ?? placementUuid().toLowerCase() : undefined;
  let batchOrder = input.placementBatch?.orderOffset ?? 0;
  const batchSize = input.placementBatch?.totalSize ?? input.pages.length;
  const save = async (page: NativeSavePage, index?: number) => {
    await assertPersonalNativeAllowed(placementParent);
    const order = batchOrder;
    batchOrder += 1;
    const reservation = placementStore && batchId && input.insertPosition && placementParent && index !== undefined
      ? await placementStore.reserve({
        mode: input.insertPosition, targetParentNativeId: placementParent,
        ...(input.collectionId ? { collectionId: input.collectionId } : {}), batchId, batchOrder: order, batchSize,
        title: page.title, url: page.url, expectedIndex: index,
      })
      : undefined;
    if (reservation) await input.onPlacementReserved?.(reservation);
    return saveBookmarkWithFaviconCapture({
      title: page.title, url: page.url, favIconUrl: page.favIconUrl ?? '',
      privateLocal: false, parentNativeId: placementParent, collectionId: input.collectionId,
      bookmarks: {...input.bookmarks,create: nativeInput=>withSubscriptionRead(async()=>{await assertPersonalNativeAllowed(nativeInput.parentId);return input.bookmarks.create(nativeInput);})}, sidecar: input.sidecar,
      ...(index === undefined ? {} : { index }),
      onNativeCreated: async (node: { readonly id: string; readonly dateAdded?: number }) => {
        if (reservation) await placementStore!.bind(reservation.intentId, node.id, node.dateAdded);
        await input.onNativeCreated?.(node);
      },
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.randomUUID ? { randomUUID: input.randomUUID } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  };
  if (input.insertPosition && placementParent) {
    const getChildren = input.bookmarks.getChildren;
    if (typeof getChildren !== 'function') throw new Error('bookmark_children_unavailable');
    const afterPinned = input.insertPosition === 'top' && input.foldersFirst
      ? await pinnedIdsIn(await getChildren.call(input.bookmarks, placementParent)) : undefined;
    return mapBookmarksAtPosition({
      items: input.pages,
      parentId: placementParent,
      position: input.insertPosition,
      ...(afterPinned ? { afterPinned } : {}),
      api: { getChildren: (parentId) => getChildren.call(input.bookmarks, parentId) },
      ...(input.resumeNativeIds === undefined ? {} : { resumeNativeIds: input.resumeNativeIds }),
      create: save,
    });
  }
  const saved: NativeSaveResult[] = [];
  for (const page of input.pages) saved.push(await save(page));
  return saved;
}

export function httpTabs(tabs: readonly { readonly title?: string; readonly url?: string; readonly favIconUrl?: string }[]):
  NativeSavePage[] {
  const pages: NativeSavePage[] = [];
  for (const tab of tabs) {
    if (typeof tab.url !== 'string' || !/^https?:/u.test(tab.url)) continue;
    pages.push({
      title: typeof tab.title === 'string' && tab.title ? tab.title : t('common_untitledPage', 'Untitled page'),
      url: tab.url,
      ...(typeof tab.favIconUrl === 'string' ? { favIconUrl: tab.favIconUrl } : {}),
    });
  }
  return pages;
}

/** Pinned bookmarks among these siblings. An unreadable store means none: the save still goes to the top. */
async function pinnedIdsIn(children: readonly { readonly id: string; readonly url?: string; readonly dateAdded?: number }[]): Promise<Set<string>> {
  const bookmarks = children.filter(child => child.url !== undefined);
  if (bookmarks.length === 0) return new Set();
  let store: ReturnType<typeof createBookmarkAnnotationStore> | undefined;
  try {
    store = createBookmarkAnnotationStore();
    const rows = await store.getMany(bookmarks);
    return new Set(bookmarks.filter(child => rows.get(child.id)?.pinned && annotationMatchesBookmark(rows.get(child.id)!, child)).map(child => child.id));
  } catch { return new Set(); }
  finally { store?.close(); }
}

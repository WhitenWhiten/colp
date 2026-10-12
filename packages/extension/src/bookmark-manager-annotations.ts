import { saveAnnotation } from './popup-annotations.js';
import { createBookmarkAnnotationStore, type BookmarkAnnotation, type BookmarkAnnotationStore } from './bookmark-annotation-store.js';
import type { NativeNode } from './bookmark-manager-dom.js';

export type ManagerAnnotationStore = Pick<BookmarkAnnotationStore, 'getMany' | 'list' | 'save' | 'search' | 'close'> & Partial<Pick<BookmarkAnnotationStore, 'resolveNoteConflict'>>;

/**
 * Tags and notes for the manager's rows. They live in the profile-local
 * annotation store, so every call works without an account and a failing store
 * only means "no tags": the list itself must always render.
 */
export function createManagerAnnotations(open: () => ManagerAnnotationStore = createBookmarkAnnotationStore) {
  let store: ManagerAnnotationStore | undefined;
  const use = (): ManagerAnnotationStore => (store ??= open());
  return {
    /** Annotations of the bookmarks among `nodes`, by native id. */
    async load(nodes: readonly NativeNode[]): Promise<ReadonlyMap<string, BookmarkAnnotation>> {
      const bookmarks = nodes.filter((node) => node.url !== undefined);
      if (bookmarks.length === 0) return new Map();
      try { return await use().getMany(bookmarks.map((node) => ({ id: node.id, url: node.url!, ...(node.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }) }))); }
      catch { return new Map(); }
    },
    /** Every stored row, for the tag list and tag filter. */
    async all(): Promise<readonly BookmarkAnnotation[]> {
      try { return await use().list(); } catch { return []; }
    },
    /** Native ids whose tags or note contain the query. */
    async search(query: string): Promise<readonly string[]> {
      try { return await use().search(query); } catch { return []; }
    },
    async save(node: NativeNode, annotation: { readonly tags: readonly string[]; readonly note: string | null },
      base?: { readonly tags: readonly string[]; readonly note: string | null }): Promise<boolean | null> {
      try {
        const reference = { id: node.id, ...(node.url === undefined ? {} : { url: node.url }), ...(node.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }) };
        const storage = use();
        return saveAnnotation(reference, { ...annotation, note: annotation.note ?? '' }, base ? { ...base, note: base.note ?? '' } : undefined,
          { get: async bookmark => (await storage.getMany([bookmark])).get(bookmark.id) ?? null, save: storage.save,
            resolveNoteConflict: storage.resolveNoteConflict, tagCounts: async () => [], close: () => undefined });
      } catch { return false; }
    },
    close() { store?.close(); store = undefined; },
  };
}
export type ManagerAnnotations = ReturnType<typeof createManagerAnnotations>;

import {
  COLLECTIONS_CACHE, forgetCollectionBindingIfAbsent, parseCollectionsCache, selectPrivateBookmarkLibraries,
} from './collections-cache.js';
import { isProtocolOpaqueId } from './protocol-id.js';
import type { PublicCollectionChoice } from './types.js';

export const COLLECTION_BINDING = 'known.sync.collection.v1';

export interface BoundCollection { readonly id: string; readonly title: string }

/**
 * The popup never chooses a collection: `known.collection.select` rebinds the
 * whole extension's sync scope, so the choice lives in Options › Sync. The
 * popup reads the explicitly bound library. An unbound account saves to this
 * browser, even when it owns exactly one library; connecting sync is a separate action.
 */
export function resolveBoundCollection(
  libraries: readonly PublicCollectionChoice[], stored: unknown,
): BoundCollection | undefined {
  if (isProtocolOpaqueId(stored)) {
    return { id: stored, title: libraries.find((item) => item.id === stored)?.title ?? '' };
  }
  return undefined;
}

export function createBoundCollection(): {
  current(): BoundCollection | undefined;
  /** False until a cached or live library list has been read. */
  known(): boolean;
  libraryCount(): number;
  fromCache(cached: Record<string, unknown>, accountLabel?: string): void;
  refresh(): Promise<void>;
} {
  let libraries: readonly PublicCollectionChoice[] = [];
  let bound: BoundCollection | undefined;
  let known = false;
  return {
    current: () => bound,
    known: () => known,
    libraryCount: () => libraries.length,
    fromCache(cached, accountLabel) {
      const parsed = parseCollectionsCache(cached[COLLECTIONS_CACHE], accountLabel ? { accountLabel } : undefined);
      known = parsed !== undefined;
      libraries = selectPrivateBookmarkLibraries(parsed ?? []);
      const stored = cached[COLLECTION_BINDING];
      // A parsed list is a previous successful read. An id it no longer contains
      // is not a private sync target. No list at all keeps the stored id for offline.
      bound = known && isProtocolOpaqueId(stored) && !libraries.some((item) => item.id === stored)
        ? undefined
        : resolveBoundCollection(libraries, stored);
    },
    async refresh() {
      try {
        const response = await chrome.runtime.sendMessage({ kind: 'known.collections.list' }) as
          { readonly ok: true; readonly collections: readonly PublicCollectionChoice[] } | { readonly ok: false } | undefined;
        if (!response?.ok) return;
        libraries = selectPrivateBookmarkLibraries(response.collections);
        known = true;
        await forgetCollectionBindingIfAbsent(libraries);
        bound = resolveBoundCollection(libraries, (await chrome.storage.local.get(COLLECTION_BINDING))[COLLECTION_BINDING]);
      } catch { /* The cached answer stands; the worker reconciles on the next open. */ }
    },
  };
}

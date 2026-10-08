export interface CollectionBookmarkCountReadPort {
  countBookmarks(collectionIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export interface CollectionBookmarkCountLookupEntry {
  readonly collectionId: string;
  readonly contentRevision: string;
}

/**
 * List-page COUNT lookup addressed by `(collectionId, contentRevision)`.
 * Off-mode adapters ignore revision and issue one origin `countBookmarks`.
 */
export interface CollectionBookmarkCountLookupPort {
  lookupBookmarkCounts(
    entries: readonly CollectionBookmarkCountLookupEntry[],
  ): Promise<ReadonlyMap<string, number>>;
}

export type CollectionListBookmarkCountsPort =
  | CollectionBookmarkCountLookupPort
  | CollectionBookmarkCountReadPort;

/** Map-missing collection ids are empty Collections, not omitted fields. */
export function bookmarkCountFor(
  counts: ReadonlyMap<string, number>,
  collectionId: string,
): number {
  return counts.get(collectionId) ?? 0;
}

/** Off-mode adapter: ignore `contentRevision` and issue one GROUP BY COUNT. */
export function asCollectionBookmarkCountLookup(
  origin: CollectionBookmarkCountReadPort,
): CollectionBookmarkCountLookupPort {
  return {
    async lookupBookmarkCounts(entries) {
      if (entries.length === 0) return new Map();
      return origin.countBookmarks(entries.map((entry) => entry.collectionId));
    },
  };
}

/**
 * Prefer the revision-addressed lookup when present so cache keys work; fall
 * back to origin `countBookmarks(ids)` for explicit fake origins that do not
 * implement lookup (memory HTTP harnesses).
 */
export function lookupCollectionBookmarkCounts(
  port: CollectionListBookmarkCountsPort,
  items: ReadonlyArray<{ readonly id: string; readonly contentRevision: string }>,
): Promise<ReadonlyMap<string, number>> {
  const entries = items.map((item) => ({
    collectionId: item.id,
    contentRevision: item.contentRevision,
  }));
  if (isBookmarkCountLookupPort(port)) {
    return port.lookupBookmarkCounts(entries);
  }
  if (entries.length === 0) return Promise.resolve(new Map());
  return port.countBookmarks(entries.map((entry) => entry.collectionId));
}

function isBookmarkCountLookupPort(
  port: CollectionListBookmarkCountsPort,
): port is CollectionBookmarkCountLookupPort {
  return typeof (port as CollectionBookmarkCountLookupPort).lookupBookmarkCounts === 'function';
}

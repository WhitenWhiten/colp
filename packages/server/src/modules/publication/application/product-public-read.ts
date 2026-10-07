export const PRODUCT_PUBLIC_COLLECTION_SLUG_MIN_LENGTH = 3;
export const PRODUCT_PUBLIC_COLLECTION_SLUG_MAX_LENGTH = 263;

export interface ProductPublicCollectionLocatorReadPort {
  /**
   * Looks up a database-canonical lowercase publication slug in the 3..263
   * character range. Slug-only: callers must not fall back to Collection
   * OpaqueId / UUID lookup for GET /api/v1/collections/{collectionId}.
   */
  findCollectionIdBySlug(slug: string): Promise<string | null>;
}

export interface ProductPublicCollectionViewCountReadPort {
  /**
   * SUM of windowed `publication_insight_daily` `collection_view` rows for an
   * already-resolved collection UUID. No daily rows → 0. Callers must not look
   * up by publication slug here.
   */
  sumCollectionViews(collectionId: string): Promise<number>;
}

export function isCanonicalProductPublicCollectionSlug(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{1,261}[a-z0-9])$/u.test(value);
}

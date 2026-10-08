export const EXPLORE_PAGE_SORTS = ['updated', 'popular', 'links'] as const;
export type ExplorePageSort = (typeof EXPLORE_PAGE_SORTS)[number];

/**
 * Catalog rows one personal Explore request may read before it must resume.
 * Budget exhaustion is not the end of the directory.
 */
export const EXPLORE_PREFERENCE_SCAN_ROW_BUDGET = 256;

/** A popular Explore request builds the 30-day view aggregate at most once. */
export const EXPLORE_POPULAR_AGGREGATIONS_PER_REQUEST = 1;

export interface ExplorePageFilter {
  readonly q?: string;
  readonly tag?: string;
  readonly language?: string;
}

/** Personal mute applied to one bounded Explore keyset window. */
export interface ExploreCatalogPreference {
  readonly hiddenOwnerAccountIds: readonly string[];
  readonly hiddenTags: readonly string[];
  readonly hiddenTitleKeywords: readonly string[];
  readonly preferredLanguages: readonly string[];
}

export interface ExplorePagePosition {
  readonly micros: string;
  readonly id: string;
  readonly viewCount?: number;
  /** Links sort key. This is raw live_node_count, not the displayed node count. */
  readonly nodeCount?: number;
}

export interface ExplorePageReadRequest {
  readonly filter: ExplorePageFilter;
  readonly sort: ExplorePageSort;
  readonly limit: number;
  readonly after?: ExplorePagePosition;
  readonly signal?: AbortSignal;
  /**
   * When catalogPreference is set, the statement reads this many catalog rows
   * plus one probe. It does not replace `limit` as the returned page size.
   */
  readonly scanBudget?: number;
  readonly catalogPreference?: ExploreCatalogPreference;
}

export interface ExplorePageRecord {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: 'bookmarks' | 'reading_path' | 'knowledge_collection' | 'mixed';
  readonly visibility: 'public';
  readonly publicationSlug: string;
  readonly tags: readonly string[];
  readonly language: string | null;
  readonly ownerAccountId?: string;
  /** Displayed public node count. Not the links sort key. */
  readonly nodeCount: number;
  /** Raw live_node_count. Links SQL, resume cursor, and output cursor use this. */
  readonly orderingNodeCount: number;
  /**
   * Set when a personal preference window was read. True means the row is
   * inside the scan but must not be returned as a card.
   */
  readonly preferenceHidden?: boolean;
  readonly viewCount: number;
  readonly updatedAt: string;
  readonly orderingUpdatedAtMicros: string;
  /** #21: an official hide_public is in force; the route tombstones the card. */
  readonly hiddenPublic: boolean;
}

export interface ExplorePageReadPort {
  loadPage(request: ExplorePageReadRequest): Promise<readonly ExplorePageRecord[]>;
}

export function isExplorePageSort(value: string): value is ExplorePageSort {
  return (EXPLORE_PAGE_SORTS as readonly string[]).includes(value);
}

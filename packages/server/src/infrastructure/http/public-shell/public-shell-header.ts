export interface PublicShellCollectionHeader {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'public' | 'unlisted' | 'private' | 'protected';
  readonly ownerSubjectId: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly publicationSlug: string | null;
  readonly rootAvailable: boolean;
  readonly language: string | null;
}

export type PublicShellVisibilityOutcome =
  | { readonly kind: 'inject'; readonly visibility: 'public' | 'unlisted' }
  | { readonly kind: 'generic-404' };

/**
 * Search-indexable ⇔ `visibility === 'public'`.
 * T-10 still injects unlisted HTML but adds noindex; sitemaps must omit those rows.
 * Shared by `injectPublicCollectionShell` (noindex) and the collections sitemap query.
 */
export const SEARCH_INDEXABLE_VISIBILITY = 'public' as const;

export function isSearchIndexableVisibility(
  visibility: string,
): visibility is typeof SEARCH_INDEXABLE_VISIBILITY {
  return visibility === SEARCH_INDEXABLE_VISIBILITY;
}

/**
 * HTML crawler matrix: public → 200; unlisted → 200 + noindex;
 * unknown / private / protected / withdrawn / gone → 404 + generic shell.
 */
export function decidePublicShellVisibility(header: PublicShellCollectionHeader | null): PublicShellVisibilityOutcome {
  if (header === null) return { kind: 'generic-404' };
  if (header.publicationSlug === null) return { kind: 'generic-404' };
  if (header.deletedAt !== null) return { kind: 'generic-404' };
  if (!header.rootAvailable) return { kind: 'generic-404' };
  if (header.visibility === 'public' || header.visibility === 'unlisted') {
    return { kind: 'inject', visibility: header.visibility };
  }
  return { kind: 'generic-404' };
}

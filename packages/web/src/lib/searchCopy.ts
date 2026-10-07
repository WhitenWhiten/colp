/** Site-wide search (topnav, ⌘K, /search). */
export const SITE_SEARCH_PLACEHOLDER = 'Search Know-N…'

/** Product Search heading. PRODUCT.md: library, not workspace. */
export const SEARCH_PAGE_TITLE = 'Search Know-N'

/** Library and public collection bookmark filters share this copy. */
export const BOOKMARK_FILTER_PLACEHOLDER = 'Filter by title, description, host, or folder…'

/** API `node` is a bookmark in user-visible search copy. */
export function searchKindLabel(apiKind: string): string {
  return apiKind === 'node' ? 'bookmark' : apiKind
}

/** Kind pill copy: the same word, sentence-cased for a label that stands alone. */
export function searchKindTitle(apiKind: string): string {
  const label = searchKindLabel(apiKind)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

const ANNOTATION_KIND_TITLE: Record<string, string> = {
  note: 'Note', summary: 'Summary', tldr: 'TL;DR', highlight: 'Highlight', rating: 'Rating',
}

/** Annotation hits name their annotation type in the kind chip
    ("Highlight"), not the generic "Annotation". */
export function annotationKindTitle(annotationType: string): string {
  return ANNOTATION_KIND_TITLE[annotationType] ?? 'Annotation'
}

import type { SearchResult } from '../api/types'

/** Site-wide search (topnav, ⌘K, /search). */
export const SITE_SEARCH_PLACEHOLDER = 'Search your library…'

/** Product Search heading. PRODUCT.md: library, not workspace. */
export const SEARCH_PAGE_TITLE = 'Search'

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

/** Kind chip for a hit. Servers from API 1.93.0 send `nodeKind`. For an
    older server the Search page passes the kind from the tree, and failing
    that a node with no web host is taken to be a folder. */
export function searchResultKindTitle(result: SearchResult, nodeKind?: 'folder' | 'bookmark' | null): string {
  if (result.resourceType === 'annotation') return annotationKindTitle(result.annotationType)
  if (result.resourceType === 'node') {
    const kind = result.nodeKind ?? nodeKind ?? (result.urlHost ? 'bookmark' : 'folder')
    return kind === 'folder' ? 'Folder' : kind === 'separator' ? 'Separator' : 'Bookmark'
  }
  return searchKindTitle(result.resourceType)
}

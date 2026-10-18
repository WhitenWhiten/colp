import type { ReactNode } from 'react'
import type { SearchResult } from '../api/types'
import { cleanSnippet, highlightQuery } from '../lib/searchHighlight'
import { rootTitle } from '../lib/libraryTree'
import { searchKindLabel, searchResultKindTitle } from '../lib/searchCopy'
import { searchResultTitle } from '../lib/useProductSearch'
import { useIsClamped } from '../lib/useIsClamped'

/** Optional trailing meta for the full-page search column (palette keeps its own chrome). */
export function searchResultMeta(result: SearchResult): string {
  if (result.resourceType === 'node') return result.urlHost ?? ''
  if (result.resourceType === 'annotation') return `On a ${searchKindLabel(result.subject.type)}`
  return ''
}

type Props = {
  result: SearchResult
  query: string
  meta?: ReactNode
  /** The node's real kind when the host knows it (the Search page does). */
  nodeKind?: 'folder' | 'bookmark' | null
  /** The account's library: its root hit reads All bookmarks, not the stored title. */
  libraryId?: string | null
}

/**
 * Shared search hit content (R10-01): one .result-row anatomy — kind chip,
 * copy column (highlighted title + snippet) and an optional meta slot.
 * Hosts keep their own chrome (`Link.search-product-result` vs
 * `button.search-result`) and may only restyle column sizing — the DOM and
 * class structure never fork.
 */
export function SearchResultRow({ result, query, meta, nodeKind, libraryId }: Props) {
  const libraryRoot = result.resourceType === 'collection' && libraryId != null && result.resourceId === libraryId
  const title = libraryRoot ? rootTitle({ title: result.title, library: true }) : searchResultTitle(result)
  // The root's snippet only repeats its stored title.
  const cleaned = libraryRoot ? '' : cleanSnippet(title, result.snippet)
  const highlightedTitle = highlightQuery(title, query)
  const [titleRef, titleClamped] = useIsClamped<HTMLElement>(title)

  return (
    <>
      <span className="chip chip--kind" data-testid="search-result-kind">{libraryRoot ? 'Library' : searchResultKindTitle(result, nodeKind)}</span>
      <span className="result-row-copy">
        <strong ref={titleRef} className="result-row-title" dir="auto" title={titleClamped ? title : undefined}>{highlightedTitle}</strong>
        {cleaned ? (
          <span className="search-snippet" data-search-snippet dir="auto">
            {highlightQuery(cleaned, query)}
          </span>
        ) : null}
      </span>
      {meta != null && meta !== '' ? (
        <span className="result-row-meta meta-row" dir="auto" data-testid="search-result-meta">{meta}</span>
      ) : null}
    </>
  )
}

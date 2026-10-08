import type { ReactNode } from 'react'
import type { SearchResult } from '../api/types'
import { cleanSnippet, highlightQuery } from '../lib/searchHighlight'
import { annotationKindTitle, searchKindLabel, searchKindTitle } from '../lib/searchCopy'
import { searchResultTitle } from '../lib/useProductSearch'
import { useIsClamped } from '../lib/useIsClamped'

/** Optional trailing meta for the full-page search column (palette keeps its own chrome). */
export function searchResultMeta(result: SearchResult): string {
  if (result.resourceType === 'profile') return `@${result.handle}`
  if (result.resourceType === 'node') return result.urlHost ?? ''
  if (result.resourceType === 'annotation') return `On a ${searchKindLabel(result.subject.type)}`
  return ''
}

type Props = {
  result: SearchResult
  query: string
  meta?: ReactNode
}

/**
 * Shared search hit content (R10-01): one .result-row anatomy — kind chip,
 * copy column (highlighted title + snippet) and an optional meta slot.
 * Hosts keep their own chrome (`Link.search-product-result` vs
 * `button.search-result`) and may only restyle column sizing — the DOM and
 * class structure never fork.
 */
export function SearchResultRow({ result, query, meta }: Props) {
  const title = searchResultTitle(result)
  const cleaned = cleanSnippet(title, result.snippet)
  const highlightedTitle = highlightQuery(title, query)
  const [titleRef, titleClamped] = useIsClamped<HTMLElement>(title)

  return (
    <>
      <span className="chip chip--kind" data-testid="search-result-kind">{result.resourceType === 'annotation' ? annotationKindTitle(result.annotationType) : searchKindTitle(result.resourceType)}</span>
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

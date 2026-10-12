import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { SearchResourceType, SearchResult } from '../api/types'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { Icon } from '../components/Icon'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { SearchResultRow } from '../components/SearchResultRow'
import { SEARCH_PAGE_TITLE, SITE_SEARCH_PLACEHOLDER, searchKindLabel } from '../lib/searchCopy'
import { useSearchKeyboard } from '../lib/useSearchKeyboard'
import { searchResultHref, useProductSearch } from '../lib/useProductSearch'
import { productName } from '../lib/edition'
import { plural } from '../lib/plural'
import { compactTrail, useSearchPlaces, type SearchPlace } from './search/places'

const filters: { label: string; value?: SearchResourceType }[] = [
  { label: 'All' }, { label: 'Collections', value: 'collection' }, { label: 'Bookmarks', value: 'node' },
  { label: 'Annotations', value: 'annotation' },
]

/* A folder hit opens the folder on the desk; the resource page is for
   bookmarks. */
function placeHref(result: SearchResult, place: SearchPlace | null): string {
  if (result.resourceType === 'node' && place?.kind === 'folder') {
    return `/library/${encodeURIComponent(result.collectionId)}?folder=${encodeURIComponent(result.resourceId)}`
  }
  return searchResultHref(result)
}

/* linkding's quiet line: host, then where the hit lives. */
function placeMeta(result: SearchResult, place: SearchPlace | null) {
  const parts: { key: string; text: string; className?: string }[] = []
  if (result.resourceType === 'node' && result.urlHost) parts.push({ key: 'host', text: result.urlHost, className: 'search-host' })
  if (result.resourceType === 'annotation') {
    parts.push({ key: 'subject', text: place?.subjectTitle ? `On ${place.subjectTitle}` : `On a ${searchKindLabel(result.subject.type)}` })
  }
  if (place && place.trail.length > 0) {
    parts.push({ key: 'trail', text: compactTrail(place.trail).join(' › '), className: 'search-place' })
  }
  if (parts.length === 0) return undefined
  return <>{parts.map((part) => <span key={part.key} className={part.className}>{part.text}</span>)}</>
}

export function Search() {
  const [params, setParams] = useSearchParams()
  const initialQuery = params.get('q') ?? ''
  const [draft, setDraft] = useState(initialQuery)
  const [query, setQuery] = useState(initialQuery)
  // The type filter lives in the URL (?types=…) so reload/share restores it.
  const typesParam = params.get('types')
  const filter = filters.find((item) => item.value && item.value === typesParam)?.value
  const [retryRemaining, setRetryRemaining] = useState(0)
  const navigate = useNavigate()
  const search = useProductSearch({ query, types: filter ? [filter] : undefined, limit: 20 })
  const placeOf = useSearchPlaces(search.items)

  /* R10-21: same combobox/listbox keyboard model as the ⌘K palette — the
     input keeps focus, arrows move aria-activedescendant, Enter opens. */
  const kb = useSearchKeyboard({
    itemCount: search.items.length,
    listId: 'search-page-results',
    resetKey: `${query}:${filter ?? ''}`,
    onOpen: (index) => {
      const result = search.items[index]
      if (result) navigate(placeHref(result, placeOf(result)))
    },
  })

  useEffect(() => {
    const seconds = search.error?.retryAfterSeconds ?? 0
    setRetryRemaining(seconds)
    if (!seconds) return
    const timer = window.setInterval(() => setRetryRemaining((value) => Math.max(0, value - 1)), 1_000)
    return () => window.clearInterval(timer)
  }, [search.error])

  /* Load-more moves the keyboard cursor to the first appended row (focus
     itself stays in the field — aria-activedescendant). */
  useEffect(() => {
    if (!search.appendedResultId) return
    const index = search.items.findIndex((item) => item.resourceId === search.appendedResultId)
    if (index >= 0) kb.setActive(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- appendedResultId is the signal
  }, [search.appendedResultId])

  /* R7-11: the page searches as you type (useProductSearch debounces 300ms),
     matching the ⌘K palette instead of demanding an explicit submit. */
  const applyQuery = (raw: string) => {
    setDraft(raw)
    const next = raw.trim()
    setQuery(next)
    setParams((current) => {
      const merged = new URLSearchParams(current)
      if (next) merged.set('q', next)
      else merged.delete('q')
      return merged
    }, { replace: true })
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    applyQuery(draft)
  }

  const setFilter = (value?: SearchResourceType) => {
    setParams((current) => {
      const merged = new URLSearchParams(current)
      if (value) merged.set('types', value)
      else merged.delete('types')
      return merged
    }, { replace: true })
  }

  return (
    <PageShell className="search-product-page" data-testid="search-workspace">
      <header className="search-product-header">
        <PageHead
          eyebrow="Library"
          title={SEARCH_PAGE_TITLE}
          lede="Titles, links, folders, and notes across your collections."
          documentTitle="Search"
          meta={{
            description: `Search collections, bookmarks, and annotations on ${productName()}.`,
            canonicalPath: null,
            robots: 'noindex',
          }}
        >
          <form className="search-field search-product-form" onSubmit={submit} role="search">
            <Icon name="search" />
            <input
              value={draft}
              onChange={(event) => applyQuery(event.target.value)}
              {...kb.comboboxProps}
              aria-label="Search query"
              placeholder={SITE_SEARCH_PLACEHOLDER}
            />
            <button type="submit" className="btn btn-primary btn-sm">Search</button>
          </form>
          <FilterRail
            label="Result type"
            testId="search-type-filter"
            className="search-product-filters"
            value={filter ?? 'all'}
            options={filters.map((item) => ({ value: item.value ?? 'all', label: item.label }))}
            onChange={(value) => setFilter(value === 'all' ? undefined : value as SearchResourceType)}
          />
        </PageHead>
      </header>

      <section className="search-product-results" aria-labelledby="search-results-title">
        <div className={query ? 'search-product-summary' : 'visually-hidden'}>
          <h2 id="search-results-title">Results</h2>
          {search.state === 'ready' && !search.hasMore && <span>{plural(search.items.length, 'result')}</span>}
        </div>

        {!query && (
          <EmptyState
            icon="search"
            title="Start typing to search"
            description="Results appear as you type."
          />
        )}
        {query && search.state === 'loading' && <LoadingState data-search-state="loading" label="Searching…" />}
        {search.state === 'empty' && (
          <EmptyState
            data-search-state="empty"
            icon="search"
            title={`No results for “${query.trim()}”`}
            description={typesParam ? 'Try another word, or search every type.' : 'Try another word, a site name, or a folder name.'}
            action={typesParam ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFilter(undefined)}>Search everything</button> : undefined}
          />
        )}
        {search.state === 'error' && (
          search.error?.status === 401 ? (
            <RouteState kind="auth" title="Sign in to search your library" />
          ) : (
            <EmptyState
              data-search-state="error"
              role="alert"
              icon="alert"
              title={search.error?.status === 429 ? 'Too many searches' : "Couldn't search"}
              description={retryRemaining > 0 ? `Try again in ${retryRemaining}s.` : search.error?.status === 429 ? 'You can search again now.' : 'Check your connection and try again.'}
              action={<button type="button" className="btn btn-secondary btn-sm" disabled={retryRemaining > 0} onClick={search.retry}>Try again</button>}
            />
          )
        )}

        <div className="search-product-list" data-testid="search-result-list" {...kb.listboxProps} aria-labelledby="search-results-title" data-search-state={search.state === 'loading-more' ? 'loading-more' : search.items.length ? 'ready' : undefined}>
          {search.items.map((result, index) => {
            const place = placeOf(result)
            return (
              <Link
                key={`${result.resourceType}:${result.resourceId}`}
                to={placeHref(result, place)}
                className={`result-row search-product-result${index === kb.active ? ' is-active' : ''}`}
                data-search-result
                data-search-result-id={result.resourceId}
                {...kb.optionProps(index)}
              >
                <SearchResultRow
                  result={result}
                  query={query}
                  nodeKind={place?.kind}
                  meta={placeMeta(result, place)}
                />
              </Link>
            )
          })}
        </div>
        {search.hasMore && (
          <div className="search-product-more">
            <LoadMoreButton
              loading={search.state === 'loading-more'}
              disabled={search.state === 'error'}
              onClick={search.loadMore}
              status="Loading more results"
            />
          </div>
        )}
      </section>
    </PageShell>
  )
}

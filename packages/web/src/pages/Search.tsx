import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { SearchResourceType } from '../api/types'
import { EmptyState, LoadingState } from '../components/EmptyState'
import { FilterRail } from '../components/FilterRail'
import { SelectMenu } from '../components/SelectMenu'
import { LoadMoreButton } from '../components/LoadMoreButton'
import { PageHead } from '../components/PageHead'
import { PageShell } from '../components/PageShell'
import { RouteState } from '../components/RouteState'
import { SearchResultRow, searchResultMeta } from '../components/SearchResultRow'
import { SEARCH_PAGE_TITLE, SITE_SEARCH_PLACEHOLDER } from '../lib/searchCopy'
import { useSearchKeyboard } from '../lib/useSearchKeyboard'
import { searchResultHref, useProductSearch } from '../lib/useProductSearch'

const filters: { label: string; value?: SearchResourceType }[] = [
  { label: 'All' }, { label: 'Collections', value: 'collection' }, { label: 'Bookmarks', value: 'node' },
  { label: 'Profiles', value: 'profile' }, { label: 'Annotations', value: 'annotation' },
]

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

  /* R10-21: same combobox/listbox keyboard model as the ⌘K palette — the
     input keeps focus, arrows move aria-activedescendant, Enter opens. */
  const kb = useSearchKeyboard({
    itemCount: search.items.length,
    listId: 'search-page-results',
    resetKey: `${query}:${filter ?? ''}`,
    onOpen: (index) => {
      const result = search.items[index]
      if (result) navigate(searchResultHref(result))
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
          title={SEARCH_PAGE_TITLE}
          documentTitle="Search"
          meta={{
            description: 'Search collections, profiles, bookmarks, and annotations on Know-N.',
            canonicalPath: null,
            robots: 'noindex',
          }}
        >
          <form className="search-field search-product-form" onSubmit={submit} role="search">
            <input
              value={draft}
              onChange={(event) => applyQuery(event.target.value)}
              {...kb.comboboxProps}
              aria-label="Search query"
              placeholder={SITE_SEARCH_PLACEHOLDER}
            />
            <button type="submit" className="btn btn-primary btn-sm">Search</button>
          </form>
          <div className="search-product-filters">
            <SelectMenu
              label="Result type"
              prefix="In:"
              testId="search-type-filter"
              value={filter ?? 'all'}
              options={filters.map((item) => ({ value: item.value ?? 'all', label: item.label }))}
              onChange={(value) => setFilter(value === 'all' ? undefined : value as SearchResourceType)}
            />
          </div>
        </PageHead>
      </header>

      <section className="search-product-results" aria-labelledby="search-results-title">
        <div className="search-product-summary">
          <h2 id="search-results-title">Results</h2>
          {search.state === 'ready' && !search.hasMore && <span>{search.items.length} found</span>}
        </div>

        {!query && (
          <EmptyState icon="search" title="Enter a query to begin" description="Search collections, profiles, bookmarks, and annotations." />
        )}
        {query && search.state === 'loading' && <LoadingState data-search-state="loading" label="Searching…" />}
        {search.state === 'empty' && (
          <EmptyState data-search-state="empty" icon="search" title={`No results for “${query.trim()}”`} description={typesParam ? 'Try another term or clear the type filter.' : 'Try another term.'} />
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
          {search.items.map((result, index) => (
            <Link
              key={`${result.resourceType}:${result.resourceId}`}
              to={searchResultHref(result)}
              className={`result-row search-product-result${index === kb.active ? ' is-active' : ''}`}
              data-search-result
              data-search-result-id={result.resourceId}
              {...kb.optionProps(index)}
            >
              <SearchResultRow
                result={result}
                query={query}
                meta={searchResultMeta(result) || undefined}
              />
            </Link>
          ))}
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

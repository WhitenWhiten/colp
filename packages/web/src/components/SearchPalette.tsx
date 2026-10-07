import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { EmptyState, LoadingState } from './EmptyState'
import { Icon } from './Icon'
import { Modal } from './Modal'
import { SearchResultRow } from './SearchResultRow'
import { SEARCH_PAGE_TITLE, SITE_SEARCH_PLACEHOLDER } from '../lib/searchCopy'
import { useSearchKeyboard } from '../lib/useSearchKeyboard'
import { searchResultHref, useProductSearch } from '../lib/useProductSearch'
import { loginPath } from '../lib/chrome'

type Props = { open: boolean; onClose: () => void }

export function SearchPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const location = useLocation()
  const search = useProductSearch({ query, limit: 8, debounceMs: 250 })

  const go = (index: number) => {
    const result = search.items[index]
    if (!result) return
    onClose()
    navigate(searchResultHref(result))
  }
  const openFullSearch = () => {
    const value = query.trim()
    onClose()
    navigate(value ? `/search?q=${encodeURIComponent(value)}` : '/search')
  }

  /* R10-21: shared combobox/listbox keyboard model (same as /search). */
  const kb = useSearchKeyboard({
    itemCount: search.items.length,
    listId: 'search-results',
    optionIdPrefix: 'search-palette',
    resetKey: query,
    onOpen: go,
    onEmptyEnter: () => { if (query.trim()) openFullSearch() },
  })

  useEffect(() => {
    if (!open) return
    setQuery('')
    kb.setActive(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open is the signal
  }, [open])

  return createPortal(
    <Modal
      open={open}
      onClose={onClose}
      label="Search Know-N"
      chrome="bare"
      overlayClassName="search-overlay"
      initialFocus='[data-testid="search-palette-input"]'
    >
      <div className="search-palette">
        <div className="search-palette-head">
          <span className="search-input-icon" aria-hidden><Icon name="search" /></span>
          <input ref={inputRef} data-testid="search-palette-input" value={query}
            onChange={(event) => setQuery(event.target.value)} placeholder={SITE_SEARCH_PLACEHOLDER}
            /* aria-expanded stays true: the results region is always visible
               while the palette is open (it is not a popup that collapses).
               The listbox role below only applies when real options exist. */
            {...kb.comboboxProps} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={openFullSearch}>See all results</button>
          <kbd>Esc</kbd>
          {/* R7-13: phones have no Esc key — the sheet needs a tap target.
              Hidden on pointer layouts by search.css. */}
          <button type="button" className="btn btn-ghost btn-sm search-palette-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
        {/* role="listbox" only when options exist — an empty/loading/error
            state is not a list of options, and a listbox with non-option
            children is invalid ARIA. */}
        <div className="search-results" {...kb.listboxProps} aria-label="Search results">
          {!query.trim() && (
            <EmptyState
              className="search-empty"
              icon="search"
              title={SEARCH_PAGE_TITLE}
              description="Type to search available collections, profiles, bookmarks, and annotations."
            />
          )}
          {query.trim() && search.state === 'loading' && <LoadingState className="search-palette-status" label="Searching…" />}
          {query.trim() && search.state === 'empty' && (
            <EmptyState className="search-empty" icon="search" title={`No results for “${query.trim()}”`} />
          )}
          {search.state === 'error' && (
            search.error?.status === 401 ? (
              <EmptyState
                className="search-empty"
                icon="alert"
                title="Sign in to search your library"
                /* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- react-router Link handles activation (close the palette) natively */
                action={<Link to={loginPath(location.pathname, location.search)} className="btn btn-secondary btn-sm" onClick={onClose}>Sign in</Link>}
              />
            ) : (
              <EmptyState
                className="search-empty"
                role="alert"
                icon="alert"
                title="Couldn't search"
                action={<button type="button" className="btn btn-secondary btn-sm" onClick={search.retry}>Try again</button>}
              />
            )
          )}
          {search.items.map((result, index) => (
            <button key={`${result.resourceType}:${result.resourceId}`} type="button"
              data-index={index} className={`result-row search-result${index === kb.active ? ' is-active' : ''}`}
              {...kb.optionProps(index)} onClick={() => go(index)}>
              <SearchResultRow result={result} query={query} />
              <span className="meta" aria-hidden>↵</span>
            </button>
          ))}
        </div>
        <div className="search-palette-foot" aria-hidden>
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </Modal>,
    document.body,
  )
}

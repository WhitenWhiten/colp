// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import { ProductApiError } from '../api/errors'
import type { SearchPage, SearchResourceType } from '../api/types'
import { Search } from './Search'
import { cleanup, domFinishedLoading, findButtonByName, mountTree, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent, robotsContents } from '../test/pageMeta'

const mocks = vi.hoisted(() => ({ search: vi.fn(), live: true }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, isLive: (flag: string) => flag === 'search' ? mocks.live : actual.isLive(flag as never), productClient: { ...actual.productClient, searchResources: mocks.search } }
})
const makePage = (items: SearchPage['items'], nextCursor: string | null = null): SearchPage => ({
  query: 'systems', types: ['collection', 'node', 'profile', 'annotation'], items,
  page: { returnedCount: items.length, hasMore: nextCursor !== null, nextCursor },
  consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
})
async function flushDebounce() { await act(async () => { vi.advanceTimersByTime(300); await Promise.resolve(); await Promise.resolve() }) }

describe('Search page', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.live = true; localStorage.clear(); document.body.innerHTML = '<div id="root"></div>'; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => { cleanup(); vi.useRealTimers(); document.body.innerHTML = '' })
  function render(path = '/search?q=systems') { mountTree(<MemoryRouter initialEntries={[path]}><Routes><Route path="/search" element={<Search />} /></Routes></MemoryRouter>) }
  it('shows loading, appends the same generation, and moves focus to the first appended result', async () => {
    installPageMetaBaseline()
    mocks.search.mockResolvedValueOnce(makePage([{ resourceType: 'collection', resourceId: 'c1', title: 'Systems', snippet: 'First', rank: 0.9 }], 'cursor-2'))
      .mockResolvedValueOnce(makePage([{ resourceType: 'node', resourceId: 'n2', collectionId: 'c1', title: 'Systems interfaces', urlHost: 'known.test', snippet: 'Second systems', rank: 0.8 }]))
    render()
    await flushDebounce()
    expect(document.body.textContent).toContain('Search Know-N')
    expect(document.body.textContent).not.toContain('knowledge workspace')
    expect(document.querySelector('[data-search-state="ready"]')).not.toBeNull()
    act(() => findButtonByName('Load more').click())
    expect(document.querySelector('[data-search-state="loading-more"]')).not.toBeNull()
    await waitForDom(domFinishedLoading)
    expect(mocks.search).toHaveBeenLastCalledWith({ q: 'systems', cursor: 'cursor-2' }, expect.objectContaining({ maxRetries: 0, signal: expect.any(AbortSignal) }))
    expect(document.querySelectorAll('[data-search-result]')).toHaveLength(2)
    // Load-more points the combobox cursor at the first appended row.
    const activeId = document.querySelector('input[aria-label="Search query"]')?.getAttribute('aria-activedescendant')
    expect(activeId).not.toBeNull()
    expect(activeId && document.getElementById(activeId)?.getAttribute('data-search-result-id')).toBe('n2')
    expect(pageMetaContent('meta[name="description"]')).toBe('Search collections, profiles, bookmarks, and annotations on Know-N.')
    expect(canonicalHref()).toBeNull()
    expect(pageMetaContent('meta[property="og:url"]')).toBeNull()
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
    expect(robotsContents()).toEqual(['noindex'])
    const nodeHit = document.querySelector('[data-search-result-id="n2"]')
    expect(nodeHit?.querySelector('[data-testid="search-result-kind"]')?.textContent).toBe('Bookmark')
    expect(nodeHit?.querySelector('[data-testid="search-result-kind"]')?.textContent).not.toBe('node')
  })

  it('keeps the results when a route round trip remounts the same query', async () => {
    mocks.search.mockResolvedValue(makePage([
      { resourceType: 'collection', resourceId: 'c1', title: 'Systems', snippet: 'First', rank: 0.9 },
    ]))
    render()
    await flushDebounce()
    expect(document.body.textContent).toContain('Systems')

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    render()

    // First frame back: the results are painted from cache, no "Searching…".
    expect(document.querySelector('[data-search-state="ready"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Systems')
    await flushDebounce()
  })

  it('restores the type filter from the URL and writes filter changes back to it', async () => {
    mocks.search.mockResolvedValue(makePage([]))
    let currentSearch = ''
    function LocationProbe() {
      currentSearch = useLocation().search
      return null
    }
    mountTree(
      <MemoryRouter initialEntries={['/search?q=systems&types=profile']}>
        <Routes>
          <Route path="/search" element={<><LocationProbe /><Search /></>} />
        </Routes>
      </MemoryRouter>,
    )
    await flushDebounce()
    expect(mocks.search).toHaveBeenLastCalledWith(
      { q: 'systems', types: ['profile'] satisfies SearchResourceType[], limit: 20 },
      expect.anything(),
    )
    const type = () => document.querySelector<HTMLSelectElement>('[data-testid="search-type-filter"] select')!
    const choose = (value: string) => act(() => {
      type().value = value
      type().dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(type().value).toBe('profile')
    expect(document.querySelector('[data-testid="search-type-filter"]')?.textContent).toContain('In:')
    choose('collection')
    await flushDebounce()
    expect(currentSearch).toContain('types=collection')
    choose('all')
    await flushDebounce()
    expect(currentSearch).not.toContain('types=')
    expect(currentSearch).toContain('q=systems')
  })

  it('clears results and cursor when the type filter changes', async () => {
    mocks.search.mockResolvedValueOnce(makePage([{ resourceType: 'collection', resourceId: 'c1', title: 'Old', snippet: 'Old', rank: 0.9 }], 'old-cursor'))
      .mockResolvedValueOnce({ ...makePage([]), types: ['profile'] })
    render(); await flushDebounce()
    act(() => {
      const type = document.querySelector<HTMLSelectElement>('[data-testid="search-type-filter"] select')!
      type.value = 'profile'
      type.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain('Old')
    await flushDebounce()
    expect(mocks.search).toHaveBeenLastCalledWith({ q: 'systems', types: ['profile'] satisfies SearchResourceType[], limit: 20 }, expect.anything())
    expect(String(mocks.search.mock.calls.at(-1)?.[0]?.cursor)).toBe('undefined')
    expect(document.querySelector('[data-search-state="empty"]')).not.toBeNull()
  })

  it('offers sign-in instead of Retry on a 401', async () => {
    mocks.search.mockRejectedValueOnce(new ProductApiError({ status: 401, code: 'authentication_required', message: 'failed' }))
    render(); await flushDebounce()
    expect(document.body.textContent).toContain('Sign in to search your library')
    expect(document.querySelector('a[href^="/login?returnTo="]')).not.toBeNull()
    expect(() => findButtonByName('Try again')).toThrow(/button not found/u)
  })

  it.each([
    [429, 'rate_limited', 'Try again in 2s.'],
    [503, 'feature_temporarily_unavailable', 'Try again'],
  ] as const)('recovers visibly from %s', async (status, code, expected) => {
    mocks.search.mockRejectedValueOnce(new ProductApiError({ status, code, message: 'failed', retryAfterSeconds: status === 429 ? 2 : null }))
      .mockResolvedValueOnce(makePage([{ resourceType: 'profile', resourceId: 'p1', handle: 'mira', displayName: 'Mira', avatarUrl: null, snippet: 'Recovered systems', rank: 0.7 }]))
    render(); await flushDebounce()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(expected)
    const retry = findButtonByName('Try again')
    if (status === 429) {
      expect(retry.disabled).toBe(true)
      await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve() })
      expect(retry.disabled).toBe(false)
    }
    act(() => retry.click()); await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Recovered')
  })

  it('uses one stable responsive list contract for long words, CJK, and RTL plain text', async () => {
    const unsafe = '<script>alert(1)</script>LongLongLongLongLongLong中文内容مرحبا'
    mocks.search.mockResolvedValue(makePage([{ resourceType: 'annotation', resourceId: 'a1', collectionId: 'c1', subject: { type: 'node', id: 'n1' }, annotationType: 'note', snippet: unsafe, rank: 0.6 }]))
    render('/search?q=LongLongLongLongLongLong'); await flushDebounce()
    const list = document.querySelector('[data-testid="search-result-list"]')
    // An annotation hit is titled by its own text (the API has no subject title).
    const title = list?.querySelector('strong')
    expect(list?.classList.contains('search-product-list')).toBe(true)
    expect(title?.textContent).toBe(unsafe)
    expect(title?.getAttribute('dir')).toBe('auto')
    expect(document.querySelector('[data-testid="search-result-meta"]')?.textContent).toBe('On a bookmark')
    expect(document.querySelector('[data-testid="search-result-meta"]')?.textContent).not.toContain('node')
    expect(document.querySelector('script')).toBeNull()
  })

  it('searches as you type and travels the results with arrow keys (R7-11)', async () => {
    mocks.search.mockResolvedValue(makePage([
      { resourceType: 'collection', resourceId: 'c1', title: 'Systems', snippet: 'First', rank: 0.9 },
      { resourceType: 'collection', resourceId: 'c2', title: 'Systems II', snippet: 'Second', rank: 0.8 },
    ]))
    render('/search')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search query"]')!
    // Typing alone (no submit) triggers the search after the debounce.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => {
      setter.call(input, 'systems')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flushDebounce()
    await waitForDom(domFinishedLoading)
    expect(mocks.search).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'systems' }),
      expect.anything(),
    )
    const results = [...document.querySelectorAll<HTMLElement>('[data-search-result]')]
    expect(results).toHaveLength(2)

    // R10-21: combobox/listbox like the palette — focus stays in the
    // field and arrows move aria-activedescendant over role=option rows.
    expect(input.getAttribute('role')).toBe('combobox')
    expect(document.querySelector('[data-testid="search-result-list"]')?.getAttribute('role')).toBe('listbox')
    expect(results.map((row) => row.getAttribute('role'))).toEqual(['option', 'option'])
    act(() => {
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('aria-activedescendant')).toBe(results[1]!.id)
    expect(results[1]!.getAttribute('aria-selected')).toBe('true')
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(input.getAttribute('aria-activedescendant')).toBe(results[0]!.id)
  })

  it('highlights query hits in the title and does not repeat Collection in the meta column', async () => {
    mocks.search.mockResolvedValue(makePage([{ resourceType: 'collection', resourceId: 'c1', title: 'Systems thinking', snippet: 'A path about systems', rank: 0.9 }]))
    render()
    await flushDebounce()
    const marks = [...document.querySelectorAll('mark')].map((node) => node.textContent)
    expect(marks.some((text) => text?.toLowerCase() === 'systems')).toBe(true)
    const result = document.querySelector('[data-search-result]')
    expect(result?.querySelector('[data-testid="search-result-kind"]')?.textContent).toBe('Collection')
    expect(result?.querySelector('strong[dir="auto"]')).not.toBeNull()
    expect(result?.querySelector('[data-testid="search-result-meta"]')).toBeNull()
  })

  it('renders every backend hit without re-filtering by substring, so fuzzy and stemmed matches survive', async () => {
    // Relevance is decided by the backend's per-script trigram threshold; a
    // client-side token filter would drop the typo and stem hits below.
    mocks.search.mockResolvedValue(makePage([
      { resourceType: 'collection', resourceId: 'c-typo', title: 'Design systems', snippet: 'Tokens and scales', rank: 0.9 },
      { resourceType: 'node', resourceId: 'n-stem', collectionId: 'c1', title: 'Run every morning', urlHost: 'known.test', snippet: 'Habits', rank: 0.8 },
      { resourceType: 'annotation', resourceId: 'a-1', collectionId: 'c1', annotationType: 'highlight', subject: { type: 'node', id: 'n-stem' }, snippet: 'Cadence beats intensity', rank: 0.7 },
    ]))
    render('/search?q=desgin')
    await flushDebounce()
    expect(document.querySelectorAll('[data-search-result]')).toHaveLength(3)
    expect(document.body.textContent).toContain('Design systems')
    expect(document.body.textContent).toContain('Run every morning')
    expect(document.querySelector('[data-search-state="empty"]')).toBeNull()
  })

  it('shows the empty state only when the backend returns no hits', async () => {
    mocks.search.mockResolvedValue(makePage([]))
    render('/search?q=zzzxnotfoundxyz')
    await flushDebounce()
    expect(document.querySelector('[data-search-state="empty"]')).not.toBeNull()
    expect(document.querySelector('[data-search-state="empty"]')?.textContent).toContain('No results for “zzzxnotfoundxyz”')
    expect(document.querySelector('[data-search-state="empty"]')?.textContent).toContain('Try another term.')
    expect(document.querySelectorAll('[data-search-result]')).toHaveLength(0)
  })
})

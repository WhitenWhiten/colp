// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { ExploreCollection, ExploreParams } from '../api/types'
import { Explore } from './Explore'
import { cleanup, domFinishedLoading, mountTree, settled, waitForDom } from '../test/render'
import { canonicalHref, installPageMetaBaseline, pageMetaContent } from '../test/pageMeta'

const mocks = vi.hoisted(() => ({
  explore: false,
  getExploreCollections: vi.fn(),
  getPublicReportsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
  getCommunityRanking: vi.fn(async (_params?: { tag?: string }) => ({ items: [], nextCursor: null, scoreVersion: 'hot-v1', asOf: null })),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getExploreCollections: mocks.getExploreCollections,
    productClient: {
      ...actual.productClient,
      getPublicReportsPage: mocks.getPublicReportsPage,
      getCommunityRanking: mocks.getCommunityRanking,
    },
    FEATURE_FLAGS: {
      ...actual.FEATURE_FLAGS,
      get explore() {
        return mocks.explore
      },
    },
  }
})

const SORT_KEY = 'known.explore.sort.v1'

function exploreItem(
  overrides: Partial<ExploreCollection> & Pick<ExploreCollection, 'title' | 'publicationSlug'>,
): ExploreCollection {
  return {
    id: `col-${overrides.publicationSlug}`,
    summary: `${overrides.title} summary`,
    kind: 'knowledge_collection',
    tags: ['ML'],
    nodeCount: 16,
    updatedAt: '2026-07-24T12:00:00.000Z',
    visibility: 'public',
    creators: [{ id: 'p1', name: 'Lin Yichen', handle: 'lin', avatar: null }],
    ...overrides,
  }
}

function requestParams(index = 0): ExploreParams {
  return (mocks.getExploreCollections.mock.calls[index]?.[0] ?? {}) as ExploreParams
}

function lastRequestParams(): ExploreParams {
  const calls = mocks.getExploreCollections.mock.calls
  return (calls[calls.length - 1]?.[0] ?? {}) as ExploreParams
}

/** Tab labels carry a trailing count — match on the label prefix. */
function kindButton(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="explore-kind"] button')]
    .find((button) => button.textContent?.trim().startsWith(label))!
}

describe('Explore live', () => {

  beforeEach(() => {
    clearRouteCache()
    mocks.explore = true
    localStorage.clear()
    mocks.getExploreCollections.mockReset()
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    mocks.getPublicReportsPage.mockReset()
    mocks.getPublicReportsPage.mockResolvedValue({ items: [], nextCursor: null })
    mocks.getCommunityRanking.mockReset()
    mocks.getCommunityRanking.mockResolvedValue({ items: [], nextCursor: null, scoreVersion: 'hot-v1', asOf: null })
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete (window as { __KNOWN_FLAGS__?: unknown }).__KNOWN_FLAGS__
  })

  function renderExplore() {
    mountTree(<MemoryRouter><Explore /></MemoryRouter>)
  }

  function pickSelect(testId: string, value: string) {
    const select = document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"] select`)!
    act(() => {
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  function menuSelect(testId: string) {
    return document.querySelector<HTMLSelectElement>(`[data-testid="${testId}"] select`)!
  }

  function pickSelectByLabel(testId: string, label: string) {
    const value = [...menuSelect(testId).options].find((o) => o.textContent?.trim() === label)!.value
    pickSelect(testId, value)
  }

  function pickSort(label: string) {
    pickSelectByLabel('explore-sort', label)
  }

  function pickTopic(label: string) {
    pickSelectByLabel('explore-topic', label)
  }

  it('renders a moderation tombstone in the grid without a link (#21)', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [
        exploreItem({ id: 'col-hidden', title: 'Collection hidden', publicationSlug: null, hiddenPublic: true }),
        exploreItem({ title: 'LLM learning path', publicationSlug: 'llm-learning-path' }),
      ],
      nextCursor: null,
    })
    renderExplore()
    await waitForDom(domFinishedLoading)

    const stone = document.querySelector('[data-collection-hidden]')
    expect(stone).not.toBeNull()
    expect(stone?.querySelector('h3.collection-card-title')?.textContent).toBe('Collection hidden')
    expect(stone?.closest('a')).toBeNull()
    expect(document.querySelector('a[href="/c/llm-learning-path"]')).not.toBeNull()
    expect(document.body.textContent).toContain('LLM learning path')
  })

  it('keeps the board on screen when a route round trip remounts the page', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'LLM learning path', publicationSlug: 'llm-learning-path' })],
      nextCursor: null,
    })
    renderExplore()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('LLM learning path')

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    renderExplore()

    // First frame back: the grid is painted from cache, no loading state.
    expect(document.body.textContent).toContain('LLM learning path')
    expect(document.body.textContent).not.toContain('Loading collections')
    await waitForDom(domFinishedLoading)
  })

  it('keeps the page top on entry; only a filter change scrolls the board into view', async () => {
    /* Regression: the board effect used to fire on mount, so every visit to
       /explore jumped straight to the grid (~20% down the page). Mounting is
       not a filter change — only picking a topic/language may scroll. */
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    try {
      mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
      renderExplore()
      await waitForDom(domFinishedLoading)
      expect(scroll).not.toHaveBeenCalled()

      pickTopic('Design')
      await waitForDom(domFinishedLoading)
      expect(scroll).toHaveBeenCalled()
    } finally {
      scroll.mockRestore()
    }
  })

  it('still clears the board when the tag changes to a different one', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'LLM learning path', publicationSlug: 'llm-learning-path' })],
      nextCursor: null,
    })
    renderExplore()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('LLM learning path')

    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    pickTopic('Design')
    expect(document.body.textContent).not.toContain('LLM learning path')
    await waitForDom(domFinishedLoading)
  })

  it('requests the first page with sort updated and no cursor', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'LLM learning path', publicationSlug: 'llm-learning-path' })],
      nextCursor: 'cursor-page-2',
    })
    renderExplore()
    await waitForDom(domFinishedLoading)

    expect(requestParams(0)).toEqual({ limit: 24, sort: 'updated' })
    expect(requestParams(0)).not.toHaveProperty('cursor')
    expect(requestParams(0)).not.toHaveProperty('tag')
    expect(document.body.textContent).toContain('LLM learning path')
    expect(document.body.textContent).not.toContain('0 views')
    expect(document.body.textContent).not.toMatch(/\bviews\b/)
    expect(document.body.textContent).not.toContain('followers')
  })

  it('resets the cursor when switching to Popular', async () => {
    const recent = exploreItem({ title: 'Recent path', publicationSlug: 'recent-path' })
    const popular = exploreItem({
      title: 'Popular path',
      publicationSlug: 'popular-path',
      viewCount: 12,
    })
    /* Keyed on the request, not on call order: every mount-time call (StrictMode
       runs the effect twice) sees the Recent board, and the Popular board only
       appears once the request actually carries sort=popular. */
    mocks.getExploreCollections.mockImplementation(async (params?: ExploreParams) => (
      params?.sort === 'popular'
        ? { items: [popular], nextCursor: 'cursor-popular-2' }
        : { items: [recent], nextCursor: 'cursor-page-2' }
    ))
    renderExplore()
    await waitForDom(domFinishedLoading)

    pickSort('Popular')
    await waitForDom(domFinishedLoading)

    expect(lastRequestParams()).toEqual({ limit: 24, sort: 'popular' })
    expect(lastRequestParams()).not.toHaveProperty('cursor')
    expect(menuSelect('explore-sort').selectedOptions[0]?.textContent).toContain('Popular')
    expect(localStorage.getItem(SORT_KEY)).toBe('popular')
    expect(document.body.textContent).toContain('Popular path')
    expect(document.body.textContent).toContain('12 views')
    expect(document.body.textContent).not.toContain('followers')
  })

  it('requests an exact tag match and does not keep substring tags from the previous page', async () => {
    const designSystems = exploreItem({
      title: 'Design Systems Library',
      publicationSlug: 'design-systems',
      tags: ['DesignSystems'],
    })
    const design = exploreItem({
      title: 'Design notes',
      publicationSlug: 'design-notes',
      tags: ['Design'],
    })
    mocks.getExploreCollections.mockImplementation(async (params?: ExploreParams) => {
      const catalog = [designSystems, design]
      const items = params?.tag
        ? catalog.filter((entry) => entry.tags.includes(params.tag!))
        : [designSystems]
      return { items, nextCursor: 'tag-cursor' }
    })
    renderExplore()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Design Systems Library')

    pickTopic('Design')
    await waitForDom(domFinishedLoading)

    expect(lastRequestParams()).toEqual({ limit: 24, sort: 'updated', tag: 'Design' })
    expect(lastRequestParams()).not.toHaveProperty('cursor')
    expect(document.body.textContent).toContain('Design notes')
    expect(document.body.textContent).not.toContain('Design Systems Library')
  })

  it('maps a legacy localStorage followers sort to updated', async () => {
    localStorage.setItem(SORT_KEY, 'followers')
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    renderExplore()
    await waitForDom(domFinishedLoading)

    expect(requestParams(0)).toEqual({ limit: 24, sort: 'updated' })
    expect(JSON.stringify(mocks.getExploreCollections.mock.calls)).not.toContain('followers')
    expect(localStorage.getItem(SORT_KEY)).toBe('updated')
    expect(menuSelect('explore-sort').selectedOptions[0]?.textContent).toContain('Recent')
    expect(menuSelect('explore-sort').selectedOptions[0]?.textContent).not.toContain('Popular')
  })

  it('maps an unknown localStorage sort to updated', async () => {
    localStorage.setItem(SORT_KEY, 'newest')
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    renderExplore()
    await waitForDom(domFinishedLoading)

    expect(requestParams(0)).toEqual({ limit: 24, sort: 'updated' })
    expect(localStorage.getItem(SORT_KEY)).toBe('updated')
  })

  it('sends the previous cursor when loading more, then drops it after a tag change', async () => {
    const pageOne = exploreItem({ title: 'Page one', publicationSlug: 'page-one' })
    const pageTwo = exploreItem({ title: 'Page two', publicationSlug: 'page-two' })
    const engineering = exploreItem({ title: 'Engineering notes', publicationSlug: 'engineering-notes', tags: ['Engineering'] })
    /* Keyed on the request: the first page is whatever arrives without a cursor
       (however many mount-time calls StrictMode makes), page two only for the
       cursor the first page handed out, and the tag board only for its tag. */
    mocks.getExploreCollections.mockImplementation(async (params?: ExploreParams) => {
      if (params?.tag === 'Engineering') return { items: [engineering], nextCursor: null }
      if (params?.cursor === 'cursor-page-2') return { items: [pageTwo], nextCursor: 'cursor-page-3' }
      return { items: [pageOne], nextCursor: 'cursor-page-2' }
    })
    renderExplore()
    await waitForDom(domFinishedLoading)

    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Load more')!
        .click()
    })
    await waitForDom(domFinishedLoading)
    expect(lastRequestParams()).toEqual({ limit: 24, sort: 'updated', cursor: 'cursor-page-2' })
    expect(document.body.textContent).toContain('Page one')
    expect(document.body.textContent).toContain('Page two')

    pickTopic('Engineering')
    await waitForDom(domFinishedLoading)
    expect(lastRequestParams()).toEqual({ limit: 24, sort: 'updated', tag: 'Engineering' })
    expect(lastRequestParams()).not.toHaveProperty('cursor')
    expect(document.body.textContent).toContain('Engineering notes')
    expect(document.body.textContent).not.toContain('Page one')
  })

  it('shows LoadingState on first live paint instead of a false empty match', async () => {
    mocks.getExploreCollections.mockReturnValue(new Promise(() => {}))
    renderExplore()
    /* Let the digest source settle inside act; the collection page stays
       pending, so the loading state is what the reader sees. */
    await settled()

    expect(document.querySelector('[data-testid="explore-loading-state"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Loading collections')
    expect(document.body.textContent).not.toContain('Nothing matches')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(menuSelect('explore-topic').disabled).toBe(false)
    expect(menuSelect('explore-sort').disabled).toBe(false)
  })

  // R15-14: digests sort into the same board, so the first paint waits for
  // them (briefly) instead of re-sorting cards already on screen.
  it('holds the first board paint for pending digests, at most 400 ms', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'Held collection', publicationSlug: 'held-collection' })],
      nextCursor: null,
    })
    mocks.getPublicReportsPage.mockReturnValue(new Promise(() => {}))
    renderExplore()
    await settled()
    expect(document.querySelector('[data-testid="explore-loading-state"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Held collection')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    expect(document.body.textContent).toContain('Held collection')
    expect(document.querySelector('[data-testid="explore-loading-state"]')).toBeNull()
  })

  it('shows an alert EmptyState on reject and Retry reloads the first page', async () => {
    /* Stateful, not a call queue: StrictMode runs the mount effect twice, so the
       number of mount-time requests is not a fixed 1. The board stays down
       until the test brings it back up for the Retry click. */
    let boardUp = false
    mocks.getExploreCollections.mockImplementation(async () => {
      if (!boardUp) throw new Error('network')
      return {
        items: [exploreItem({ title: 'Recovered path', publicationSlug: 'recovered-path' })],
        nextCursor: null,
      }
    })
    renderExplore()
    await waitForDom(domFinishedLoading)

    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain("Couldn't load collections")
    expect(document.body.textContent).not.toContain('Nothing matches')
    expect(document.querySelector('[data-testid="explore-loading-state"]')).toBeNull()
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Try again')
    expect(retry).toBeTruthy()
    expect(retry?.textContent).not.toContain('Reset filters')

    const beforeRetry = mocks.getExploreCollections.mock.calls.length
    // Mount issues one first-page GET per effect run (StrictMode re-runs it
    // once) — anything more would be a refetch loop.
    expect(beforeRetry).toBeLessThanOrEqual(2)
    boardUp = true
    act(() => {
      retry!.click()
    })
    await waitForDom(domFinishedLoading)

    // Retry issues exactly one more first-page request — same shape, no cursor.
    expect(mocks.getExploreCollections.mock.calls.length).toBe(beforeRetry + 1)
    expect(lastRequestParams()).toEqual({ limit: 24, sort: 'updated' })
    expect(lastRequestParams()).not.toHaveProperty('cursor')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).toContain('Recovered path')
  })

  it('brings LoadingState back when switching to Popular', async () => {
    /* Request-keyed: the Recent board answers every mount-time call, and the
       Popular board is left in flight so the loading state is what shows. */
    mocks.getExploreCollections.mockImplementation(async (params?: ExploreParams) => {
      if (params?.sort === 'popular') return new Promise(() => {})
      return {
        items: [exploreItem({ title: 'Recent path', publicationSlug: 'recent-path' })],
        nextCursor: null,
      }
    })
    renderExplore()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Recent path')

    pickSort('Popular')

    expect(document.querySelector('[data-testid="explore-loading-state"]')).not.toBeNull()
    expect(document.body.textContent).toContain('Loading collections')
    expect(document.body.textContent).not.toContain('Nothing matches')
    expect(document.body.textContent).not.toContain('Recent path')
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(lastRequestParams()).toEqual({ limit: 24, sort: 'popular' })
  })

  it('continues empty pages until later visible items arrive without claiming the catalog ended', async () => {
    const later = exploreItem({ title: 'Later collection', publicationSlug: 'later-collection' })
    mocks.getExploreCollections.mockImplementation(async (params?: ExploreParams) => {
      if (params?.cursor === 'window-3') return { items: [later], nextCursor: null }
      return { items: [], nextCursor: params?.cursor === 'window-2' ? 'window-3' : 'window-2' }
    })
    renderExplore()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Keep browsing')
    expect(document.body.textContent).not.toContain('Nothing has been published here yet')

    for (const cursor of ['window-2', 'window-3']) {
      const more = [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === 'Load more')
      expect(more).toBeDefined()
      await act(async () => { more!.click() })
      await waitForDom(domFinishedLoading)
      expect(lastRequestParams().cursor).toBe(cursor)
      expect(mocks.getExploreCollections.mock.calls.filter(([params]) => params?.cursor === cursor)).toHaveLength(1)
    }
    expect(document.body.textContent).toContain('Later collection')
    expect(document.body.textContent).toContain('All 1 collection loaded')
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Load more')).toBe(false)
  })

  it('still treats a successful empty page as an empty board', async () => {
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    renderExplore()
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('No public collections yet')
    expect(document.querySelector('[data-testid="explore-loading-state"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.body.textContent).not.toContain("Couldn't load collections")
    expect(document.body.textContent).not.toContain('Reset filters')
    expect(document.body.textContent).not.toContain('Retry')
    expect(document.body.textContent).not.toContain('Try again')
  })

  it('does not wipe existing cards when Load more fails', async () => {
    /* Request-keyed: the first page always succeeds, the cursor page always
       fails — whichever mount-time call issued the first-page request. */
    mocks.getExploreCollections.mockImplementation(async (params?: ExploreParams) => {
      if (params?.cursor) throw new Error('network')
      return {
        items: [exploreItem({ title: 'Page one', publicationSlug: 'page-one' })],
        nextCursor: 'cursor-page-2',
      }
    })
    renderExplore()
    await waitForDom(domFinishedLoading)
    expect(document.body.textContent).toContain('Page one')

    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Load more')!
        .click()
    })
    await waitForDom(domFinishedLoading)

    expect(document.body.textContent).toContain('Page one')
    expect(document.body.textContent).not.toContain('Nothing matches')
  })

  it('filters the merged board by the Kind segment', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [
        exploreItem({ title: 'Reading path', publicationSlug: 'reading-path', kind: 'reading_path' }),
        exploreItem({ title: 'Knowledge shelf', publicationSlug: 'knowledge-shelf' }),
      ],
      nextCursor: null,
    })
    /* Base implementation: the reports directory is fetched once per mount-time
       invocation, and every call answers with the same digest. */
    mocks.getPublicReportsPage.mockResolvedValue({
      items: [{
        id: 'series-1',
        title: 'Weekly Digest',
        summary: 'Digest summary',
        slug: 'weekly-digest',
        visibility: 'public',
        indexable: true,
        updatedAt: '2026-07-25T00:00:00.000Z',
        issues: [{ id: 'issue-1', title: 'Issue one', publishedAt: '2026-07-25T00:00:00.000Z' }],
      }],
      nextCursor: null,
    } as never)
    ;(window as { __KNOWN_FLAGS__?: { reports?: boolean } }).__KNOWN_FLAGS__ = { reports: true }
    renderExplore()
    await waitForDom(domFinishedLoading)

    // Paths: only reading_path cards.
    act(() => { kindButton('Paths').click() })
    expect(document.body.textContent).toContain('Reading path')
    expect(document.body.textContent).not.toContain('Knowledge shelf')
    expect(document.body.textContent).not.toContain('Weekly Digest')

    // Collections: non-path collections only.
    act(() => { kindButton('Collections').click() })
    expect(document.body.textContent).toContain('Knowledge shelf')
    expect(document.body.textContent).not.toContain('Reading path')

    // Digests: only the nameplate, topic menu inert (disabled, not hidden).
    act(() => { kindButton('Digests').click() })
    expect(document.body.textContent).toContain('Weekly Digest')
    expect(document.body.textContent).not.toContain('Knowledge shelf')
    expect(document.querySelector('[data-testid="report-series-card"]')).not.toBeNull()
    expect(menuSelect('explore-topic').disabled).toBe(true)
    expect(lastRequestParams()).not.toHaveProperty('tag', 'Design')
    expect(menuSelect('explore-topic').selectedOptions[0]?.textContent).toContain('Any topic')
  })

  it('hides the Digests segment while the reports gate is off', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'Reading path', publicationSlug: 'reading-path' })],
      nextCursor: null,
    })
    ;(window as { __KNOWN_FLAGS__?: { reports?: boolean } }).__KNOWN_FLAGS__ = { reports: false }
    renderExplore()
    await waitForDom(domFinishedLoading)

    expect([...document.querySelectorAll('[data-testid="explore-kind"] button')].map((b) => b.textContent?.trim().replace(/\s*\d+\+?$/, '')))
      .toEqual(['Collections', 'Paths'])
    expect(document.querySelector('[data-testid="report-series-card"]')).toBeNull()
  })

  it('keeps Load more disabled and fires one request while a page is in flight', async () => {
    let finishMore: ((value: { items: ExploreCollection[]; nextCursor: string | null }) => void) | undefined
    /* Request-keyed: the first-page request always resolves with the next
       cursor, while the cursor request is held open so it stays in flight. */
    mocks.getExploreCollections.mockImplementation((params?: ExploreParams) => {
      if (params?.cursor === 'cursor-page-2') {
        return new Promise<{ items: ExploreCollection[]; nextCursor: string | null }>((resolve) => { finishMore = resolve })
      }
      return Promise.resolve({
        items: [exploreItem({ title: 'Page one', publicationSlug: 'page-one' })],
        nextCursor: 'cursor-page-2',
      })
    })
    renderExplore()
    await waitForDom(domFinishedLoading)

    const loadMore = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => /Load more|Loading/.test(button.textContent ?? ''))!
    const beforeLoadMore = mocks.getExploreCollections.mock.calls.length
    // One first-page GET per mount effect run (StrictMode re-runs it once).
    expect(beforeLoadMore).toBeLessThanOrEqual(2)
    act(() => { loadMore().click(); loadMore().click() })

    // The double click issues exactly one more request: the second click hits
    // the in-flight guard instead of firing a duplicate.
    expect(mocks.getExploreCollections.mock.calls.length).toBe(beforeLoadMore + 1)
    expect(lastRequestParams()).toEqual({ limit: 24, sort: 'updated', cursor: 'cursor-page-2' })
    expect(loadMore().disabled).toBe(true)
    expect(loadMore().getAttribute('aria-busy')).toBe('true')
    expect(loadMore().textContent?.trim()).toBe('Loading…')
    expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading more items')

    await act(async () => {
      finishMore?.({
        items: [exploreItem({ title: 'Page two', publicationSlug: 'page-two' })],
        nextCursor: 'cursor-page-3',
      })
      await Promise.resolve()
    })
    await waitForDom(domFinishedLoading)
    expect(loadMore().disabled).toBe(false)
    expect(loadMore().textContent?.trim()).toBe('Load more')
    expect(document.body.textContent).toContain('Page two')
  })
})

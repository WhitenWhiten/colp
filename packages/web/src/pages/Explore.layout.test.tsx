// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
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

describe('Explore layout', () => {
  beforeEach(() => {
    clearRouteCache()
    mocks.explore = false
    localStorage.clear()
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete (window as { __KNOWN_FLAGS__?: unknown }).__KNOWN_FLAGS__
  })

  it('keeps topic filters and does not add a second search field', async () => {
    installPageMetaBaseline()
    mountTree(<MemoryRouter><Explore /></MemoryRouter>)
    await settled()
    expect(document.querySelector('input[type="search"]')).toBeNull()
    expect(document.querySelector('[role="searchbox"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Search title, curator, or tag')
    expect(document.querySelector('[data-testid="explore-topic"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="explore-page-head"]')).not.toBeNull()
    expect(mocks.getExploreCollections).not.toHaveBeenCalled()
    expect(document.title).toBe('Explore — Know-N')
    expect(pageMetaContent('meta[name="description"]')).toBe('Explore public collections and curated learning paths on Know-N.')
    expect(canonicalHref()).toBe('https://know-n.com/explore')
    expect(pageMetaContent('meta[property="og:title"]')).toBe(document.title)
    expect(pageMetaContent('meta[property="og:description"]')).toBe(pageMetaContent('meta[name="description"]'))
    expect(pageMetaContent('meta[property="og:url"]')).toBe(canonicalHref())
  })

  it('mixes digests into the collection grid sorted by recency', async () => {
    mocks.explore = true
    mocks.getExploreCollections.mockReset()
    mocks.getExploreCollections.mockResolvedValue({
      items: [
        exploreItem({ title: 'Older path', publicationSlug: 'older-path', updatedAt: '2026-07-20T12:00:00.000Z' }),
        exploreItem({ title: 'Newest path', publicationSlug: 'newest-path', updatedAt: '2026-07-28T12:00:00.000Z' }),
      ],
      nextCursor: null,
    })
    /* Base implementation, not a one-shot queue: the reports directory is
       fetched once per mount-time invocation, so every call answers with the
       same digest. */
    mocks.getPublicReportsPage.mockResolvedValue({
      items: [{
        id: 'series-1',
        title: 'Weekly Digest',
        summary: 'Digest summary',
        slug: 'weekly-digest',
        visibility: 'public',
        indexable: true,
        updatedAt: '2026-07-25T00:00:00.000Z',
        issues: [{ id: 'issue-1', title: 'Issue one', publishedAt: '2026-07-25T00:00:00.000Z', editionOrdinal: 12 }],
      }],
      nextCursor: null,
    } as never)
    ;(window as { __KNOWN_FLAGS__?: { reports?: boolean } }).__KNOWN_FLAGS__ = { reports: true }
    mountTree(<MemoryRouter><Explore /></MemoryRouter>)
    await waitForDom(domFinishedLoading)

    // The default tab is Collections: digests live behind their own tab —
    // no separate rail, and the count rides the tab label.
    expect(document.querySelector('[data-testid="digests-rail"]')).toBeNull()
    const grid = document.querySelector('[data-testid="collection-grid"]')!
    expect(grid).not.toBeNull()
    expect(grid.querySelector('[data-testid="report-series-card"]')).toBeNull()
    const titles = [...grid.querySelectorAll('h3.collection-card-title, h3.result-card-title')].map((node) => node.textContent)
    expect(titles).toEqual(['Newest path', 'Older path'])

    act(() => { kindButton('Digests').click() })
    await waitForDom(domFinishedLoading)

    const digest = grid.querySelector('[data-testid="report-series-card"]')
    expect(digest).not.toBeNull()
    // The nameplate shares the collection anatomy: collection chrome, rss
    // mark + Digest chip, and a No./date stats line.
    expect(digest?.classList.contains('result-card--collection')).toBe(true)
    expect(digest?.textContent).toContain('No. 12')
    expect(digest?.querySelector('span.chip--label')?.textContent).toBe('Digest')
    expect(kindButton('Digests').textContent).toContain('1')
  })
})

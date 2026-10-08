// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { ExploreCollection, ExploreParams } from '../api/types'
import { Explore } from './Explore'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

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

  it('forwards the selected topic unchanged to the Hot ranking — no lowercasing', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: true }
    renderExplore()
    await waitForDom(domFinishedLoading)

    // The Hot sort only exists while the community surface is exposed.
    pickSort('Hot')
    await waitForDom(() => mocks.getCommunityRanking.mock.calls.length >= 1)
    expect(mocks.getCommunityRanking.mock.calls[0]?.[0]).not.toHaveProperty('tag')

    // CS: ranking tag matching is trim+NFC but case-sensitive — the 'ML'
    // chip must reach the API as 'ML', never 'ml'.
    pickTopic('ML')
    await waitForDom(() =>
      mocks.getCommunityRanking.mock.calls.some((call) => call[0]?.tag === 'ML'))
    const tagged = mocks.getCommunityRanking.mock.calls
      .map((call) => call[0])
      .filter((params): params is { tag: string } => params?.tag !== undefined)
    expect(tagged.every((params) => params.tag === 'ML')).toBe(true)
  })

  it('omits the Hot sort option when the community surface is disabled', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: false }
    renderExplore()
    await waitForDom(domFinishedLoading)

    const sortLabels = [...menuSelect('explore-sort').options].map((o) => o.textContent)
    expect(sortLabels).toEqual(['Recent', 'Popular', 'Most bookmarks'])
    // A persisted 'hot' selection cannot force the board either.
    expect(mocks.getCommunityRanking).not.toHaveBeenCalled()
  })

  it('ignores a persisted hot sort while the community surface is disabled', async () => {
    localStorage.setItem(SORT_KEY, 'hot')
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: false }
    renderExplore()
    await waitForDom(domFinishedLoading)

    // hotMode is flag-gated: the explore feed renders and no ranking
    // request ever fires.
    expect(document.querySelector('[aria-label="Community hot ranking"]')).toBeNull()
    expect(mocks.getCommunityRanking).not.toHaveBeenCalled()
    expect(mocks.getExploreCollections).toHaveBeenCalled()
  })


})

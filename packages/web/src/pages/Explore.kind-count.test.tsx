// @vitest-environment happy-dom
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from '../lib/routeCache'
import type { ExploreCollection } from '../api/types'
import { Explore } from './Explore'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  explore: false,
  getExploreCollections: vi.fn(),
  getPublicReportsPage: vi.fn(async () => ({ items: [], nextCursor: null })),
  getCommunityRanking: vi.fn(async () => ({ items: [], nextCursor: null, scoreVersion: 'hot-v1', asOf: null })),
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

/** Tab labels carry a trailing count — match on the label prefix. */
function kindButton(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="explore-kind"] button')]
    .find((button) => button.textContent?.trim().startsWith(label))!
}

describe('Explore kind counts', () => {
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

  it('shows no count, not "0+", on a kind tab with nothing loaded while more pages exist (R12-11)', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'LLM learning path', publicationSlug: 'llm-learning-path' })],
      nextCursor: 'cursor-page-2',
    })
    mountTree(<MemoryRouter><Explore /></MemoryRouter>)
    await waitForDom(domFinishedLoading)

    expect(kindButton('Collections').textContent?.trim()).toBe('Collections 1+')
    expect(kindButton('Paths').textContent?.trim()).toBe('Paths')
  })
})

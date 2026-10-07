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

describe('Explore url state', () => {

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

  function SearchSpy() {
    const { search } = useLocation()
    return <span data-testid="explore-search">{search}</span>
  }

  function renderExploreAt(path: string) {
    mountTree(
      <MemoryRouter initialEntries={[path]}>
        <Explore />
        <SearchSpy />
      </MemoryRouter>,
    )
  }

  it('hydrates kind, topic and language from the URL', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: true }
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'English collection', publicationSlug: 'english-collection', language: 'en' })],
      nextCursor: null,
    })
    renderExploreAt('/explore?kind=paths&topic=ML&lang=en')
    await waitForDom(domFinishedLoading)

    expect(kindButton('Paths').getAttribute('aria-selected')).toBe('true')
    expect(menuSelect('explore-topic').value).toBe('ML')
    expect(menuSelect('explore-language').value).toBe('en')
  })

  it('writes topic into the URL and Reset filters clears topic and lang', async () => {
    ;(window as { __KNOWN_FLAGS__?: { community?: boolean } }).__KNOWN_FLAGS__ = { community: true }
    mocks.getExploreCollections.mockResolvedValue({ items: [], nextCursor: null })
    renderExploreAt('/explore?lang=en')
    await waitForDom(domFinishedLoading)

    pickTopic('Design')
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="explore-search"]')?.textContent).toContain('topic=Design')

    act(() => {
      [...document.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.trim() === 'Reset filters')!
        .click()
    })
    const search = document.querySelector('[data-testid="explore-search"]')?.textContent ?? ''
    expect(search).not.toContain('topic=')
    expect(search).not.toContain('lang=')
  })

  it('keeps topic in the URL when switching kind', async () => {
    mocks.getExploreCollections.mockResolvedValue({
      items: [exploreItem({ title: 'Knowledge shelf', publicationSlug: 'knowledge-shelf' })],
      nextCursor: null,
    })
    renderExploreAt('/explore?topic=ML')
    await waitForDom(domFinishedLoading)

    act(() => { kindButton('Paths').click() })
    const search = document.querySelector('[data-testid="explore-search"]')?.textContent ?? ''
    expect(search).toContain('topic=ML')
    expect(search).toContain('kind=paths')
  })
})

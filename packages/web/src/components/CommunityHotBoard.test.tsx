// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { CommunityRankingItem, CommunityRankingPage } from '../api'
import { CommunityHotBoard } from './CommunityHotBoard'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getCommunityRanking: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

const NOW = '2026-10-02T00:00:00.000Z'

function item(id: string, over: Partial<CommunityRankingItem> = {}): CommunityRankingItem {
  return {
    target: { kind: 'collection', id, collectionId: null, seriesId: null, generation: 'static-v1' },
    title: `Title ${id}`,
    href: `/c/${id}`,
    up: 5,
    down: 1,
    hot: 1.25,
    firstVoteAt: NOW,
    ...over,
  }
}

function page(items: CommunityRankingItem[], nextCursor: string | null = null): CommunityRankingPage {
  return { items, nextCursor, asOf: NOW, scoreVersion: 'hot-v1' }
}

describe('CommunityHotBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getCommunityRanking.mockResolvedValue(page([item('a'), item('b')]))
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  function render(props: Parameters<typeof CommunityHotBoard>[0] = {}) {
    mountTree(
      <MemoryRouter initialEntries={['/explore']}>
        <CommunityHotBoard {...props} />
      </MemoryRouter>,
    )
  }

  it('renders nothing and never fetches when community exposure is off', async () => {
    window.__KNOWN_FLAGS__ = { community: false }
    render()
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="community-hot-board"]')).toBeNull()
    expect(mocks.getCommunityRanking).not.toHaveBeenCalled()
  })

  it('renders ranked items in server order with counts and scores', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    render()
    await waitForDom(() => document.querySelectorAll('[data-testid="community-hot-board-item"]').length === 2)
    expect(mocks.getCommunityRanking).toHaveBeenCalledWith(
      { limit: 24 }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const rows = document.querySelectorAll('[data-testid="community-hot-board-item"]')
    expect(rows[0]?.querySelector('[data-testid="community-hot-board-title"]')?.textContent).toBe('Title a')
    expect(rows[1]?.querySelector('[data-testid="community-hot-board-title"]')?.textContent).toBe('Title b')
    expect(rows[0]?.querySelector('[data-testid="community-hot-board-rank"]')?.textContent).toBe('1')
    expect(rows[0]?.querySelector('[data-testid="community-hot-board-score"]')?.textContent).toBe('1.25')
    const link = rows[0]?.querySelector<HTMLAnchorElement>('[data-testid="community-hot-board-title"]')
    expect(link?.getAttribute('href')).toBe('/c/a')
  })

  it('switches the kind filter and refetches the first page', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    render()
    await waitForDom(() => document.querySelectorAll('[data-testid="community-hot-board-item"]').length === 2)
    mocks.getCommunityRanking.mockResolvedValue(page([item('bm-1', {
      target: { kind: 'bookmark', id: 'bm-1', collectionId: 'a', seriesId: null, generation: 'bm-gen-1' },
    })]))
    const bookmarkOption = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="community-hot-board-kinds"] button'),
    ).find((button) => button.textContent === 'Bookmarks')
    expect(bookmarkOption).not.toBeUndefined()
    await act(async () => { bookmarkOption?.click() })
    await waitForDom(() =>
      document.querySelector('[data-testid="community-hot-board-title"]')?.textContent === 'Title bm-1')
    expect(mocks.getCommunityRanking).toHaveBeenLastCalledWith(
      { kind: 'bookmark', limit: 24 }, expect.anything())
  })

  it('load more sends the opaque cursor and appends in order', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    /* The board endpoint answers by cursor, so any number of mounts (StrictMode
       mounts, unmounts and re-mounts the board) reads the same first page. */
    mocks.getCommunityRanking.mockImplementation((query: { cursor?: string }) =>
      Promise.resolve(query.cursor ? page([item('c')]) : page([item('a'), item('b')], 'cursor-2')))
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-hot-board-more"]') !== null)
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="community-hot-board-more"]')?.click()
    })
    await waitForDom(() => document.querySelectorAll('[data-testid="community-hot-board-item"]').length === 3)
    expect(mocks.getCommunityRanking).toHaveBeenLastCalledWith(
      { limit: 24, cursor: 'cursor-2' }, expect.anything())
    const titles = Array.from(document.querySelectorAll('[data-testid="community-hot-board-title"]')).map((el) => el.textContent)
    expect(titles).toEqual(['Title a', 'Title b', 'Title c'])
    expect(document.querySelector('[data-testid="community-hot-board-more"]')).toBeNull()
  })

  it('restarts from the first page when the snapshot expires mid-pagination', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    /* Server state, not a call-order queue: the first page hands out a cursor
       that has expired; the un-cursored restart then sees the fresh snapshot.
       A StrictMode remount simply re-reads the same first page. */
    let cursorExpired = false
    mocks.getCommunityRanking.mockImplementation((query: { cursor?: string }) => {
      if (query.cursor) {
        cursorExpired = true
        return Promise.reject(new ProductApiError({
          status: 409, code: 'snapshot_expired', message: 'expired',
        }))
      }
      return Promise.resolve(cursorExpired ? page([item('a'), item('b')]) : page([item('a')], 'cursor-2'))
    })
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-hot-board-more"]') !== null)
    // Count only what this click causes: the cursor page, then the restart.
    const beforeClick = mocks.getCommunityRanking.mock.calls.length
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="community-hot-board-more"]')?.click()
    })
    await waitForDom(() => document.querySelectorAll('[data-testid="community-hot-board-item"]').length === 2)
    // Exactly two requests for one click: the cursor read and one un-cursored
    // restart — a restart loop or a dropped cursor both fail this.
    expect(mocks.getCommunityRanking.mock.calls.slice(beforeClick).map((call) => call[0]))
      .toEqual([{ limit: 24, cursor: 'cursor-2' }, { limit: 24 }])
  })

  it('forwards the host tag filter into the query', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    render({ tag: 'design' })
    await waitForDom(() => document.querySelectorAll('[data-testid="community-hot-board-item"]').length === 2)
    expect(mocks.getCommunityRanking).toHaveBeenCalledWith(
      { tag: 'design', limit: 24 }, expect.anything())
  })

  it('forwards the host language filter into the query', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    render({ language: 'en' })
    await waitForDom(() => document.querySelectorAll('[data-testid="community-hot-board-item"]').length === 2)
    expect(mocks.getCommunityRanking).toHaveBeenCalledWith(
      { language: 'en', limit: 24 }, expect.anything())
  })

  it('shows a retryable error state when the page fails', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.getCommunityRanking.mockRejectedValue(new Error('offline'))
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-hot-board-retry"]') !== null)
    /* The error is detail copy, not the heading: the alert carries a stable
       title and the hook's sentence in its body. */
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.querySelector('h3')?.textContent).toBe("Couldn't load the hot ranking")
    expect(alert?.textContent).toContain('Check your connection and try again.')
    mocks.getCommunityRanking.mockResolvedValue(page([item('a')]))
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="community-hot-board-retry"]')?.click()
    })
    await waitForDom(() => document.querySelectorAll('[data-testid="community-hot-board-item"]').length === 1)
  })

  it('renders the empty state when nothing is hot yet', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.getCommunityRanking.mockResolvedValue(page([]))
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-hot-board-empty"]') !== null)
    expect(document.querySelector('[data-testid="community-hot-board-empty"]')?.textContent)
      .toContain('Nothing is hot yet')
  })

  it('renders the unavailable state when the endpoint conceals the surface', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.getCommunityRanking.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'off' }))
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-hot-board"]')?.textContent
      ?.includes('not available yet') === true)
  })
})

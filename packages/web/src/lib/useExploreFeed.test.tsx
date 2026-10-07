// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExploreCollection, ExplorePage, PublicReportPage, PublicReportSeries } from '../api/types'
import { clearRouteCache } from './routeCache'
import { useExploreFeed, type ExploreFeedItem, type ExploreFeedSort } from './useExploreFeed'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getExploreCollections: vi.fn(),
  getPublicReportsPage: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    getExploreCollections: mocks.getExploreCollections,
    productClient: { ...actual.productClient, getPublicReportsPage: mocks.getPublicReportsPage },
  }
})

function card(id: string, updatedAt: string, viewCount = 0): ExploreCollection {
  return {
    id,
    title: id,
    summary: null,
    kind: 'knowledge_collection',
    tags: [],
    nodeCount: 1,
    updatedAt,
    viewCount,
    publicationSlug: id,
    visibility: 'public',
    creators: [{ id: 'p1', name: 'Lin', handle: 'lin', avatar: null }],
  }
}

function series(id: string, publishedAt: string, followerCount = 0): PublicReportSeries {
  return {
    id,
    title: id,
    summary: null,
    slug: id,
    visibility: 'public',
    indexable: true,
    updatedAt: publishedAt,
    followerCount,
    issues: [{ id: `${id}-issue`, title: id, summary: null, publishedAt, url: null }],
  }
}

function explorePage(items: ExploreCollection[], nextCursor: string | null): ExplorePage {
  return { items, nextCursor }
}

function reportPage(items: PublicReportSeries[], nextCursor: string | null): PublicReportPage {
  return { items, nextCursor }
}

function rowKey(item: ExploreFeedItem): string {
  return `${item.kind}:${item.payload.id}`
}

describe('useExploreFeed mixed window', () => {
  let current!: ReturnType<typeof useExploreFeed>

  function Probe({ sort = 'updated' as ExploreFeedSort }: { sort?: ExploreFeedSort }) {
    current = useExploreFeed({ sort, tag: 'All', includeDigests: true })
    return null
  }

  function mount() {
    mountTree(<Probe />)
  }

  function keys(): string[] {
    return current.items.map(rowKey)
  }

  beforeEach(() => {
    clearRouteCache()
    mocks.getExploreCollections.mockReset()
    mocks.getPublicReportsPage.mockReset()
    mocks.getExploreCollections.mockResolvedValue(explorePage([], null))
    mocks.getPublicReportsPage.mockResolvedValue(reportPage([], null))
    delete (window as { __KNOWN_FLAGS__?: unknown }).__KNOWN_FLAGS__
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    clearRouteCache()
    delete (window as { __KNOWN_FLAGS__?: unknown }).__KNOWN_FLAGS__
  })

  it('appends a higher sort key and an overlapping id without moving or dropping the prefix', async () => {
    /* June/March/February/January, then a December collection and a September
       digest. A global re-sort would put December and September in front of
       the June card. kind + id keeps collection:shared and digest:shared. */
    mocks.getExploreCollections.mockImplementation(async (params?: { cursor?: string }) => {
      if (params?.cursor === 'collections-2') {
        return explorePage([card('shared', '2026-01-01T00:00:00.000Z'), card('high', '2026-12-01T00:00:00.000Z')], null)
      }
      return explorePage([
        card('shared', '2026-01-01T00:00:00.000Z'),
        card('low', '2026-02-01T00:00:00.000Z'),
      ], 'collections-2')
    })
    const digestsPageTwo = reportPage([
      series('same', '2026-06-01T00:00:00.000Z'),
      series('late', '2026-09-01T00:00:00.000Z'),
    ], null)
    let releaseDigests: ((page: PublicReportPage) => void) | undefined
    mocks.getPublicReportsPage.mockImplementation((query?: { cursor?: string }) => {
      if (query?.cursor === 'digests-2') {
        return new Promise<PublicReportPage>((resolve) => { releaseDigests = resolve })
      }
      return Promise.resolve(reportPage([
        series('same', '2026-06-01T00:00:00.000Z'),
        series('mid', '2026-03-01T00:00:00.000Z'),
      ], 'digests-2'))
    })
    mount()
    const prefix = ['digest:same', 'digest:mid', 'collection:low', 'collection:shared']
    await waitForDom(() => keys().join() === prefix.join())
    expect(current.error).toBeNull()

    act(() => { current.loadMore() })
    await waitForDom(() => keys().at(-1) === 'collection:high')
    expect(keys()).toEqual([...prefix, 'collection:high'])

    await act(async () => { releaseDigests?.(digestsPageTwo) })
    await waitForDom(() => keys().includes('digest:late'))
    expect(keys()).toEqual([...prefix, 'collection:high', 'digest:late'])
    expect(new Set(keys()).size).toBe(keys().length)
  })

  it('keeps the prefix when the collection page fails and the digest page arrives', async () => {
    mocks.getExploreCollections.mockImplementation(async (params?: { cursor?: string }) => {
      if (params?.cursor === 'collections-2') throw new Error('collections down')
      return explorePage([card('a', '2026-01-01T00:00:00.000Z')], 'collections-2')
    })
    mocks.getPublicReportsPage.mockImplementation(async (query?: { cursor?: string }) => {
      if (query?.cursor === 'digests-2') {
        return reportPage([
          series('d', '2026-06-01T00:00:00.000Z'),
          series('g', '2026-03-01T00:00:00.000Z'),
        ], null)
      }
      return reportPage([series('d', '2026-06-01T00:00:00.000Z')], 'digests-2')
    })
    mount()
    await waitForDom(() => keys().join() === 'digest:d,collection:a')
    act(() => { current.loadMore() })
    await waitForDom(() => current.error != null && keys().includes('digest:g') && !current.loadingMore)
    // March sits between June and January. It stays on the tail.
    expect(keys()).toEqual(['digest:d', 'collection:a', 'digest:g'])
    expect(current.error).toBe("Couldn't load collections")
  })

  it('keeps the prefix when the digest page fails and the collection page arrives', async () => {
    mocks.getExploreCollections.mockImplementation(async (params?: { cursor?: string }) => {
      if (params?.cursor === 'collections-2') {
        return explorePage([
          card('a', '2026-01-01T00:00:00.000Z'),
          card('b', '2026-12-01T00:00:00.000Z'),
        ], null)
      }
      return explorePage([card('a', '2026-01-01T00:00:00.000Z')], 'collections-2')
    })
    mocks.getPublicReportsPage.mockImplementation(async (query?: { cursor?: string }) => {
      if (query?.cursor === 'digests-2') throw new Error('digests down')
      return reportPage([series('d', '2026-06-01T00:00:00.000Z')], 'digests-2')
    })
    mount()
    await waitForDom(() => keys().join() === 'digest:d,collection:a')
    act(() => { current.loadMore() })
    await waitForDom(() => keys().includes('collection:b') && !current.loadingMore)
    // December is newer than June and must not take the first slot.
    expect(keys()).toEqual(['digest:d', 'collection:a', 'collection:b'])
    expect(current.error).toBeNull()
    expect(keys().filter((key) => key === 'digest:d')).toEqual(['digest:d'])
  })

  it('advances each source once when load more is clicked twice', async () => {
    let exploreMore!: (page: ExplorePage) => void
    let digestMore!: (page: PublicReportPage) => void
    mocks.getExploreCollections.mockImplementation((params?: { cursor?: string }) => {
      if (params?.cursor === 'collections-2') {
        return new Promise<ExplorePage>((resolve) => { exploreMore = resolve })
      }
      return Promise.resolve(explorePage([card('a', '2026-01-01T00:00:00.000Z')], 'collections-2'))
    })
    mocks.getPublicReportsPage.mockImplementation((query?: { cursor?: string }) => {
      if (query?.cursor === 'digests-2') {
        return new Promise<PublicReportPage>((resolve) => { digestMore = resolve })
      }
      return Promise.resolve(reportPage([series('d', '2026-06-01T00:00:00.000Z')], 'digests-2'))
    })
    mount()
    await waitForDom(() => keys().join() === 'digest:d,collection:a')
    const exploreBefore = mocks.getExploreCollections.mock.calls.length
    const digestBefore = mocks.getPublicReportsPage.mock.calls.length
    act(() => { current.loadMore(); current.loadMore() })
    const exploreCursorCalls = mocks.getExploreCollections.mock.calls.slice(exploreBefore)
      .filter((call) => (call[0] as { cursor?: string } | undefined)?.cursor === 'collections-2')
    const digestCursorCalls = mocks.getPublicReportsPage.mock.calls.slice(digestBefore)
      .filter((call) => (call[0] as { cursor?: string } | undefined)?.cursor === 'digests-2')
    expect(exploreCursorCalls).toHaveLength(1)
    expect(digestCursorCalls).toHaveLength(1)
    await act(async () => {
      exploreMore(explorePage([card('a', '2026-01-01T00:00:00.000Z'), card('b', '2026-12-01T00:00:00.000Z')], null))
      digestMore(reportPage([series('d', '2026-06-01T00:00:00.000Z'), series('g', '2026-03-01T00:00:00.000Z')], null))
    })
    await waitForDom(() => keys().includes('collection:b') && keys().includes('digest:g'))
    expect(keys().slice(0, 2)).toEqual(['digest:d', 'collection:a'])
    expect(new Set(keys())).toEqual(new Set(['digest:d', 'collection:a', 'collection:b', 'digest:g']))
    expect(keys().filter((key) => key === 'collection:a' || key === 'digest:d')).toEqual(['digest:d', 'collection:a'])
  })

  it('reorders the loaded window when the sort board changes', async () => {
    /* Popular reads each source's own count. It is not a shared backend
       comparator with updated time, and the sort switch may reorder. */
    mocks.getExploreCollections.mockResolvedValue(explorePage([
      card('a', '2026-01-01T00:00:00.000Z', 50),
    ], null))
    mocks.getPublicReportsPage.mockResolvedValue(reportPage([
      series('d', '2026-06-01T00:00:00.000Z', 1),
    ], null))
    mount()
    await waitForDom(() => keys().join() === 'digest:d,collection:a')
    mountTree(<Probe sort="popular" />)
    await waitForDom(() => keys().join() === 'collection:a,digest:d')
    expect(keys()).toEqual(['collection:a', 'digest:d'])
  })

  it('may reorder the loaded window on an explicit refresh', async () => {
    /* Refresh restarts the collection cursor at page 1, so the later page is
       outside the window that is allowed to reorder. updatedAt here is only
       the local window key, not a shared followers/views or issues/links comparator. */
    let refreshed = false
    mocks.getExploreCollections.mockImplementation(async (params?: { cursor?: string }) => {
      if (params?.cursor === 'collections-2') {
        return explorePage([card('b', '2026-08-01T00:00:00.000Z')], null)
      }
      if (refreshed) return explorePage([card('a', '2026-12-01T00:00:00.000Z')], null)
      return explorePage([card('a', '2026-01-01T00:00:00.000Z')], 'collections-2')
    })
    mocks.getPublicReportsPage.mockResolvedValue(reportPage([series('d', '2026-06-01T00:00:00.000Z')], null))
    mount()
    await waitForDom(() => keys().join() === 'digest:d,collection:a')
    act(() => { current.loadMore() })
    await waitForDom(() => keys().join() === 'digest:d,collection:a,collection:b')
    refreshed = true
    act(() => { current.reload() })
    await waitForDom(() => keys()[0] === 'collection:a')
    expect(keys()).toEqual(['collection:a', 'digest:d'])
  })

  it('keeps shown digests when a later directory read fails', async () => {
    let reportsUp = true
    mocks.getExploreCollections.mockResolvedValue(explorePage([card('a', '2026-01-01T00:00:00.000Z')], null))
    mocks.getPublicReportsPage.mockImplementation(async () => {
      if (!reportsUp) throw new Error('reports down')
      return reportPage([series('d', '2026-06-01T00:00:00.000Z')], null)
    })
    mount()
    await waitForDom(() => keys().includes('digest:d') && keys().includes('collection:a'))
    const callsBefore = mocks.getPublicReportsPage.mock.calls.length
    reportsUp = false
    cleanup()
    mount()
    await waitForDom(() => mocks.getPublicReportsPage.mock.calls.length > callsBefore && !current.loading)
    expect(keys()).toContain('digest:d')
    expect(keys()).toContain('collection:a')
    expect(new Set(keys()).size).toBe(keys().length)
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRouteCache } from './routeCache'
import { useNotificationCenter } from './useNotificationCenter'
import { useProductFeed } from './useProductFeed'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

/**
 * React Router unmounts a page component on every navigation away from it, so
 * /feed and /notifications remounted cold on the way back and replayed their
 * skeletons for a stream that was on screen a second earlier. TopNav even kept
 * showing the unread badge the whole time.
 */

const mocks = vi.hoisted(() => ({ feed: vi.fn(), inbox: vi.fn(), preference: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      getFeedPage: mocks.feed,
      getNotificationPage: mocks.inbox,
      getNotificationPreference: mocks.preference,
    },
  }
})

const feedItem = (id: string) => ({
  feedItemId: id, kind: 'collection_published' as const, createdAt: '2026-08-20T00:00:00Z',
  actor: { profileId: 'p1', handle: 'ada', displayName: 'Ada', avatarUrl: null },
  subject: { collectionId: 'c1', slug: 'c1', title: 'Shelf' },
})
const inboxItem = (id: string) => ({
  notificationId: id, kind: 'collection_published' as const, state: 'unread' as const,
  createdAt: '2026-08-20T00:00:00Z', readAt: null,
  actor: { profileId: 'p1', handle: 'ada', displayName: 'Ada', avatarUrl: null },
  subject: { collectionId: 'c1', slug: 'c1', title: 'Shelf' },
})

describe('stream hooks survive a route round trip', () => {
  const seen: Array<{ count: number; state: string }> = []

  function FeedHarness() {
    const stream = useProductFeed({ enabled: true, limit: 20 })
    seen.push({ count: stream.items.length, state: stream.state })
    return <div data-testid="stream" data-count={stream.items.length} data-state={stream.state} />
  }

  function InboxHarness() {
    const stream = useNotificationCenter({ enabled: true, limit: 20 })
    seen.push({ count: stream.items.length, state: stream.state })
    return <div data-testid="stream" data-count={stream.items.length} data-state={stream.state} />
  }

  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    seen.length = 0
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    // mockReset, not clearAllMocks: a `…Once` queue left by another case would
    // otherwise fire on this one's first load.
    mocks.feed.mockReset().mockResolvedValue({ items: [feedItem('f-1')], nextCursor: null })
    mocks.inbox.mockReset().mockResolvedValue({ items: [inboxItem('n-1')], unreadCount: 1, nextCursor: null })
    mocks.preference.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
    clearRouteCache()
    document.body.innerHTML = ''
  })

  function mount(hook: 'feed' | 'inbox') {
    mountTree(hook === 'feed' ? <FeedHarness /> : <InboxHarness />)
  }

  it.each(['feed', 'inbox'] as const)('%s paints from cache on the first frame after a remount', async (hook) => {
    mount(hook)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="stream"]')?.getAttribute('data-count')).toBe('1')

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    const settled = seen.length
    mount(hook)

    // No settle(): the stream is there immediately and never reports loading.
    expect(document.querySelector('[data-testid="stream"]')?.getAttribute('data-count')).toBe('1')
    expect(seen.slice(settled).every(({ count }) => count === 1)).toBe(true)
    expect(seen.slice(settled).every(({ state }) => state !== 'loading')).toBe(true)
    await waitForDom(domFinishedLoading)
  })

  it.each(['feed', 'inbox'] as const)('%s keeps its rows when the revalidation fails', async (hook) => {
    mount(hook)
    await waitForDom(domFinishedLoading)

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    const offline = mocks[hook === 'feed' ? 'feed' : 'inbox']
    offline.mockRejectedValueOnce(new Error('offline'))
    mount(hook)
    await waitForDom(domFinishedLoading)

    const stream = document.querySelector('[data-testid="stream"]')
    expect(stream?.getAttribute('data-count')).toBe('1')
    expect(stream?.getAttribute('data-state')).not.toBe('error')
  })
})

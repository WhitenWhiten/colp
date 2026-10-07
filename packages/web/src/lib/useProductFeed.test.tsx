// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession, getSessionSnapshot } from '../api/sessionStore'
import { clearRouteCache, readRouteCache } from './routeCache'
import type { FeedPage } from '../api/types'
import { useProductFeed } from './useProductFeed'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ feed: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, getFeedPage: mocks.feed } }
})
const actor = { profileId: 'p1', handle: 'mira', displayName: 'Mira', avatarUrl: null }
const item = (id: string) => ({ feedItemId: id, kind: 'collection_change' as const, collectionId: `c-${id}`, actor, publishedAt: '2026-07-29T08:00:00.000Z' })
const page = (ids: string[], nextCursor: string | null = null): FeedPage => ({ items: ids.map(item), nextCursor })
describe('useProductFeed', () => {
  let current!: ReturnType<typeof useProductFeed>
  function Probe({ enabled = true }: { enabled?: boolean }) { current = useProductFeed({ enabled, limit: 2 }); return null }
  function render(enabled = true) { mountTree(<Probe enabled={enabled} />) }
  beforeEach(() => { vi.clearAllMocks(); clearRouteCache(); clearSession(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })

  it('is inert while the rollout flag is off', async () => {
    render(false); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    expect(current.state).toBe('flag-off')
    expect(mocks.feed).not.toHaveBeenCalled()
  })

  it('loads, paginates, and retries the exact failed page without mock data', async () => {
    /* The endpoint is described by cursor, not by call order: a StrictMode
       remount re-issues the first page, and that must be the same response. */
    const pages = new Map<string, FeedPage>([
      ['first', page(['one'], 'cursor-2')],
      ['cursor-2', page(['two'])],
    ])
    mocks.feed.mockImplementation((query: { cursor?: string }) => Promise.resolve(pages.get(query.cursor ?? 'first')!))
    render(); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    expect(current.items.map((value) => value.feedItemId)).toEqual(['one'])
    /* Only the first attempt at the next page fails; the retry must succeed. */
    mocks.feed.mockRejectedValueOnce(new Error('network down'))
    act(() => current.loadMore()); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    expect(current.state).toBe('error')
    act(() => current.retry()); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    expect(mocks.feed).toHaveBeenLastCalledWith({ cursor: 'cursor-2' }, expect.objectContaining({ maxRetries: 0 }))
    expect(current.items.map((value) => value.feedItemId)).toEqual(['one', 'two'])
  })

  it('holds newly discovered first-page items until the user reveals them', async () => {
    /* First page mirrors the server: it gains a row between the initial load
       and the "check for new items" probe. Any number of remounts sees the
       same first page. */
    let firstPage = page(['old'], 'older')
    mocks.feed.mockImplementation(() => Promise.resolve(firstPage))
    render(); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    firstPage = page(['new', 'old'], 'older')
    act(() => current.checkForNewItems()); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    expect(current.items.map((value) => value.feedItemId)).toEqual(['old'])
    expect(current.newItems.map((value) => value.feedItemId)).toEqual(['new'])
    act(() => current.showNewItems())
    expect(current.items.map((value) => value.feedItemId)).toEqual(['new', 'old'])
  })

  it('refreshes from page one and clears stale pagination after authorization changes', async () => {
    /* The refresh re-reads the same first-page endpoint; the mock reflects what
       the server now returns rather than which call is being made. */
    let firstPage = page(['visible'], 'private-cursor')
    mocks.feed.mockImplementation(() => Promise.resolve(firstPage))
    render(); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    firstPage = page([])
    act(() => current.refresh()); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more' && current.state !== 'checking')
    expect(current.state).toBe('empty')
    expect(current.items).toEqual([])
    expect(current.hasMore).toBe(false)
  })

  function account(accountId: string) {
    return {
      account: { id: accountId, email: `${accountId}@test` },
      profile: { id: `profile-${accountId}`, handle: accountId, displayName: accountId, avatarUrl: null },
    }
  }
  function signIn(accountId: string) {
    applySessionView({
      authenticated: true, csrfToken: 'csrf',
      idleExpiresAt: '2026-07-25T01:00:00Z', absoluteExpiresAt: '2026-07-26T00:00:00Z',
    })
    applyMeView(account(accountId))
  }

  it('aborts the in-flight read when the page unmounts', async () => {
    const signals: AbortSignal[] = []
    mocks.feed.mockImplementation((_query: unknown, options: { signal?: AbortSignal }) => {
      signals.push(options.signal!)
      return new Promise<FeedPage>(() => {})
    })
    render()
    await waitForDom(() => signals.length > 0)
    cleanup()
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('clears the previous account when the session disappears and a failed reread cannot restore it', async () => {
    signIn('account-a')
    let rejectAnon: ((reason: unknown) => void) | undefined
    mocks.feed.mockImplementation(() => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      if (signedIn === 'anonymous') return new Promise<FeedPage>((_resolve, reject) => { rejectAnon = reject })
      return Promise.resolve(page(['a-item']))
    })
    render()
    await waitForDom(() => current.items.some((item) => item.feedItemId === 'a-item'))
    await act(async () => { clearSession() })
    expect(current.items.map((item) => item.feedItemId)).not.toContain('a-item')
    await act(async () => { rejectAnon?.(new Error('offline')); await Promise.resolve(); await Promise.resolve() })
    expect(current.items).toEqual([])
    expect(current.state).toBe('error')
    expect(readRouteCache<{ items: { feedItemId: string }[] }>('feed:all')).toBeUndefined()
  })

  it('shows the account now signed in and ignores a late response from the previous one', async () => {
    signIn('account-a')
    const releaseA: Array<(value: FeedPage) => void> = []
    mocks.feed.mockImplementation(() => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      if (signedIn === 'account-b') return Promise.resolve(page(['b-item']))
      return new Promise<FeedPage>((resolve) => { releaseA.push(resolve) })
    })
    render()
    await waitForDom(() => releaseA.length > 0)
    const stale = mocks.feed.mock.calls.at(-1)![1].signal as AbortSignal
    await act(async () => { applyMeView(account('account-b')) })
    expect(stale.aborted).toBe(true)
    await waitForDom(() => current.items.some((item) => item.feedItemId === 'b-item'))
    expect(current.items.map((item) => item.feedItemId)).toEqual(['b-item'])
    await act(async () => {
      for (const release of releaseA) release(page(['a-item']))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(current.items.map((item) => item.feedItemId)).toEqual(['b-item'])
    expect(readRouteCache<{ items: { feedItemId: string }[] }>('feed:all')?.items.map((item) => item.feedItemId)).toEqual(['b-item'])
  })
})

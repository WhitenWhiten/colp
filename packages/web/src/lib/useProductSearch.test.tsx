// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession, getSessionSnapshot } from '../api/sessionStore'
import type { SearchPage } from '../api/types'
import { clearRouteCache, readRouteCache } from './routeCache'
import { useProductSearch } from './useProductSearch'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ search: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, searchResources: mocks.search } }
})

function searchPage(id: string): SearchPage {
  return {
    query: 'libraries',
    types: ['collection'],
    items: [{ resourceType: 'collection', resourceId: id, title: id, snippet: 'snippet', rank: 0.5 }],
    page: { returnedCount: 1, hasMore: false, nextCursor: null },
    consistency: { authority: 'recheck-each-page', ranking: 'restart-on-mutation' },
  }
}

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

describe('useProductSearch session identity', () => {
  let current!: ReturnType<typeof useProductSearch>
  function Probe({ query }: { query: string }) {
    current = useProductSearch({ query, types: ['collection'], limit: 12, debounceMs: 0 })
    return null
  }
  function render(query = 'libraries') { mountTree(<Probe query={query} />) }

  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    clearSession()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })

  it('still searches when nobody is signed in', async () => {
    mocks.search.mockResolvedValue(searchPage('public-hit'))
    render()
    await waitForDom(() => current.items.some((item) => item.resourceId === 'public-hit'))
    expect(mocks.search).toHaveBeenCalled()
    expect(current.items.map((item) => item.resourceId)).toEqual(['public-hit'])
    expect(current.state).toBe('ready')
  })

  it('searches again as the signed-out reader after the session disappears', async () => {
    signIn('account-a')
    mocks.search.mockImplementation(() => Promise.resolve(searchPage(getSessionSnapshot().me?.account.id ?? 'public-hit')))
    render()
    await waitForDom(() => current.items.some((item) => item.resourceId === 'account-a'))
    await act(async () => { clearSession() })
    expect(current.items.map((item) => item.resourceId)).not.toContain('account-a')
    await waitForDom(() => current.items.some((item) => item.resourceId === 'public-hit'))
    expect(current.items.map((item) => item.resourceId)).toEqual(['public-hit'])
    expect(mocks.search.mock.calls.length).toBeGreaterThan(1)
  })

  it('drops the previous account when a signed-out reread fails', async () => {
    signIn('account-a')
    let rejectAnon: ((reason: unknown) => void) | undefined
    mocks.search.mockImplementation(() => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      if (signedIn === 'anonymous') return new Promise<SearchPage>((_resolve, reject) => { rejectAnon = reject })
      return Promise.resolve(searchPage('account-a'))
    })
    render()
    await waitForDom(() => current.items.some((item) => item.resourceId === 'account-a'))
    await act(async () => { clearSession() })
    expect(current.items.map((item) => item.resourceId)).not.toContain('account-a')
    await waitForDom(() => rejectAnon !== undefined)
    await act(async () => { rejectAnon?.(new Error('offline')); await Promise.resolve(); await Promise.resolve() })
    expect(current.items).toEqual([])
    expect(current.state).toBe('error')
    expect(readRouteCache<{ items: { resourceId: string }[] }>('search:collection:libraries')).toBeUndefined()
  })

  it('shows the account now signed in and ignores a late response from the previous one', async () => {
    signIn('account-a')
    const releaseA: Array<(value: SearchPage) => void> = []
    mocks.search.mockImplementation(() => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      if (signedIn === 'account-b') return Promise.resolve(searchPage('account-b'))
      return new Promise<SearchPage>((resolve) => { releaseA.push(resolve) })
    })
    render()
    await waitForDom(() => releaseA.length > 0)
    const stale = mocks.search.mock.calls.at(-1)![1].signal as AbortSignal
    await act(async () => { applyMeView(account('account-b')) })
    expect(stale.aborted).toBe(true)
    await waitForDom(() => current.items.some((item) => item.resourceId === 'account-b'))
    expect(current.items.map((item) => item.resourceId)).toEqual(['account-b'])
    await act(async () => {
      for (const release of releaseA) release(searchPage('account-a'))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(current.items.map((item) => item.resourceId)).toEqual(['account-b'])
    expect(readRouteCache<{ items: { resourceId: string }[] }>('search:collection:libraries')?.items.map((item) => item.resourceId)).toEqual(['account-b'])
  })

  it('aborts the in-flight read when the page unmounts', async () => {
    const signals: AbortSignal[] = []
    mocks.search.mockImplementation((_query: unknown, options: { signal?: AbortSignal }) => {
      signals.push(options.signal!)
      return new Promise<SearchPage>(() => {})
    })
    render()
    await waitForDom(() => signals.length > 0)
    cleanup()
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })
})

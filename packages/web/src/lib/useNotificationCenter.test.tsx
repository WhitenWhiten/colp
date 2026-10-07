// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotificationInboxPage, NotificationPreference } from '@known/product-v1-client'
import { applyMeView, applySessionView, clearSession, getSessionSnapshot } from '../api/sessionStore'
import { useNotificationCenter } from './useNotificationCenter'
import { clearRouteCache, readRouteCache } from './routeCache'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({ page: vi.fn(), markOne: vi.fn(), markMany: vi.fn(), preference: vi.fn(), updatePreference: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient,
    getNotificationPage: mocks.page, markNotificationRead: mocks.markOne,
    markNotificationsRead: mocks.markMany, getNotificationPreference: mocks.preference,
    updateNotificationPreference: mocks.updatePreference,
  } }
})
const item = (id: string, state: 'read' | 'unread' = 'unread') => ({
  notificationId: id, notificationType: 'follow_activity' as const, actorProfileId: `p-${id}`,
  subject: { type: 'profile' as const, id: `p-${id}` }, state, stateRevision: '1',
  readAt: state === 'read' ? '2026-07-29T08:01:00.000Z' : null,
  occurredAt: '2026-07-29T08:00:00.000Z',
})
const page = (ids: string[], nextCursor: string | null = null, unreadCount = ids.length): NotificationInboxPage => ({ items: ids.map((id) => item(id)), nextCursor, unreadCount })
const emailStatus = { enabled: false, revision: '0', updatedAt: '2026-07-29T00:00:00.000Z', verifiedSender: 'no-reply@example.test', emailSuppressed: false, emailAvailable: true }
const preference: NotificationPreference = { channel: 'in_app', enabled: true, revision: '2', updatedAt: '2026-07-29T00:00:00.000Z', email: emailStatus }
/* StrictMode mounts every effect twice (setup -> cleanup -> setup): the mount
   read pair runs once and its first result is aborted, so fixtures below
   describe the endpoint's state rather than a call sequence, and read counts
   are asserted relative to what the mount already consumed. */
describe('useNotificationCenter', () => {
  let current!: ReturnType<typeof useNotificationCenter>
  function Probe({ enabled = true }: { enabled?: boolean }) { current = useNotificationCenter({ enabled, limit: 2, includePreference: true }); return null }
  function render(enabled = true) { mountTree(<Probe enabled={enabled} />) }
  beforeEach(() => {
    vi.clearAllMocks()
    /* The hook restores its last painted inbox from the module-scoped route
       cache, which would otherwise leak one test's rows (and preference
       revision) into the next test's first frame. */
    clearRouteCache()
    clearSession()
    mocks.page.mockResolvedValue(page(['one'], null, 11)); mocks.preference.mockResolvedValue(preference)
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })

  it('is inert when flag off and loads page plus preference when on', async () => {
    render(false); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more'); expect(current.state).toBe('flag-off'); expect(mocks.page).not.toHaveBeenCalled()
    mountTree(<Probe enabled />); await waitForDom(() => current != null && current.items.length > 0)
    expect(current.items.map((value) => value.notificationId)).toEqual(['one'])
    expect(current.unreadCount).toBe(11)
    expect(current.preference?.enabled).toBe(true)
    expect(current.preference?.email?.emailAvailable).toBe(true)
  })

  it('paginates stably, deduplicates, rejects cursor loops, and refreshes authority from page one', async () => {
    const secondPage = page(['two', 'three'], 'cursor-2', 10)
    /* Endpoint state keyed on the request: page one unless a cursor is given,
       and the cursor is echoed straight back (the loop the client must reject),
       so both StrictMode mount reads see the same first page. */
    let pageOne = page(['one', 'two'], 'cursor-2', 9)
    mocks.page.mockReset().mockImplementation(async (query: { cursor?: string }) => (query.cursor === undefined ? pageOne : secondPage))
    render(); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    act(() => current.loadMore()); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    expect(current.items.map((value) => value.notificationId)).toEqual(['one', 'two', 'three'])
    expect(current.hasMore).toBe(false)
    expect(current.unreadCount).toBe(10)
    /* A refresh re-reads page one (no cursor) and replaces the merged rows. */
    pageOne = page(['fresh'], null, 4)
    act(() => current.refresh()); await waitForDom(() => current != null && current.items.some((value) => value.notificationId === 'fresh'))
    expect(mocks.page).toHaveBeenLastCalledWith({ state: 'all', limit: 2 }, expect.objectContaining({ maxRetries: 0 }))
    expect(current.items.map((value) => value.notificationId)).toEqual(['fresh'])
  })

  it('readmits a notification that left the shifted page window without repeating ones on screen', async () => {
    /* Endpoint state: page two overlaps page one, then a refresh pulls the
       window forward so 'one'/'two' leave the list, and the next cursor hands
       'two' back. The dedupe is "already on screen", not "ever seen": the page
       walk is only complete if every page it advanced past is shown, and a
       notification remembered past its own row would silently vanish. */
    let pageOne = page(['one', 'two'], 'cursor-1', 9)
    const byCursor: Record<string, NotificationInboxPage> = {
      'cursor-1': page(['two', 'three'], 'cursor-2', 9),
      'cursor-3': page(['two'], null, 9),
    }
    mocks.page.mockReset().mockImplementation(async (query: { cursor?: string }) => (
      query.cursor === undefined ? pageOne : byCursor[query.cursor] ?? page([], null, 9)
    ))
    render(); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    act(() => current.loadMore()); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    expect(current.items.map((value) => value.notificationId)).toEqual(['one', 'two', 'three'])
    pageOne = page(['three'], 'cursor-3', 9)
    act(() => current.refresh()); await waitForDom(() => current != null && current.items.map((value) => value.notificationId).join() === 'three')
    act(() => current.loadMore()); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    expect(current.items.map((value) => value.notificationId)).toEqual(['three', 'two'])
  })

  it('preserves authority on failures and recovers reads without optimistic state', async () => {
    /* The first mark dies in transport; the exact retry is the one that lands. */
    mocks.markOne.mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ kind: 'succeeded', outcome: 'marked', notificationId: 'one', state: 'read', stateRevision: '2', readAt: '2026-07-29T08:02:00.000Z', changed: true })
    render(); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more'); const readsAfterMount = mocks.page.mock.calls.length
    act(() => current.markOne('one')); await waitForDom(() => current != null && current.mutationError !== null)
    expect(current.items[0]?.state).toBe('unread'); expect(current.mutationError).not.toBeNull()
    act(() => current.retryMutation()); await waitForDom(() => current != null && current.mutationError === null && current.pending === null)
    expect(mocks.markOne.mock.calls[1]?.[2].intentId).toBe(mocks.markOne.mock.calls[0]?.[2].intentId)
    /* The recovered mutation refreshes authority exactly once; the mount's own
       reads are already counted, so a retry loop would push this above 1. */
    expect(mocks.page.mock.calls.length - readsAfterMount).toBe(1)
  })

  it('uses bounded visible unread IDs for bulk and refreshes authoritative count', async () => {
    /* Endpoint state: page one holds two unread rows until the bulk mark lands,
       after which the authoritative count is 18 and nothing is unread. */
    let rows = page(['one', 'two'], null, 20)
    mocks.page.mockReset().mockImplementation(async () => rows)
    mocks.markMany.mockReset().mockImplementation(async () => {
      rows = page([], null, 18)
      return { kind: 'succeeded', requestedCount: 2, markedCount: 2 }
    })
    render(); await waitForDom(() => current != null && current.unreadCount === 20)
    act(() => current.markVisibleRead()); await waitForDom(() => current != null && current.unreadCount === 18)
    expect(mocks.markMany).toHaveBeenCalledWith(['one', 'two'], expect.objectContaining({ intentId: expect.any(String), maxRetries: 0 }))
    expect(current.unreadCount).toBe(18)
  })

  it('sets and resets in-app preference with revisions, retaining authority on failure', async () => {
    /* Endpoint state: in-app is enabled at revision 2 until the set lands. The
       reset never reaches the server, so authority stays disabled. */
    let server: NotificationPreference = preference
    mocks.preference.mockReset().mockImplementation(async () => server)
    mocks.updatePreference.mockReset()
      .mockImplementationOnce(async () => {
        server = { ...preference, enabled: false, revision: '3' }
        return { kind: 'succeeded', channel: 'in_app', enabled: false, revision: '3', updatedAt: '2026-07-29T01:00:00.000Z', changed: true }
      })
      .mockRejectedValue(new Error('offline'))
    render(); await waitForDom(() => current != null && current.preference?.revision === '2')
    act(() => current.setPreference(false)); await waitForDom(() => current != null && current.preference?.enabled === false)
    expect(mocks.updatePreference).toHaveBeenCalledWith('in_app', { mode: 'set', enabled: false }, '2', expect.objectContaining({ maxRetries: 0 }))
    expect(current.preference?.enabled).toBe(false)
    act(() => current.resetPreference()); await waitForDom(() => current != null && current.mutationError !== null)
    expect(current.preference?.enabled).toBe(false); expect(current.mutationError).not.toBeNull()
  })

  it('sets and resets the independent email channel with its own revision and keeps in-app authority', async () => {
    /* Endpoint state: the email channel walks revision 0 -> 1 -> 2 while the
       in-app channel stays enabled at revision 2 throughout. */
    let server: NotificationPreference = preference
    mocks.preference.mockReset().mockImplementation(async () => server)
    mocks.updatePreference.mockReset()
      .mockImplementationOnce(async () => {
        server = { ...preference, email: { ...emailStatus, enabled: true, revision: '1' } }
        return { kind: 'succeeded', channel: 'email', enabled: true, revision: '1', updatedAt: '2026-07-29T01:00:00.000Z', changed: true }
      })
      .mockImplementationOnce(async () => {
        server = { ...preference, email: { ...emailStatus, enabled: false, revision: '2' } }
        return { kind: 'succeeded', channel: 'email', enabled: false, revision: '2', updatedAt: '2026-07-29T02:00:00.000Z', changed: true }
      })
    render(); await waitForDom(() => current != null && current.preference?.email?.revision === '0')
    act(() => current.setEmailPreference(true)); await waitForDom(() => current != null && current.preference?.email?.enabled === true)
    expect(mocks.updatePreference).toHaveBeenCalledWith('email', { mode: 'set', enabled: true }, '0', expect.objectContaining({ maxRetries: 0 }))
    expect(current.preference?.email?.enabled).toBe(true)
    expect(current.preference?.email?.revision).toBe('1')
    expect(current.preference?.enabled).toBe(true)
    act(() => current.resetEmailPreference()); await waitForDom(() => current != null && current.preference?.email?.revision === '2')
    expect(mocks.updatePreference).toHaveBeenCalledWith('email', { mode: 'reset' }, '1', expect.objectContaining({ maxRetries: 0 }))
    expect(current.preference?.email?.enabled).toBe(false)
    expect(current.preference?.email?.revision).toBe('2')
    expect(current.preference?.enabled).toBe(true)
  })

  it('email preference failure retains authority and exact retry reuses the same command id', async () => {
    /* Endpoint state: email is off until a write succeeds; the first write dies
       in transport, so the retry is the one that turns it on. */
    let emailEnabled = false
    mocks.preference.mockReset().mockImplementation(async () => (
      emailEnabled ? { ...preference, email: { ...emailStatus, enabled: true, revision: '1' } } : preference
    ))
    mocks.updatePreference.mockReset()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => {
        emailEnabled = true
        return { kind: 'succeeded', channel: 'email', enabled: true, revision: '1', updatedAt: '2026-07-29T01:00:00.000Z', changed: true }
      })
    render(); await waitForDom(() => current != null && current.preference?.email?.enabled === false)
    act(() => current.setEmailPreference(true)); await waitForDom(() => current != null && current.mutationError !== null)
    expect(current.preference?.email?.enabled).toBe(false)
    expect(current.mutationError).not.toBeNull()
    act(() => current.retryMutation()); await waitForDom(() => current != null && current.preference?.email?.enabled === true)
    expect(mocks.updatePreference.mock.calls[1]?.[2]).toBe(mocks.updatePreference.mock.calls[0]?.[2])
    expect(mocks.updatePreference.mock.calls[1]?.[3]?.intentId).toBe(mocks.updatePreference.mock.calls[0]?.[3]?.intentId)
    expect(current.preference?.email?.enabled).toBe(true)
    expect(current.mutationError).toBeNull()
  })

  it('refreshes on versioned low-sensitivity tab messages, focus, visibility, and reconnect with cleanup and throttling', async () => {
    const channels: FakeChannel[] = []; class FakeChannel { onmessage: ((event: MessageEvent) => void) | null = null; close = vi.fn(); postMessage = vi.fn(); constructor(public name: string) { channels.push(this) } }
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    const addWindow = vi.spyOn(window, 'addEventListener'); const removeWindow = vi.spyOn(window, 'removeEventListener')
    render(); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more'); const baseline = mocks.page.mock.calls.length
    /* StrictMode's remount left exactly one live subscription — the channel it
       opened last; the earlier one was closed by its own cleanup. Deliveries
       have to go to that one to exercise the subscription that is listening. */
    const liveChannel = channels.at(-1)
    const refreshMessage = { v: 1, type: 'authority-changed', at: Date.now(), nonce: 'remote-command-1' }
    act(() => liveChannel?.onmessage?.(new MessageEvent('message', { data: refreshMessage }))); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    expect(mocks.page.mock.calls.length).toBe(baseline + 1)
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'known.notifications.refresh.v1', newValue: JSON.stringify(refreshMessage) }))); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    /* The same message mirrored over localStorage is a duplicate, not a second
       refresh: the pair still costs one read. */
    expect(mocks.page.mock.calls.length).toBe(baseline + 1)
    mocks.markOne.mockReset().mockResolvedValue({ kind: 'succeeded', outcome: 'marked', notificationId: 'one', state: 'read', stateRevision: '2', readAt: '2026-07-29T08:02:00.000Z', changed: true })
    const readsBeforeMark = mocks.page.mock.calls.length
    act(() => current.markOne('one')); await waitForDom(() => current != null && current.pending === null && mocks.page.mock.calls.length > readsBeforeMark)
    const payload = liveChannel?.postMessage.mock.calls.map(([value]) => JSON.stringify(value)).join('') ?? ''
    expect(payload).toContain('authority-changed')
    expect(payload).not.toMatch(/notificationId|actorProfile|subject|occurredAt/u)
    act(() => window.dispatchEvent(new Event('focus'))); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); act(() => document.dispatchEvent(new Event('visibilitychange'))); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    act(() => window.dispatchEvent(new Event('online'))); await waitForDom(() => current != null && current.state !== 'loading' && current.state !== 'loading-more')
    cleanup()
    /* Unmount closes every channel this mount opened — including the one that
       survived StrictMode's remount — and detaches the live listeners, so a
       later focus event cannot start another read. */
    expect(channels.length).toBeGreaterThan(0)
    expect(channels.every((channel) => channel.close.mock.calls.length > 0)).toBe(true)
    const readsAtUnmount = mocks.page.mock.calls.length
    act(() => window.dispatchEvent(new Event('focus')))
    await act(async () => { await Promise.resolve() })
    expect(mocks.page.mock.calls.length).toBe(readsAtUnmount)
    expect(removeWindow.mock.calls.length).toBeGreaterThan(0); expect(addWindow.mock.calls.length).toBeGreaterThan(0)
    vi.unstubAllGlobals()
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
    mocks.page.mockImplementation((_query: unknown, options: { signal?: AbortSignal }) => {
      signals.push(options.signal!)
      return new Promise<NotificationInboxPage>(() => {})
    })
    render()
    await waitForDom(() => signals.length > 0)
    cleanup()
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('clears the previous inbox when the session disappears and a failed reread cannot restore it', async () => {
    signIn('account-a')
    let rejectAnon: ((reason: unknown) => void) | undefined
    mocks.page.mockImplementation(() => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      if (signedIn === 'anonymous') return new Promise<NotificationInboxPage>((_resolve, reject) => { rejectAnon = reject })
      return Promise.resolve(page(['a-item'], null, 2))
    })
    render()
    await waitForDom(() => current.items.some((item) => item.notificationId === 'a-item'))
    await act(async () => { clearSession() })
    expect(current.items.map((item) => item.notificationId)).not.toContain('a-item')
    await act(async () => { rejectAnon?.(new Error('offline')); await Promise.resolve(); await Promise.resolve() })
    expect(current.items).toEqual([])
    expect(current.preference).toBeNull()
    expect(current.state).toBe('error')
    expect(readRouteCache<{ items: { notificationId: string }[] }>('notifications:all')).toBeUndefined()
  })

  it('shows the account now signed in and ignores a late inbox from the previous one', async () => {
    signIn('account-a')
    const releaseA: Array<(value: NotificationInboxPage) => void> = []
    mocks.page.mockImplementation(() => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      if (signedIn === 'account-b') return Promise.resolve(page(['b-item'], null, 1))
      return new Promise<NotificationInboxPage>((resolve) => { releaseA.push(resolve) })
    })
    mocks.preference.mockImplementation(async () => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      return signedIn === 'account-b' ? { ...preference, revision: '4' } : preference
    })
    render()
    await waitForDom(() => releaseA.length > 0)
    const stale = mocks.page.mock.calls.at(-1)![1].signal as AbortSignal
    await act(async () => { applyMeView(account('account-b')) })
    expect(stale.aborted).toBe(true)
    await waitForDom(() => current.items.some((item) => item.notificationId === 'b-item'))
    expect(current.items.map((item) => item.notificationId)).toEqual(['b-item'])
    expect(current.preference?.revision).toBe('4')
    await act(async () => {
      for (const release of releaseA) release(page(['a-item'], null, 9))
      await Promise.resolve(); await Promise.resolve()
    })
    expect(current.items.map((item) => item.notificationId)).toEqual(['b-item'])
    expect(current.preference?.revision).toBe('4')
    expect(readRouteCache<{ items: { notificationId: string }[] }>('notifications:all')?.items.map((item) => item.notificationId)).toEqual(['b-item'])
  })

  it('does not apply a preference write that finishes after the account changes', async () => {
    signIn('account-a')
    mocks.page.mockImplementation(async () => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      return page([signedIn === 'account-b' ? 'b-item' : 'a-item'], null, 1)
    })
    mocks.preference.mockImplementation(async () => {
      const signedIn = getSessionSnapshot().me?.account.id ?? 'anonymous'
      return signedIn === 'account-b' ? { ...preference, revision: '4' } : preference
    })
    let resolveWrite: ((value: { kind: 'succeeded'; channel: 'in_app'; enabled: boolean; revision: string; updatedAt: string; changed: boolean }) => void) | undefined
    mocks.updatePreference.mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve }))
    render()
    await waitForDom(() => current.preference?.revision === '2')
    act(() => current.setPreference(false))
    await waitForDom(() => resolveWrite !== undefined)
    await act(async () => { applyMeView(account('account-b')) })
    await waitForDom(() => current.preference?.revision === '4')
    const reads = mocks.page.mock.calls.length
    await act(async () => {
      resolveWrite?.({ kind: 'succeeded', channel: 'in_app', enabled: false, revision: '9', updatedAt: '2026-07-29T03:00:00.000Z', changed: true })
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })
    expect(current.preference?.revision).toBe('4')
    expect(current.preference?.enabled).toBe(true)
    expect(current.mutationError).toBeNull()
    expect(current.items.map((item) => item.notificationId)).toEqual(['b-item'])
    expect(mocks.page.mock.calls.length).toBe(reads)
  })
})

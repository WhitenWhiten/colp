// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { useCollectionFollowWorkflow } from './useCollectionFollowWorkflow'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  getCollectionFollowState: vi.fn(),
  followCollection: vi.fn(),
  unfollowCollection: vi.fn(),
  abandonCollectionFollowIntent: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaA'
const COLLECTION = 'cccccccccccccccccccccA'
/* The endpoint's own record for this collection; `followedAt` stays null until
   a committed mutation sets it. */
type FollowAuthority = { following: boolean; followerCount: number; followedAt: string | null }
let latest: ReturnType<typeof useCollectionFollowWorkflow> | undefined

function Probe() {
  latest = useCollectionFollowWorkflow({
    actorProfileId: ACTOR, collectionId: COLLECTION, enabled: true,
  })
  return <button type="button" onClick={() => void latest?.toggle()}>{latest.status}:{String(latest.following)}</button>
}

/** Same hook, but the collection is a prop so a test can change the scope. */
function ScopeProbe({ collectionId }: { collectionId: string }) {
  latest = useCollectionFollowWorkflow({ actorProfileId: ACTOR, collectionId, enabled: true })
  return (
    <span data-testid="follow-scope">
      {latest.status}:{String(latest.following)}:{String(latest.followerCount)}
    </span>
  )
}

/* StrictMode mounts every effect twice (setup -> cleanup -> setup), so a cold
   mount issues TWO authority reads. The first one is discarded by the hook's
   operation fence, which is why fixtures below describe the endpoint's state
   instead of a call sequence, and why counts are asserted relative to the
   number of reads a mount already made. */
describe('useCollectionFollowWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks(); latest = undefined; document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => { cleanup(); document.body.innerHTML = '' })
  function render() { mountTree(<Probe />) }

  it('restores authority, prevents duplicate pending actions, and refreshes after first success', async () => {
    const notFollowing = { following: false, followerCount: 3, followedAt: null }
    const followed = { following: true, followerCount: 4, followedAt: '2026-08-26T01:00:00.000Z' }
    /* Endpoint state, not a call sequence: the collection is not followed until
       the mutation lands, so every mount read (however many React makes) sees
       the same authority. */
    let authority: FollowAuthority = notFollowing
    mocks.getCollectionFollowState.mockImplementation(async () => authority)
    let release!: () => void
    mocks.followCollection.mockReturnValueOnce(new Promise((resolve) => {
      release = () => { authority = followed; resolve(followed) }
    }))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(latest?.followerCount).toBe(3)
    const readsAfterMount = mocks.getCollectionFollowState.mock.calls.length
    act(() => { void latest?.toggle(); void latest?.toggle() })
    expect(mocks.followCollection).toHaveBeenCalledTimes(1)
    expect(latest?.status).toBe('pending')
    expect(latest?.followerCount).toBe(3)
    await act(async () => release()); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    /* Success refreshes authority exactly once; the mount's reads are already
       counted, so a retry or refetch loop would push this above 1. */
    expect(mocks.getCollectionFollowState.mock.calls.length - readsAfterMount).toBe(1)
    expect(latest?.following).toBe(true)
    expect(latest?.followerCount).toBe(4)
  })

  it('keeps unknown outcome retry on the exact intent and resolves from server authority', async () => {
    const notFollowing = { following: false, followerCount: 0, followedAt: null }
    const followed = { following: true, followerCount: 1, followedAt: '2026-08-26T01:00:00.000Z' }
    let following = false
    mocks.getCollectionFollowState.mockImplementation(async () => (following ? followed : notFollowing))
    /* The first attempt dies in transport; the exact-intent retry is the one
       that lands, and only then does authority report the new state. */
    mocks.followCollection
      .mockRejectedValueOnce(new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }))
      .mockImplementation(async () => { following = true; return followed })
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    await act(async () => { await latest?.toggle() }); expect(latest?.status).toBe('unknown')
    await act(async () => { await latest?.retryExact() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(mocks.followCollection.mock.calls[1]?.[1]?.intentId).toBe(mocks.followCollection.mock.calls[0]?.[1]?.intentId)
    expect(latest?.following).toBe(true)
  })

  it('surfaces same-ID conflict and only abandons it after authority refresh', async () => {
    /* The endpoint's authority is stable here: this collection is not followed
       before or after the conflicting command. */
    mocks.getCollectionFollowState.mockResolvedValue({ following: false, followerCount: 0, followedAt: null })
    /* The reused command id conflicts for as long as the intent is kept. */
    mocks.followCollection.mockRejectedValue(new ProductApiError({
      status: 409, code: 'command_id_reused', message: 'conflict',
    }))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending'); await act(async () => { await latest?.toggle() })
    expect(latest?.status).toBe('conflict')
    expect(mocks.abandonCollectionFollowIntent).not.toHaveBeenCalled()
    await act(async () => { await latest?.refresh() }); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    expect(mocks.abandonCollectionFollowIntent).toHaveBeenCalledWith(expect.stringContaining(COLLECTION))
    expect(latest?.status).toBe('ready')
  })

  it('re-reads authority when another tab broadcasts a collection-follow change', async () => {
    const before = { following: false, followerCount: 1, followedAt: null }
    const after = { following: true, followerCount: 2, followedAt: '2026-08-26T01:00:00.000Z' }
    let authority: FollowAuthority = before
    mocks.getCollectionFollowState.mockImplementation(async () => authority)
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    const readsAfterMount = mocks.getCollectionFollowState.mock.calls.length
    /* The other tab's follow has already landed on the server by the time its
       invalidation broadcast arrives. */
    authority = after
    act(() => window.dispatchEvent(new StorageEvent('storage', {
      key: 'known.collection-follow.invalidate.v1', newValue: COLLECTION,
    })))
    await waitForDom(() => latest != null && latest.following === true)
    /* Exactly one re-read for one broadcast — not one per mount invocation and
       not a refetch loop. */
    expect(mocks.getCollectionFollowState.mock.calls.length - readsAfterMount).toBe(1)
    expect(latest?.following).toBe(true)
    expect(latest?.followerCount).toBe(2)
  })

  it('hides on GET 404 without retrying authority', async () => {
    mocks.getCollectionFollowState.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'not exposed' }),
    )
    render(); await waitForDom(() => latest != null && latest.status === 'unavailable')
    expect(latest?.followerCount).toBeNull()
    expect(latest?.following).toBe(false)
    await act(async () => { await Promise.resolve() })
    /* Two reads is the StrictMode mount itself; a retry after the concealed 404
       would be a third. */
    expect(mocks.getCollectionFollowState).toHaveBeenCalledTimes(2)
    expect(mocks.followCollection).not.toHaveBeenCalled()
  })

  it('retries a failed authority read without accidentally issuing a mutation', async () => {
    const authority = { following: false, followerCount: 0, followedAt: null }
    let online = false
    mocks.getCollectionFollowState.mockImplementation(async () => {
      if (!online) throw new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' })
      return authority
    })
    render(); await waitForDom(() => latest != null && latest.status === 'error')
    expect(latest?.retryKind).toBe('authority')
    const readsAfterMount = mocks.getCollectionFollowState.mock.calls.length
    online = true
    await act(async () => { await latest?.retry() }); await waitForDom(() => latest != null && latest.status === 'ready')
    /* The retry re-reads authority exactly once and never issues a mutation. */
    expect(mocks.getCollectionFollowState.mock.calls.length - readsAfterMount).toBe(1)
    expect(mocks.followCollection).not.toHaveBeenCalled()
  })

  it('drops a deterministic user_action rejection to an authority re-read instead of intent retry', async () => {
    mocks.getCollectionFollowState.mockResolvedValue({ following: false, followerCount: 0, followedAt: null })
    mocks.followCollection.mockRejectedValueOnce(new ProductApiError({
      status: 400, code: 'invalid_request',
      message: 'A Collection owner cannot follow their own collection.',
      recovery: 'user_action',
    }))
    render(); await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    await act(async () => { await latest?.toggle() })
    expect(latest?.status).toBe('error')
    expect(latest?.retryKind).toBe('authority')
    expect(latest?.message).toMatch(/owner cannot follow/i)
    const readsAfterMount = mocks.getCollectionFollowState.mock.calls.length
    await act(async () => { await latest?.retry() })
    await waitForDom(() => latest != null && latest.status !== 'loading' && latest.status !== 'pending')
    /* Retry means "retry status": one authority re-read, and the intent that can
       never succeed is not re-issued. */
    expect(mocks.followCollection).toHaveBeenCalledTimes(1)
    expect(mocks.getCollectionFollowState.mock.calls.length - readsAfterMount).toBe(1)
    expect(latest?.status).toBe('ready')
  })

  it('does not treat AbortError as an authority failure', async () => {
    /* The authority read is aborted (the caller went away). Every mount read is
       aborted here, so the fixture describes an endpoint whose read is aborted
       rather than a one-shot queue that the second mount would exhaust. */
    mocks.getCollectionFollowState.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    render()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(latest?.status).not.toBe('error')
    expect(latest?.status).not.toBe('unavailable')
    /* An abort is not a failure: it leaves the workflow untouched (still in its
       initial state) instead of surfacing an error. */
    expect(latest?.status).toBe('loading')
    /* Two reads is the StrictMode mount itself; an aborted read is not retried. */
    expect(mocks.getCollectionFollowState).toHaveBeenCalledTimes(2)
  })

  it('cancels the in-flight authority read on unmount and drops its late answer', async () => {
    /* The read is held open, so unmount lands while the request is genuinely in
       flight — the exact window an uncancellable request keeps running in. */
    const resolvers: ((value: FollowAuthority) => void)[] = []
    const signals: (AbortSignal | undefined)[] = []
    mocks.getCollectionFollowState.mockImplementation((
      _collectionId: string,
      options?: { signal?: AbortSignal },
    ) => {
      signals.push(options?.signal)
      return new Promise<FollowAuthority>((resolve) => { resolvers.push(resolve) })
    })
    render()
    await waitForDom(() => signals.length > 0)
    const inFlight = signals.at(-1)
    /* The authority read must carry a caller-owned cancellation signal. */
    expect(inFlight).toBeInstanceOf(AbortSignal)
    cleanup()
    /* Unmount aborts it instead of letting it run to completion. */
    expect(inFlight?.aborted).toBe(true)
    await act(async () => {
      for (const resolve of resolvers) resolve({ following: true, followerCount: 9, followedAt: null })
      await Promise.resolve()
    })
    /* And its late answer paints nothing. */
    expect(latest?.following).toBe(false)
    expect(latest?.followerCount).toBeNull()
    expect(latest?.status).toBe('loading')
  })

  it('cancels the previous collection authority read when the scope changes', async () => {
    const other = 'dddddddddddddddddddddA'
    const resolvers = new Map<string, (value: FollowAuthority) => void>()
    mocks.getCollectionFollowState.mockImplementation((collectionId: string) => (
      new Promise<FollowAuthority>((resolve) => { resolvers.set(collectionId, resolve) })
    ))
    mountTree(<ScopeProbe collectionId={COLLECTION} />)
    await waitForDom(() => resolvers.has(COLLECTION))
    const previousCall = mocks.getCollectionFollowState.mock.calls
      .filter((call) => call[0] === COLLECTION).at(-1)
    const previousSignal = previousCall?.[1]?.signal as AbortSignal | undefined
    expect(previousSignal).toBeInstanceOf(AbortSignal)
    expect(previousSignal?.aborted).toBe(false)

    mountTree(<ScopeProbe collectionId={other} />)
    await waitForDom(() => resolvers.has(other))
    /* The scope change aborts the abandoned target's read. */
    expect(previousSignal?.aborted).toBe(true)
    await act(async () => {
      resolvers.get(COLLECTION)?.({ following: true, followerCount: 7, followedAt: null })
      await Promise.resolve()
    })
    /* The abandoned target's late answer never paints over the new scope. */
    expect(latest?.following).toBe(false)
    expect(latest?.followerCount).toBeNull()
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CommunityComment,
  CommunityCommentPage,
  CommunityTarget,
  CommunityTargetQuery,
  CommunityTargetView,
} from '../api'
import { useCommunityComments } from './useCommunityComments'
import { cleanup, mountTree, waitForDom } from '../test/render'
import { applySessionView, clearSession } from '../api/sessionStore'

const mocks = vi.hoisted(() => ({
  resolveCommunityTarget: vi.fn(),
  getCommunityComments: vi.fn(),
  getCommunityCommentSettings: vi.fn(),
  getCommunityCommentReplies: vi.fn(),
}))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

const COLLECTION = 'cccccccccccccccccccccA'
const OTHER_COLLECTION = 'dddddddddddddddddddddA'

function target(id: string): CommunityTarget {
  return { kind: 'collection', id, collectionId: null, seriesId: null, generation: 'static-v1' }
}
const TARGET = target(COLLECTION)
const QUERY: CommunityTargetQuery = { kind: 'collection', id: COLLECTION }
const OTHER_QUERY: CommunityTargetQuery = { kind: 'collection', id: OTHER_COLLECTION }

function view(forTarget: CommunityTarget): CommunityTargetView {
  return {
    target: forTarget,
    title: 'Curated list',
    href: '/c/curated',
    canVote: true,
    canComment: true,
    canCurateComments: false,
    votes: { target: forTarget, up: 3, down: 1, myVote: 0 },
  }
}

function comment(id: string, overrides: Partial<CommunityComment> = {}): CommunityComment {
  return {
    id,
    target: TARGET,
    rootId: id,
    replyToId: null,
    depth: 0,
    author: {
      id: 'bbbbbbbbbbbbbbbbbbbbA',
      handle: 'reader',
      displayName: 'Reader',
      avatarUrl: null,
    },
    body: `Body of ${id}`,
    state: 'visible',
    revision: '1',
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    replyCount: 0,
    canEdit: false,
    canDelete: false,
    canCurate: false,
    ...overrides,
  }
}

function page(
  items: readonly CommunityComment[],
  nextCursor: string | null = null,
): CommunityCommentPage {
  return { items: [...items], nextCursor }
}

let latest: ReturnType<typeof useCommunityComments> | undefined

function Probe({ query }: { query: CommunityTargetQuery }) {
  latest = useCommunityComments({ query, enabled: true })
  return (
    <div>
      <span data-testid="status">{latest.status}</span>
      <span data-testid="roots">{latest.roots.map((root) => root.id).join(',')}</span>
      <span data-testid="replies">
        {[...latest.replies].map(([rootId, thread]) => `${rootId}:${String(thread.loaded)}`).join(',')}
      </span>
      <button type="button" data-testid="toggle-replies" onClick={() => latest?.toggleReplies('root-1')}>
        Toggle replies
      </button>
    </div>
  )
}

function el(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
}

/* The hook resolves its live target (generation) before it lists anything, so
   every fixture here is a deferred client promise the test releases by hand:
   the window under test is the one where the reader has already left the scope
   but the request is still in flight. StrictMode double-invokes the mount
   effect (setup -> cleanup -> setup), so the first read of a mount is expected
   to be aborted and superseded by the second. */
describe('useCommunityComments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSession()
    latest = undefined
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.getCommunityCommentSettings.mockResolvedValue({
      data: { locked: false, reason: null }, etag: 'settings-etag-1',
    })
  })
  afterEach(() => { cleanup(); clearSession(); document.body.innerHTML = '' })

  function render(query: CommunityTargetQuery) { mountTree(<Probe query={query} />) }

  it('cancels the in-flight target read on unmount and drops its late answer', async () => {
    const resolvers: ((value: CommunityTargetView) => void)[] = []
    const signals: (AbortSignal | undefined)[] = []
    mocks.resolveCommunityTarget.mockImplementation((
      _query: CommunityTargetQuery,
      options?: { signal?: AbortSignal },
    ) => {
      signals.push(options?.signal)
      return new Promise<CommunityTargetView>((resolve) => { resolvers.push(resolve) })
    })
    render(QUERY)
    await waitForDom(() => signals.length > 0)
    const inFlight = signals.at(-1)
    /* The authority read must carry a caller-owned cancellation signal. */
    expect(inFlight).toBeInstanceOf(AbortSignal)
    cleanup()
    /* Unmount aborts it instead of letting it run to completion. */
    expect(inFlight?.aborted).toBe(true)
    await act(async () => {
      for (const resolve of resolvers) resolve(view(TARGET))
      await Promise.resolve()
    })
    /* And its late answer paints nothing: the hook is still in its initial
       state, not the resolved view the abandoned read carried. */
    expect(latest?.status).toBe('loading')
    expect(latest?.view).toBeNull()
    expect(latest?.roots).toEqual([])
  })

  it('drops a late authority answer after the private session identity changes', async () => {
    const resolvers: ((value: CommunityTargetView) => void)[] = []
    mocks.resolveCommunityTarget.mockImplementation(() => (
      new Promise<CommunityTargetView>((resolve) => { resolvers.push(resolve) })
    ))
    render(QUERY)
    await waitForDom(() => resolvers.length > 0)
    const oldResolver = resolvers.at(-1)!
    act(() => {
      applySessionView({
        authenticated: true,
        csrfToken: 'csrf-a',
        idleExpiresAt: '2099-01-01T00:00:00.000Z',
        absoluteExpiresAt: '2099-01-02T00:00:00.000Z',
      })
    })
    await act(async () => {
      oldResolver(view(TARGET))
      await Promise.resolve()
    })
    expect(latest?.view).toBeNull()
    expect(latest?.roots).toEqual([])
  })

  it('cancels the previous target authority read when the target changes', async () => {
    const resolvers = new Map<string, (value: CommunityTargetView) => void>()
    mocks.resolveCommunityTarget.mockImplementation((query: CommunityTargetQuery) => (
      new Promise<CommunityTargetView>((resolve) => { resolvers.set(query.id, resolve) })
    ))
    render(QUERY)
    await waitForDom(() => resolvers.has(COLLECTION))
    const previousCall = mocks.resolveCommunityTarget.mock.calls
      .filter((call) => call[0].id === COLLECTION).at(-1)
    const previousSignal = previousCall?.[1]?.signal as AbortSignal | undefined
    expect(previousSignal).toBeInstanceOf(AbortSignal)
    expect(previousSignal?.aborted).toBe(false)

    mountTree(<Probe query={OTHER_QUERY} />)
    await waitForDom(() => resolvers.has(OTHER_COLLECTION))
    /* The target change aborts the abandoned target's read. */
    expect(previousSignal?.aborted).toBe(true)
    await act(async () => {
      resolvers.get(COLLECTION)?.(view(TARGET))
      await Promise.resolve()
    })
    /* The abandoned target's late answer never paints over the new scope. */
    expect(latest?.roots).toEqual([])
    expect(el('roots')?.textContent).toBe('')
  })

  it('does not paint a late replies page into the target that replaced it', async () => {
    mocks.resolveCommunityTarget.mockImplementation(
      async (query: CommunityTargetQuery) => view(target(query.id)),
    )
    mocks.getCommunityComments.mockImplementation(async (query: { id: string }) => (
      query.id === COLLECTION ? page([comment('root-1')]) : page([comment('other-root')])
    ))
    let releaseReplies!: (value: CommunityCommentPage) => void
    const replySignals: (AbortSignal | undefined)[] = []
    mocks.getCommunityCommentReplies.mockImplementation((
      _rootId: string,
      _query: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      replySignals.push(options?.signal)
      return new Promise<CommunityCommentPage>((resolve) => { releaseReplies = resolve })
    })

    render(QUERY)
    await waitForDom(() => el('roots')?.textContent === 'root-1')
    act(() => { el('toggle-replies')?.click() })
    expect(replySignals.length).toBe(1)

    /* The reader moves to another target while the first thread is loading. */
    mountTree(<Probe query={OTHER_QUERY} />)
    await waitForDom(() => el('roots')?.textContent === 'other-root')

    /* The abandoned thread's page lands late: it must not repopulate the
       replies of the target that replaced it. */
    await act(async () => {
      releaseReplies(page([comment('r1', { rootId: 'root-1', replyToId: 'root-1', depth: 1 })]))
      await Promise.resolve()
    })
    expect(el('replies')?.textContent).toBe('')
    expect(latest?.replies.size).toBe(0)

    /* The thread read carried the scope's signal, so the scope change could
       cancel it rather than leave it running. */
    expect(replySignals.at(-1)).toBeInstanceOf(AbortSignal)
    expect((replySignals.at(-1) as AbortSignal | undefined)?.aborted).toBe(true)
  })
})

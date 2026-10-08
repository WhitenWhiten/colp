// @vitest-environment happy-dom
import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import type { CommunityTarget, CommunityTargetQuery, CommunityTargetView } from '../api'
import { CommunityVoteControl } from './CommunityVoteControl'
import { cleanup, mountTree, waitForDom } from '../test/render'

const mocks = vi.hoisted(() => ({
  resolveCommunityTarget: vi.fn(),
  setCommunityVote: vi.fn(),
  abandonCommunityVoteIntent: vi.fn(),
}))

const auth = vi.hoisted(() => ({
  user: { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' } as
    | { profileId: string; handle: string }
    | null,
  isLoggedIn: true,
  bootstrapping: false,
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, ...mocks } }
})

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    isLoggedIn: auth.isLoggedIn,
    bootstrapping: auth.bootstrapping,
  }),
}))

const COLLECTION = 'cccccccccccccccccccccA'
const TARGET: CommunityTarget = {
  kind: 'collection', id: COLLECTION,
  collectionId: null, seriesId: null, generation: 'static-v1',
}
const QUERY = { kind: 'collection' as const, id: COLLECTION }

function view(overrides: Partial<CommunityTargetView> = {}): CommunityTargetView {
  return {
    target: TARGET,
    title: 'Curated list',
    href: '/c/curated',
    canVote: true,
    canComment: true,
    canCurateComments: false,
    votes: { target: TARGET, up: 3, down: 1, myVote: 0 },
    ...overrides,
  }
}

describe('CommunityVoteControl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.user = { profileId: 'aaaaaaaaaaaaaaaaaaaaaA', handle: 'actor' }
    auth.isLoggedIn = true
    auth.bootstrapping = false
    delete window.__KNOWN_FLAGS__
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.resolveCommunityTarget.mockResolvedValue(view())
    mocks.setCommunityVote.mockResolvedValue({ target: TARGET, up: 4, down: 1, myVote: 1 })
  })
  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    delete window.__KNOWN_FLAGS__
  })

  function render(query: CommunityTargetQuery = QUERY) {
    mountTree(
      <MemoryRouter initialEntries={['/c/curated']}>
        <Routes>
          <Route path="/c/curated" element={<CommunityVoteControl query={query} />} />
          <Route path="/login" element={<div data-testid="login-route" />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  function up(): HTMLButtonElement | null {
    return document.querySelector('[data-testid="community-vote-up"]')
  }
  function down(): HTMLButtonElement | null {
    return document.querySelector('[data-testid="community-vote-down"]')
  }

  it('does not render or resolve when community exposure is off', async () => {
    window.__KNOWN_FLAGS__ = { community: false }
    render()
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[data-testid="community-vote"]')).toBeNull()
    expect(mocks.resolveCommunityTarget).not.toHaveBeenCalled()
  })

  it('resolves the target then renders up/down counts', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    render()
    await waitForDom(() => up() !== null)
    expect(mocks.resolveCommunityTarget).toHaveBeenCalledWith(QUERY, expect.objectContaining({ maxRetries: 0 }))
    expect(document.querySelector('[data-testid="community-vote-up-count"]')?.textContent).toBe('3')
    expect(document.querySelector('[data-testid="community-vote-down-count"]')?.textContent).toBe('1')
    expect(up()?.getAttribute('aria-pressed')).toBe('false')
    expect(up()?.disabled).toBe(false)
  })

  it('upvotes through the resolved target and reflects the returned state', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    render()
    await waitForDom(() => up() !== null && !up()!.disabled)
    await act(async () => { up()?.click() })
    await waitForDom(() => up()?.getAttribute('aria-pressed') === 'true')
    expect(mocks.setCommunityVote).toHaveBeenCalledTimes(1)
    const [target, value, options] = mocks.setCommunityVote.mock.calls[0]!
    expect(target).toEqual(TARGET)
    expect(value).toBe(1)
    expect(options.intentId).toBe(`community-vote:collection:${COLLECTION}:static-v1:1`)
    expect(document.querySelector('[data-testid="community-vote-up-count"]')?.textContent).toBe('4')
  })

  it('clicking the active vote sends value 0 (remove)', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.resolveCommunityTarget.mockResolvedValue(view({
      votes: { target: TARGET, up: 3, down: 1, myVote: 1 },
    }))
    mocks.setCommunityVote.mockResolvedValue({ target: TARGET, up: 2, down: 1, myVote: 0 })
    render()
    await waitForDom(() => up()?.getAttribute('aria-pressed') === 'true')
    await act(async () => { up()?.click() })
    await waitForDom(() => up()?.getAttribute('aria-pressed') === 'false')
    expect(mocks.setCommunityVote.mock.calls[0]![1]).toBe(0)
  })

  it('sends -1 for a downvote', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.setCommunityVote.mockResolvedValue({ target: TARGET, up: 3, down: 2, myVote: -1 })
    render()
    await waitForDom(() => down() !== null)
    await act(async () => { down()?.click() })
    await waitForDom(() => down()?.getAttribute('aria-pressed') === 'true')
    expect(mocks.setCommunityVote.mock.calls[0]![1]).toBe(-1)
    expect(document.querySelector('[data-testid="community-vote-down-count"]')?.textContent).toBe('2')
  })

  it('shows counts to anonymous visitors and routes a press to sign-in instead of voting', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    auth.user = null
    auth.isLoggedIn = false
    mocks.resolveCommunityTarget.mockResolvedValue(view({
      canVote: false, canComment: false,
      votes: { target: TARGET, up: 3, down: 1, myVote: null },
    }))
    render()
    await waitForDom(() => up() !== null)
    // The pill itself is the sign-in affordance: no separate CTA, live arrows.
    expect(document.querySelector('[data-testid="community-vote-signin"]')).toBeNull()
    expect(up()?.disabled).toBe(false)
    expect(down()?.disabled).toBe(false)
    expect(up()?.getAttribute('title')).toBe('Sign in to vote')
    expect(up()?.getAttribute('aria-label')).toBe('Sign in to upvote, 3 votes')
    expect(document.querySelector('[data-testid="community-vote-up-count"]')?.textContent).toBe('3')
    await act(async () => { up()?.click() })
    expect(mocks.setCommunityVote).not.toHaveBeenCalled()
    expect(document.querySelector('[data-testid="login-route"]')).not.toBeNull()
  })

  it('disables the buttons when the server reports canVote false (e.g. owner)', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.resolveCommunityTarget.mockResolvedValue(view({ canVote: false }))
    render()
    await waitForDom(() => up() !== null)
    expect(up()?.disabled).toBe(true)
    expect(document.querySelector('[data-testid="community-vote-signin"]')).toBeNull()
    await act(async () => { up()?.click() })
    expect(mocks.setCommunityVote).not.toHaveBeenCalled()
  })

  it('hides when the target cannot be resolved (uniform concealment)', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.resolveCommunityTarget.mockRejectedValue(
      new ProductApiError({ status: 404, code: 'resource_not_found', message: 'hidden' }),
    )
    render()
    await waitForDom(() => document.querySelector('[data-testid="community-vote"]') === null)
    // Concealment asks one question, not a retry loop: every attempt carries the
    // same query and the number of attempts does not grow after it settles.
    expect(new Set(mocks.resolveCommunityTarget.mock.calls.map((call) => JSON.stringify(call[0]))).size).toBe(1)
    const attempts = mocks.resolveCommunityTarget.mock.calls.length
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(mocks.resolveCommunityTarget.mock.calls.length).toBe(attempts)
    expect(up()).toBeNull()
  })

  it('revision_conflict moves to a refresh state; the next click uses the fresh generation', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    const freshTarget: CommunityTarget = {
      kind: 'bookmark', id: 'node-1', collectionId: COLLECTION,
      seriesId: null, generation: 'bm-gen-fresh000000000',
    }
    const staleTarget: CommunityTarget = { ...freshTarget, generation: 'bm-gen-stale00000000' }
    /* Endpoint state: the target's generation is the stale one until the server
       rejects the write for the moved revision, after which resolving reports
       the fresh generation. */
    let generation = staleTarget.generation
    mocks.resolveCommunityTarget.mockImplementation(() => {
      const target: CommunityTarget = { ...freshTarget, generation }
      return Promise.resolve(view({
        target,
        votes: { target, up: generation === staleTarget.generation ? 1 : 2, down: 0, myVote: 0 },
      }))
    })
    mocks.setCommunityVote.mockImplementationOnce(() => {
      generation = freshTarget.generation
      return Promise.reject(new ProductApiError({ status: 409, code: 'revision_conflict', message: 'stale' }))
    })
    render({ kind: 'bookmark', id: 'node-1', collectionId: COLLECTION })
    await waitForDom(() => up() !== null)

    await act(async () => { up()?.click() })
    await waitForDom(() => document.querySelector('[data-testid="community-vote-refresh"]') !== null)
    const resolvesBeforeRefresh = mocks.resolveCommunityTarget.mock.calls.length
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="community-vote-refresh"]')?.click()
    })
    await waitForDom(() => up() !== null && document.querySelector('[data-testid="community-vote-refresh"]') === null)
    // The refresh re-resolves the target exactly once.
    expect(mocks.resolveCommunityTarget.mock.calls.length).toBe(resolvesBeforeRefresh + 1)

    mocks.setCommunityVote.mockResolvedValue({ target: freshTarget, up: 3, down: 0, myVote: 1 })
    await act(async () => { up()?.click() })
    await waitForDom(() => up()?.getAttribute('aria-pressed') === 'true')
    const [target, , options] = mocks.setCommunityVote.mock.calls[1]!
    expect(target.generation).toBe('bm-gen-fresh000000000')
    expect(options.intentId).toContain('bm-gen-fresh000000000')
  })

  it('transport uncertainty keeps the exact intent retryable', async () => {
    window.__KNOWN_FLAGS__ = { community: true }
    mocks.setCommunityVote.mockRejectedValueOnce(
      new ProductApiError({ status: 0, code: 'transport_error', message: 'offline' }),
    )
    render()
    await waitForDom(() => up() !== null)
    await act(async () => { up()?.click() })
    await waitForDom(() => document.querySelector('[data-testid="community-vote-retry"]') !== null)

    mocks.setCommunityVote.mockResolvedValue({ target: TARGET, up: 4, down: 1, myVote: 1 })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="community-vote-retry"]')?.click()
    })
    await waitForDom(() => up()?.getAttribute('aria-pressed') === 'true')
    expect(mocks.setCommunityVote).toHaveBeenCalledTimes(2)
    expect(mocks.setCommunityVote.mock.calls[1]![2].intentId)
      .toBe(mocks.setCommunityVote.mock.calls[0]![2].intentId)
  })
})

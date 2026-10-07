// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProductApiError } from '../api/errors'
import { applyMeView, applySessionView, clearSession, getSessionSnapshot } from '../api/sessionStore'
import { clearRouteCache } from './routeCache'
import { usePublicCollectionSnapshot } from './usePublicCollectionSnapshot'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

/**
 * The published snapshot is the heaviest read in the product and four views
 * share this hook (collection board, path reader, graph, share), so hopping
 * between two views of the same collection used to reassemble it from scratch.
 *
 * The one thing the cache must never hide is a collection that has since been
 * withdrawn: a 404 has to surface even when a snapshot is still held.
 */

const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, productClient: { ...actual.productClient, loadPublicCollectionSnapshot: mocks.load } }
})

const snapshot = (title: string) => ({
  collection: {
    id: 'c1', slug: 'shelf', title, description: null, kind: 'bookmarks' as const,
    rootNodeId: 'root', publishedAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    curator: null, tags: [], stats: null,
  },
  nodes: [],
})

describe('usePublicCollectionSnapshot', () => {
  const seen: string[] = []

  function Harness() {
    const { load, retry } = usePublicCollectionSnapshot('shelf')
    seen.push(load.status)
    const nodes = load.status === 'ready' ? load.snapshot.nodes.map((node) => node.title).join('|') : ''
    return <div data-testid="snap" data-status={load.status}
      data-title={load.status === 'ready' ? load.snapshot.collection.title : ''}
      data-nodes={nodes}
      data-access={load.status === 'ready' ? (load.snapshot.collection.access ?? '') : ''}>
      <button type="button" data-testid="snap-retry" onClick={retry}>Retry</button>
    </div>
  }

  beforeEach(() => {
    mocks.load.mockReset().mockResolvedValue(snapshot('Shelf'))
    clearRouteCache()
    seen.length = 0
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    cleanup()
    clearSession()
    clearRouteCache()
    document.body.innerHTML = ''
  })

  function mount() {
    mountTree(<Harness />)
  }

  function remount() {
    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    seen.length = 0
    mount()
  }

  it('paints the cached snapshot on the first frame after a remount', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-status')).toBe('ready')

    remount()

    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-status')).toBe('ready')
    expect(seen).not.toContain('loading')
    await waitForDom(domFinishedLoading)
  })

  it('replaces the cached snapshot with the revalidated one', async () => {
    mount()
    await waitForDom(domFinishedLoading)

    mocks.load.mockResolvedValue(snapshot('Shelf renamed'))
    remount()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-title')).toBe('Shelf renamed')
  })

  it('still reports a withdrawn collection even while a snapshot is cached', async () => {
    mount()
    await waitForDom(domFinishedLoading)

    mocks.load.mockRejectedValue(new ProductApiError({
      status: 404, code: 'resource_not_found', message: 'gone',
      recovery: 'none', sameRequestRetrySafe: false,
    }))
    remount()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-status')).toBe('unavailable')
  })

  it('keeps the cached snapshot when the revalidation fails for another reason', async () => {
    mount()
    await waitForDom(domFinishedLoading)

    mocks.load.mockRejectedValue(new Error('offline'))
    remount()
    await waitForDom(domFinishedLoading)

    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-status')).toBe('ready')
  })

  function signIn(accountId: string) {
    applySessionView({
      authenticated: true, csrfToken: 'csrf',
      idleExpiresAt: '2026-10-03T01:00:00Z', absoluteExpiresAt: '2026-10-04T00:00:00Z',
    })
    applyMeView({
      account: { id: accountId, email: `${accountId}@test` },
      profile: { id: `profile-${accountId}`, handle: accountId, displayName: accountId, avatarUrl: null },
    })
  }

  function memberTree() {
    const base = snapshot('Member shelf')
    return {
      ...base,
      collection: { ...base.collection, access: 'member' as const },
      nodes: [
        { id: 'root', title: 'Root' },
        { id: 'secret', title: 'Private member node' },
      ],
    }
  }

  it('retires a member snapshot when the session is lost in place', async () => {
    signIn('account-a')
    let releaseAnonymous: (value: ReturnType<typeof snapshot>) => void = () => {}
    const anonymous = new Promise<ReturnType<typeof snapshot>>((resolve) => { releaseAnonymous = resolve })
    mocks.load.mockImplementation(() => (
      getSessionSnapshot().authenticated ? Promise.resolve(memberTree()) : anonymous
    ))
    mount()
    await waitForDom(() => document.querySelector('[data-testid="snap"]')?.getAttribute('data-nodes')?.includes('Private member node') === true)
    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-access')).toBe('member')
    const callsBeforeLoss = mocks.load.mock.calls.length

    await act(async () => { clearSession() })

    const retired = document.querySelector('[data-testid="snap"]')
    expect(retired?.getAttribute('data-status')).toBe('loading')
    expect(retired?.getAttribute('data-nodes') ?? '').not.toContain('Private member node')
    expect(mocks.load.mock.calls.length).toBeGreaterThan(callsBeforeLoss)
    expect(getSessionSnapshot().authenticated).toBe(false)

    await act(async () => { releaseAnonymous(snapshot('Public shelf')) })
    await waitForDom(() => document.querySelector('[data-testid="snap"]')?.getAttribute('data-title') === 'Public shelf')
    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-nodes') ?? '').not.toContain('Private member node')
    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-access')).toBe('')
  })

  it('does not restore a member snapshot when the anonymous refetch fails', async () => {
    signIn('account-a')
    mocks.load.mockImplementation(() => (
      getSessionSnapshot().authenticated ? Promise.resolve(memberTree()) : Promise.reject(new Error('offline'))
    ))
    mount()
    await waitForDom(() => document.querySelector('[data-testid="snap"]')?.getAttribute('data-nodes')?.includes('Private member node') === true)

    await act(async () => { clearSession() })
    await waitForDom(() => document.querySelector('[data-testid="snap"]')?.getAttribute('data-status') === 'error')

    const snap = document.querySelector('[data-testid="snap"]')
    expect(snap?.getAttribute('data-status')).toBe('error')
    expect(snap?.getAttribute('data-nodes') ?? '').not.toContain('Private member node')
    expect(document.body.textContent).not.toContain('Private member node')
  })

  it('keeps the current projection when revalidation fails for the same identity', async () => {
    signIn('account-a')
    mocks.load.mockResolvedValue(memberTree())
    mount()
    await waitForDom(() => document.querySelector('[data-testid="snap"]')?.getAttribute('data-nodes')?.includes('Private member node') === true)

    mocks.load.mockRejectedValue(new Error('offline'))
    act(() => { document.querySelector<HTMLButtonElement>('[data-testid="snap-retry"]')?.click() })
    await waitForDom(domFinishedLoading)

    const snap = document.querySelector('[data-testid="snap"]')
    expect(snap?.getAttribute('data-status')).toBe('ready')
    expect(snap?.getAttribute('data-access')).toBe('member')
    expect(snap?.getAttribute('data-nodes')).toContain('Private member node')
    expect(getSessionSnapshot().me?.account.id).toBe('account-a')
  })

  it('does not show the old tree when the cache is cleared and the retry fails', async () => {
    mount()
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="snap"]')?.getAttribute('data-title')).toBe('Shelf')

    clearRouteCache()
    mocks.load.mockRejectedValue(new Error('offline'))
    act(() => { document.querySelector<HTMLButtonElement>('[data-testid="snap-retry"]')?.click() })
    await waitForDom(() => document.querySelector('[data-testid="snap"]')?.getAttribute('data-status') === 'error')

    const snap = document.querySelector('[data-testid="snap"]')
    expect(snap?.getAttribute('data-status')).toBe('error')
    expect(snap?.getAttribute('data-title')).toBe('')
  })
})

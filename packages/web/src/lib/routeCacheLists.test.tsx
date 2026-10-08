// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession } from '../api/sessionStore'
import { clearRouteCache } from './routeCache'
import { useMyCollaborationInvites } from './useMyCollaborationInvites'
import { useSharedCollections } from './useSharedCollections'
import { cleanup, domFinishedLoading, mountTree, waitForDom } from '../test/render'

/**
 * The library sidebar hides "Shared with you" and "Invitations" whenever their
 * list is empty, and the desk remounts on every trip through a sub-route. So a
 * hook that wipes its rows before refetching makes those whole sections
 * disappear and pop back — the same defect the owned-collections list had.
 */

const mocks = vi.hoisted(() => ({ shared: vi.fn(), invites: vi.fn(), accept: vi.fn() }))
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return {
    ...actual,
    productClient: {
      ...actual.productClient,
      listSharedCollections: mocks.shared,
      listMyCollaborationInvites: mocks.invites,
      acceptCollaborationInvite: mocks.accept,
    },
  }
})

const sharedItem = (id: string, title: string) => ({
  collection: {
    id, slug: id, title, description: null, kind: 'bookmarks' as const,
    visibility: 'private' as const, rootNodeId: `${id}-root`, etag: '"1"',
    createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
  },
  capabilities: { readNode: true, createNode: false, updateNode: false, deleteNode: false, moveNode: false },
})

const inviteItem = (inviteId: string) => ({
  inviteId, collectionId: 'col-shared', collectionTitle: 'Shared Shelf',
  role: 'editor', email: 'b@test',
  expiresAt: '2026-09-01T00:00:00Z', invitedAt: '2026-08-19T00:00:00Z',
})

describe('desk sidebar lists survive a remount', () => {
  const seen: Array<{ count: number; state: string }> = []

  let acceptFirst: (() => Promise<unknown>) | undefined

  function SharedHarness() {
    const list = useSharedCollections()
    seen.push({ count: list.items.length, state: list.state })
    return <div data-testid="list" data-count={list.items.length} data-state={list.state} />
  }

  function InvitesHarness() {
    const invites = useMyCollaborationInvites()
    acceptFirst = () => invites.accept(invites.items[0]!.inviteId)
    seen.push({ count: invites.items.length, state: invites.state })
    return <div data-testid="list" data-count={invites.items.length} data-state={invites.state} />
  }

  beforeEach(() => {
    vi.clearAllMocks()
    clearRouteCache()
    seen.length = 0
    document.body.innerHTML = '<div id="root"></div>'
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    applySessionView({ authenticated: true, csrfToken: 'csrf', idleExpiresAt: '2026-08-25T01:00:00Z', absoluteExpiresAt: '2026-08-26T00:00:00Z' })
    applyMeView({ account: { id: 'account-desk', email: 'd@test' }, profile: { id: 'profile-d', handle: 'd', displayName: 'D', avatarUrl: null } })
    mocks.shared.mockResolvedValue({ items: [sharedItem('col-shared', 'Shared Shelf')], page: { hasMore: false, nextCursor: null } })
    mocks.invites.mockResolvedValue({ items: [inviteItem('inv-1')] })
  })

  afterEach(() => {
    cleanup()
    clearSession()
    clearRouteCache()
    document.body.innerHTML = ''
  })

  function mount(hook: 'shared' | 'invites') {
    mountTree(hook === 'shared' ? <SharedHarness /> : <InvitesHarness />)
  }

  it.each(['shared', 'invites'] as const)('%s renders its rows on the first frame after a remount', async (hook) => {
    mount(hook)
    await waitForDom(domFinishedLoading)
    expect(document.querySelector('[data-testid="list"]')?.getAttribute('data-count')).toBe('1')

    cleanup()
        document.body.innerHTML = '<div id="root"></div>'
    const settled = seen.length
    mount(hook)

    // No settle(): the sidebar must paint from the cache immediately, and must
    // never report an empty list or a loading state while revalidating.
    expect(document.querySelector('[data-testid="list"]')?.getAttribute('data-count')).toBe('1')
    expect(seen.slice(settled).every(({ count }) => count === 1)).toBe(true)
    expect(seen.slice(settled).every(({ state }) => state !== 'loading')).toBe(true)
    await waitForDom(domFinishedLoading)
  })

  it('keeps the invitation rows while accepting one revalidates the list', async () => {
    mocks.accept.mockResolvedValue({
      collectionId: 'col-shared', subjectId: 'sub-b', role: 'editor',
      grantedAt: '2026-08-19T00:00:00Z', policyEtag: '"p-2"',
    })
    mount('invites')
    await waitForDom(domFinishedLoading)
    const settled = seen.length

    // Hold the post-accept reload open so the window where the block could be
    // empty is observable rather than batched away.
    let releaseReload: ((page: { items: unknown[] }) => void) | undefined
    mocks.invites.mockImplementationOnce(() => new Promise((resolve) => { releaseReload = resolve }))
    let accepted!: Promise<unknown>
    await act(async () => {
      accepted = acceptFirst!()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(releaseReload).toBeDefined()
    expect(seen.slice(settled).every(({ count }) => count === 1)).toBe(true)

    await act(async () => {
      releaseReload?.({ items: [] })
      await accepted
    })
    expect(document.querySelector('[data-testid="list"]')?.getAttribute('data-count')).toBe('0')
  })
})

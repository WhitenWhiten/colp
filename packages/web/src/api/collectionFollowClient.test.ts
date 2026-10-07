// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession } from './sessionStore'
import { productClient } from './productClient'

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaA'
const COLLECTION = 'cccccccccccccccccccccA'

function followState(overrides: { following?: boolean; followerCount?: number; followedAt?: string | null } = {}) {
  return {
    following: overrides.following ?? false,
    followerCount: overrides.followerCount ?? 0,
    followedAt: overrides.followedAt === undefined ? null : overrides.followedAt,
  }
}

describe('generated Collection Follow client bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    clearSession()
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-collection-follow-test',
      idleExpiresAt: '2026-08-26T02:00:00.000Z',
      absoluteExpiresAt: '2026-08-26T03:00:00.000Z',
    })
    applyMeView({
      account: { id: 'account-collection-follow-test', email: null },
      profile: { id: ACTOR, handle: 'actor', displayName: 'Actor', avatarUrl: null },
    })
  })

  it('keeps the product client frozen and exposes the four collection-follow methods', () => {
    expect(Object.isFrozen(productClient)).toBe(true)
    expect(typeof productClient.getCollectionFollowState).toBe('function')
    expect(typeof productClient.followCollection).toBe('function')
    expect(typeof productClient.unfollowCollection).toBe('function')
    expect(typeof productClient.listFollowedCollections).toBe('function')
  })

  it('reads authority from GET /collections/{collectionId}/follow with credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(
      followState({ following: true, followerCount: 4, followedAt: '2026-08-26T01:00:00.000Z' }),
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.getCollectionFollowState(COLLECTION, { maxRetries: 0 })).resolves.toEqual({
      following: true,
      followerCount: 4,
      followedAt: '2026-08-26T01:00:00.000Z',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: `/api/v1/collections/${COLLECTION}/follow` }),
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i)
  })

  it('follows with CSRF and a Known-Command-Id, then reuses that id on exact retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('connection reset after send'))
      .mockResolvedValueOnce(new Response(JSON.stringify(
        followState({ following: true, followerCount: 1, followedAt: '2026-08-26T01:00:00.000Z' }),
      ), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const options = { intentId: `collection-follow:${ACTOR}:${COLLECTION}:follow`, maxRetries: 0 }
    await expect(productClient.followCollection(COLLECTION, options)).rejects.toMatchObject({ code: 'transport_error' })
    await expect(productClient.followCollection(COLLECTION, options)).resolves.toMatchObject({
      following: true, followerCount: 1,
    })

    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Known-Command-Id')
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Known-Command-Id')
    expect(first).toMatch(/^[0-9a-f-]{36}$/u)
    expect(second).toBe(first)
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-collection-follow-test')
    expect((fetchMock.mock.calls[1]?.[0] as URL).pathname).toBe(`/api/v1/collections/${COLLECTION}/follow`)
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('PUT')
    expect(sessionStorage.getItem(`known.command-id.v1:${options.intentId}`)).toBeNull()
  })

  it('unfollows with DELETE, CSRF, and Known-Command-Id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(
      followState({ following: false, followerCount: 0 }),
    ), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.unfollowCollection(COLLECTION, {
      intentId: `collection-follow:${ACTOR}:${COLLECTION}:unfollow`,
      maxRetries: 0,
    })).resolves.toMatchObject({ following: false, followerCount: 0 })

    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-collection-follow-test')
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Known-Command-Id')).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('does not rotate the command id on same-ID conflict', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: {
        code: 'command_id_reused', message: 'different command binding',
        recovery: 'user_action', sameRequestRetrySafe: false,
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    const options = { intentId: `collection-follow:${ACTOR}:${COLLECTION}:follow`, maxRetries: 0 }

    await expect(productClient.followCollection(COLLECTION, options)).rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.followCollection(COLLECTION, options)).rejects.toMatchObject({ code: 'command_id_reused' })
    const ids = fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers).get('Known-Command-Id'))
    expect(ids[1]).toBe(ids[0])
  })

  it('surfaces GET 404 as resource_not_found without falling back to mock data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 'resource_not_found', message: 'not found',
        recovery: 'user_action', sameRequestRetrySafe: false,
      },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.getCollectionFollowState(COLLECTION, { maxRetries: 0 })).rejects.toMatchObject({
      status: 404,
      code: 'resource_not_found',
    })
  })

  it('does not wrap AbortError from getCollectionFollowState as a ProductApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    await expect(productClient.getCollectionFollowState(COLLECTION, { maxRetries: 0 }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('lists followed collections from GET /me/followed-collections with credentials', async () => {
    const page = {
      items: [{
        collectionId: COLLECTION,
        slug: 'design-notes',
        title: 'Design notes',
        summary: 'A public shelf',
        kind: 'bookmarks',
        owner: { profileId: ACTOR, handle: 'actor', displayName: 'Actor', avatarUrl: null },
        updatedAt: '2026-08-26T01:00:00.000Z',
        followedAt: '2026-08-26T00:00:00.000Z',
      }],
      nextCursor: 'followed-page-2',
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(page), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))

    await expect(productClient.listFollowedCollections({ limit: 20 }, { maxRetries: 0 })).resolves.toEqual(page)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/v1/me/followed-collections' }),
      expect.objectContaining({ credentials: 'include' }),
    )
    const url = fetchMock.mock.calls[0]?.[0] as URL
    expect(url.searchParams.get('limit')).toBe('20')
    expect(url.searchParams.get('cursor')).toBeNull()
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i)
  })

  it('sends only cursor on a followed-collections continuation page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      items: [],
      nextCursor: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.listFollowedCollections({ cursor: 'followed-page-2' }, { maxRetries: 0 }))
      .resolves.toEqual({ items: [], nextCursor: null })
    const url = fetchMock.mock.calls[0]?.[0] as URL
    expect(url.pathname).toBe('/api/v1/me/followed-collections')
    expect(url.searchParams.get('cursor')).toBe('followed-page-2')
    expect(url.searchParams.get('limit')).toBeNull()
  })

  it('surfaces list 404 as resource_not_found without falling back to mock data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 'resource_not_found', message: 'not found',
        recovery: 'user_action', sameRequestRetrySafe: false,
      },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.listFollowedCollections({}, { maxRetries: 0 })).rejects.toMatchObject({
      status: 404,
      code: 'resource_not_found',
    })
  })

  it('does not wrap AbortError from listFollowedCollections as a ProductApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    await expect(productClient.listFollowedCollections({}, { maxRetries: 0 }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })
})

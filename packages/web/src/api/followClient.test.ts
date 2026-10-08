// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession } from './sessionStore'
import { productClient } from './productClient'

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaA'
const TARGET = 'bbbbbbbbbbbbbbbbbbbbbA'

describe('generated Follow client bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    clearSession()
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-follow-test',
      idleExpiresAt: '2026-07-29T02:00:00.000Z',
      absoluteExpiresAt: '2026-07-29T03:00:00.000Z',
    })
    applyMeView({
      account: { id: 'account-follow-test', email: null },
      profile: { id: ACTOR, handle: 'actor', displayName: 'Actor', avatarUrl: null },
    })
  })

  it('uses the production generated runtime for private following pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ profileId: TARGET, handle: 'target', displayName: 'Target', avatarUrl: null }],
      nextCursor: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.isFollowingProfile(ACTOR, TARGET, { maxRetries: 0 })).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: `/api/v1/profiles/${ACTOR}/following` }),
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('uses the production generated runtime for private follower pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      items: [{ profileId: ACTOR, handle: 'actor', displayName: 'Actor', avatarUrl: null }],
      nextCursor: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.getFollowersPage(TARGET, { limit: 100 }, { maxRetries: 0 })).resolves.toMatchObject({
      items: [{ profileId: ACTOR }],
      nextCursor: null,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: `/api/v1/profiles/${TARGET}/followers` }),
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('scans following with limit on the first page and only cursor afterwards', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ profileId: 'cccccccccccccccccccccA', handle: 'other', displayName: 'Other', avatarUrl: null }],
        nextCursor: 'follow-page-2',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ profileId: TARGET, handle: 'target', displayName: 'Target', avatarUrl: null }],
        nextCursor: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.isFollowingProfile(ACTOR, TARGET, { maxRetries: 0 })).resolves.toBe(true)

    const first = fetchMock.mock.calls[0]?.[0] as URL
    const second = fetchMock.mock.calls[1]?.[0] as URL
    expect(first.pathname).toBe(`/api/v1/profiles/${ACTOR}/following`)
    expect(first.searchParams.get('limit')).toBe('100')
    expect(first.searchParams.get('cursor')).toBeNull()
    expect(second.pathname).toBe(`/api/v1/profiles/${ACTOR}/following`)
    expect(second.searchParams.get('cursor')).toBe('follow-page-2')
    expect(second.searchParams.get('limit')).toBeNull()
  })

  it('reuses one Known-Command-Id for an exact retry and clears it after success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('connection reset after send'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        actorProfileId: ACTOR,
        targetProfileId: TARGET,
        following: true,
        changedAt: '2026-07-29T01:00:00.000Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const options = { intentId: `follow:${ACTOR}:${TARGET}:follow`, maxRetries: 0 }
    await expect(productClient.followProfile(TARGET, options)).rejects.toMatchObject({ code: 'transport_error' })
    await expect(productClient.followProfile(TARGET, options)).resolves.toMatchObject({ following: true })

    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Known-Command-Id')
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Known-Command-Id')
    expect(first).toMatch(/^[0-9a-f-]{36}$/u)
    expect(second).toBe(first)
    expect(sessionStorage.getItem(`known.command-id.v1:${options.intentId}`)).toBeNull()
  })

  it('does not rotate the command id on same-ID conflict', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: {
        code: 'command_id_reused', message: 'different command binding',
        recovery: 'user_action', sameRequestRetrySafe: false,
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    const options = { intentId: `follow:${ACTOR}:${TARGET}:follow`, maxRetries: 0 }

    await expect(productClient.followProfile(TARGET, options)).rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.followProfile(TARGET, options)).rejects.toMatchObject({ code: 'command_id_reused' })
    const ids = fetchMock.mock.calls.map((call) => new Headers(call[1]?.headers).get('Known-Command-Id'))
    expect(ids[1]).toBe(ids[0])
  })
})

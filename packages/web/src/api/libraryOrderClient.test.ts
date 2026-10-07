// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMeView, applySessionView, clearSession } from './sessionStore'
import { productClient } from './productClient'

const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaA'
const COLLECTION = 'cccccccccccccccccccccA'

function emptyOrder() {
  return { sections: { mine: [] as string[], shared: [] as string[], following: [] as string[] } }
}

describe('generated Library order client bridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    sessionStorage.clear()
    clearSession()
    applySessionView({
      authenticated: true,
      csrfToken: 'csrf-library-order-test',
      idleExpiresAt: '2026-08-26T02:00:00.000Z',
      absoluteExpiresAt: '2026-08-26T03:00:00.000Z',
    })
    applyMeView({
      account: { id: 'account-library-order-test', email: null },
      profile: { id: ACTOR, handle: 'actor', displayName: 'Actor', avatarUrl: null },
    })
  })

  it('keeps the product client frozen and exposes the library-order methods', () => {
    expect(Object.isFrozen(productClient)).toBe(true)
    expect(typeof productClient.getMyLibraryOrder).toBe('function')
    expect(typeof productClient.updateMyLibraryOrder).toBe('function')
    expect(typeof productClient.abandonLibraryOrderIntent).toBe('function')
  })

  it('reads the sidebar order from GET /me/library-order with credentials', async () => {
    const view = {
      sections: { mine: [COLLECTION], shared: [], following: [] },
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(view), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))

    await expect(productClient.getMyLibraryOrder({ maxRetries: 0 })).resolves.toEqual(view)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/api/v1/me/library-order' }),
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? 'GET').toMatch(/^GET$/i)
  })

  it('updates a section with CSRF and a Known-Command-Id, then reuses that id on exact retry', async () => {
    const body = { collectionIds: [COLLECTION] }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('connection reset after send'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        section: 'mine',
        collectionIds: [COLLECTION],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const options = { intentId: `library-order:mine:${ACTOR}`, maxRetries: 0 }
    await expect(productClient.updateMyLibraryOrder('mine', body, options)).rejects.toMatchObject({
      code: 'transport_error',
    })
    await expect(productClient.updateMyLibraryOrder('mine', body, options)).resolves.toMatchObject({
      section: 'mine',
      collectionIds: [COLLECTION],
    })

    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Known-Command-Id')
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('Known-Command-Id')
    expect(first).toMatch(/^[0-9a-f-]{36}$/u)
    expect(second).toBe(first)
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-library-order-test')
    expect((fetchMock.mock.calls[1]?.[0] as URL).pathname).toBe('/api/v1/me/library-order/mine')
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('PUT')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(body)
  })

  it('does not rotate the command id on same-ID conflict', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: {
        code: 'command_id_reused', message: 'different command binding',
        recovery: 'user_action', sameRequestRetrySafe: false,
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }))
    const options = { intentId: `library-order:shared:${ACTOR}`, maxRetries: 0 }

    await expect(productClient.updateMyLibraryOrder('shared', { collectionIds: [] }, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    await expect(productClient.updateMyLibraryOrder('shared', { collectionIds: [] }, options))
      .rejects.toMatchObject({ code: 'command_id_reused' })
    const ids = vi.mocked(globalThis.fetch).mock.calls.map((call) =>
      new Headers(call[1]?.headers).get('Known-Command-Id'),
    )
    expect(ids[1]).toBe(ids[0])
  })

  it('surfaces GET 401 as authentication_required without inventing an empty order', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      error: {
        code: 'authentication_required', message: 'sign in',
        recovery: 'user_action', sameRequestRetrySafe: false,
      },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }))

    await expect(productClient.getMyLibraryOrder({ maxRetries: 0 })).rejects.toMatchObject({
      status: 401,
      code: 'authentication_required',
    })
    expect(emptyOrder().sections.mine).toEqual([])
  })

  it('does not wrap AbortError from getMyLibraryOrder as a ProductApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    await expect(productClient.getMyLibraryOrder({ maxRetries: 0 }))
      .rejects.toMatchObject({ name: 'AbortError' })
  })

  it('clears a stored command id through abandonLibraryOrderIntent', () => {
    const intentId = `library-order:following:${ACTOR}`
    const commandId = productClient.newCommandId()
    sessionStorage.setItem(`known.command-id.v1:${intentId}`, commandId)
    productClient.abandonLibraryOrderIntent(intentId)
    expect(sessionStorage.getItem(`known.command-id.v1:${intentId}`)).toBeNull()
  })
})

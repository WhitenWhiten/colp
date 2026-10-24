// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createActivityApi, isActivityUnavailableError } from './activityClient'
import { applySessionView, clearSession } from './sessionStore'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('activity client', () => {
  beforeEach(() => {
    applySessionView({ authenticated: true, csrfToken: 'csrf-activity', idleExpiresAt: '2099-01-01T00:00:00Z', absoluteExpiresAt: '2099-01-01T00:00:00Z' })
    sessionStorage.clear()
  })
  afterEach(() => clearSession())

  it('builds a paged cookie GET with an encoded cursor and abort signal', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { items: [], nextCursor: 'next', unreadCount: 3 }))
    const controller = new AbortController()
    await createActivityApi(fetcher).listActivity({ state: 'unread', cursor: 'signed+/=', limit: 25 }, controller.signal)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('/api/v1/me/activity?state=unread&cursor=signed%2B%2F%3D&limit=25')
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store' })
    expect(new Headers(init?.headers).get('Known-Command-Id')).toBeNull()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('marks through an item with CSRF, Origin and a command id', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { readCount: 7, unreadCount: 0 }))
    await createActivityApi(fetcher).markActivityRead({ through: 'activity-newest', throughRevision: '1' })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('/api/v1/me/activity/read')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: '{"through":"activity-newest","throughRevision":"1"}' })
    const headers = new Headers(init?.headers)
    expect(headers.get('X-CSRF-Token')).toBe('csrf-activity')
    expect(headers.get('Origin')).toBe(window.location.origin)
    expect(headers.get('Known-Command-Id')).toMatch(/^[0-9a-f-]{36}$/u)
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('preserves the command after an unknown outcome and releases it after success', async () => {
    const responses = [json(503, {}), json(200, { readCount: 1, unreadCount: 0 }), json(200, { readCount: 0, unreadCount: 0 })]
    const fetcher = vi.fn<typeof fetch>(async () => responses.shift()!)
    const api = createActivityApi(fetcher)
    await expect(api.markActivityRead({ ids: ['a'] })).rejects.toMatchObject({ status: 503 })
    await api.markActivityRead({ ids: ['a'] })
    await api.markActivityRead({ ids: ['a'] })
    const ids = fetcher.mock.calls.map(([, init]) => new Headers(init?.headers).get('Known-Command-Id'))
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
  })

  it('retains the command while the original request is in progress', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json(409, { error: { code: 'command_in_progress', message: 'Still running' } }))
      .mockResolvedValueOnce(json(200, { readCount: 1, unreadCount: 0 }))
    const api = createActivityApi(fetcher)
    await expect(api.markActivityRead({ ids: ['a'] })).rejects.toMatchObject({ code: 'command_in_progress' })
    await api.markActivityRead({ ids: ['a'] })
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).get('Known-Command-Id'))
      .toBe(new Headers(fetcher.mock.calls[1]![1]?.headers).get('Known-Command-Id'))
  })

  it('keeps a missing endpoint identifiable as feature unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(404, { error: { code: 'resource_not_found', message: 'Not found' } }))
    try { await createActivityApi(fetcher).getActivitySummary() } catch (error) {
      expect(isActivityUnavailableError(error)).toBe(true)
      expect(error).toMatchObject({ status: 404 })
      return
    }
    throw new Error('Expected a missing endpoint')
  })

  it('rejects unusable counts instead of publishing them', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { unreadCount: -1, revision: '1', latest: null }))
    await expect(createActivityApi(fetcher).getActivitySummary()).rejects.toMatchObject({ code: 'invalid_document' })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import { seedAuthenticatedSession } from './test-helpers'

const item = {
  notificationId: 'notification-1', notificationType: 'follow_activity' as const,
  actorProfileId: 'profile-2', subject: { type: 'profile' as const, id: 'profile-2' },
  state: 'unread' as const, stateRevision: '4', readAt: null,
  occurredAt: '2026-07-29T08:00:00.000Z',
}

describe('P5-22 Product Notification client adapter', () => {
  beforeEach(() => { vi.restoreAllMocks(); seedAuthenticatedSession('csrf-p522') })

  it('maps authoritative pages and opaque cursor continuation through generated transport', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      items: [item], nextCursor: 'sealed cursor', unreadCount: 19,
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }))
    await expect(productClient.getNotificationPage({ state: 'unread', limit: 2 }, { maxRetries: 0 }))
      .resolves.toMatchObject({ unreadCount: 19 })
    let [url, init] = fetchMock.mock.calls[0]!
    expect(new URL(String(url)).pathname).toBe('/api/v1/notifications')
    expect(new URL(String(url)).searchParams.get('state')).toBe('unread')
    expect(new URL(String(url)).searchParams.get('limit')).toBe('2')
    expect(init).toMatchObject({ credentials: 'include' })

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [], nextCursor: null, unreadCount: 19 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await productClient.getNotificationPage({ cursor: 'sealed cursor' }, { maxRetries: 0 })
    ;[url] = fetchMock.mock.calls[1]!
    expect([...new URL(String(url)).searchParams.keys()]).toEqual(['cursor'])
  })

  it('sends CSRF, strong revision ETag, credentials, and stable command id for exact retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      kind: 'succeeded', outcome: 'marked', notificationId: item.notificationId,
      state: 'read', stateRevision: '5', readAt: '2026-07-29T08:01:00.000Z', changed: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const options = { intentId: 'notification:read:notification-1', maxRetries: 0 }
    await productClient.markNotificationRead(item.notificationId, '4', options)
    const init = fetchMock.mock.calls[0]![1]!
    const headers = new Headers(init.headers)
    expect(init.credentials).toBe('include')
    expect(headers.get('X-CSRF-Token')).toBe('csrf-p522')
    expect(headers.get('If-Match')).toBe('"notification:4"')
    expect(headers.get('Known-Command-Id')).toMatch(/^[0-9a-f-]{36}$/u)
  })

  it('maps bounded bulk and channel-aware preference set/reset without hiding Product failures', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'succeeded', requestedCount: 2, markedCount: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ channel: 'in_app', enabled: true, revision: '7', updatedAt: '2026-07-29T08:00:00.000Z', email: { enabled: false, revision: '0', updatedAt: '2026-07-29T08:00:00.000Z', verifiedSender: 'no-reply@example.test', emailSuppressed: false, emailAvailable: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'succeeded', channel: 'in_app', enabled: false, revision: '8', updatedAt: '2026-07-29T08:01:00.000Z', changed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'succeeded', channel: 'email', enabled: true, revision: '1', updatedAt: '2026-07-29T08:02:00.000Z', changed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'precondition_failed', message: 'Stale revision', recovery: 'refresh', sameRequestRetrySafe: false } }), { status: 412, headers: { 'Content-Type': 'application/json' } }))
    await productClient.markNotificationsRead(['n1', 'n2'], { intentId: 'notification:bulk:1', maxRetries: 0 })
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ notificationIds: ['n1', 'n2'] })
    const preference = await productClient.getNotificationPreference({ maxRetries: 0 })
    expect(preference.email?.emailAvailable).toBe(true)
    await productClient.updateNotificationPreference('in_app', { mode: 'set', enabled: false }, preference.revision, { intentId: 'notification:preference:1', maxRetries: 0 })
    expect(new URL(String(fetchMock.mock.calls[2]![0])).pathname).toBe('/api/v1/notification-preferences/in_app')
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get('If-Match')).toBe('"notification-preference:in_app:7"')
    await productClient.updateNotificationPreference('email', { mode: 'set', enabled: true }, preference.email!.revision, { intentId: 'notification:preference:email:1', maxRetries: 0 })
    expect(new URL(String(fetchMock.mock.calls[3]![0])).pathname).toBe('/api/v1/notification-preferences/email')
    expect(new Headers(fetchMock.mock.calls[3]![1]?.headers).get('If-Match')).toBe('"notification-preference:email:0"')
    await expect(productClient.updateNotificationPreference('in_app', { mode: 'reset' }, '8', { intentId: 'notification:preference:2', maxRetries: 0 }))
      .rejects.toMatchObject({ status: 412, code: 'precondition_failed' })
  })
})

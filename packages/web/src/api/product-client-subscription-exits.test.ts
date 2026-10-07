// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { productClient } from './productClient'
import { applyMeView, applySessionView, clearSession } from './sessionStore'
const previewId = '11111111-1111-4111-8111-111111111111'
const source = { sourceType: 'collection' as const, sourceId: 'private-collection' }
const preview = { previewId, expiresAt: '2099-01-01T00:00:00Z', targets: [{ mappingId: 'mapping-1', profileLabel: 'Offline browser', effectiveAction: 'remove', policyOrigin: 'mapping' }] }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Known-Subscription-Session': 'session-a' } })
function mockFetch() {
  const fetcher = vi.fn<typeof fetch>()
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).endsWith('/api/v1/auth/get-session') ? Promise.resolve(json({ user: { id: 'account-a' }, session: { id: 'session-a', userId: 'account-a' } })) : fetcher(input, init))
  return fetcher
}
beforeEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); clearSession(); applySessionView({ authenticated: true, csrfToken: 'csrf-exit', idleExpiresAt: '2099-01-01', absoluteExpiresAt: '2099-01-01' }); applyMeView({ account: { id: 'account-a', email: null }, profile: { id: 'profile-a', handle: 'a', displayName: 'A', avatarUrl: null } }) })
afterEach(() => vi.restoreAllMocks())
it.each(['collection','digest_series'] as const)('previews %s unfollow then uses its existing DELETE with the frozen preview header', async sourceType => {
  const fetch = mockFetch().mockResolvedValueOnce(json(preview)).mockResolvedValueOnce(json({ following: false }))
  const ref = { ...source, sourceType }
  const value = await productClient.previewBookmarkSubscriptionExit(ref, null, { intentId: 'preview-one' })
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ trigger: 'unfollow', target: { kind: 'source', ...ref } })
  await productClient.confirmBookmarkSubscriptionExit(ref, value.previewId, true, { intentId: 'exit-one' })
  const [url, init] = fetch.mock.calls[1]!
  expect(url).toBe('/api/v1/' + (sourceType === 'collection' ? 'collections' : 'reports') + '/private-collection/follow')
  expect(init).toMatchObject({ method: 'DELETE', credentials: 'include', cache: 'no-store', redirect: 'error', body: undefined })
  expect(new Headers(init?.headers).get('Known-Subscription-Exit-Preview')).toBe(previewId)
  expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf-exit')
})
it('preserves the exact command on a lost response and keeps unsubscribe separate from unfollow', async () => {
  const fetch = mockFetch().mockRejectedValueOnce(new TypeError('Network failed')).mockResolvedValueOnce(json({ actions: [] },202))
  const options = { intentId: 'stable-exit', maxRetries: 0 }
  await expect(productClient.confirmBookmarkSubscriptionExit(source, previewId, false, options)).rejects.toThrow()
  await productClient.confirmBookmarkSubscriptionExit(source, previewId, false, options)
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/v1/me/bookmark-subscription-exits','/api/v1/me/bookmark-subscription-exits'])
  expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Known-Command-Id')).toBe(new Headers(fetch.mock.calls[1]![1]?.headers).get('Known-Command-Id'))
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ previewId })
})
it('does not automatically replace a stale preview or retry 412 under a new policy', async () => {
  const fetch = mockFetch().mockResolvedValue(json({ error: { code: 'precondition_failed', message: 'Changed', recovery: 'user_action', sameRequestRetrySafe: false } },412))
  await expect(productClient.confirmBookmarkSubscriptionExit(source, previewId, true, { intentId: 'stale' })).rejects.toMatchObject({ status: 412 })
  expect(fetch).toHaveBeenCalledTimes(1)
})
it('reads independent account subscription pages and fences an identity change', async () => {
  const fetch = mockFetch().mockResolvedValueOnce(json({ items: [], nextCursor: 'opaque' })).mockResolvedValueOnce(json({ items: [{ ...source, subscriptionId: 'sub-1', status: 'active' }], nextCursor: null }))
  expect(await productClient.findBookmarkSubscription(source)).toMatchObject({ subscriptionId: 'sub-1' })
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/me/bookmark-subscriptions?status=active&limit=50')
  expect(fetch.mock.calls[1]?.[0]).toBe('/api/v1/me/bookmark-subscriptions?cursor=opaque')
  fetch.mockImplementationOnce(async () => { clearSession(); return json(preview) })
  await expect(productClient.previewBookmarkSubscriptionExit(source,null,{ intentId: 'identity' })).rejects.toMatchObject({ status: 401 })
})

it('rejects a replacement cookie session before applying an exit result or refreshing the actor', async () => {
  const fetcher = mockFetch().mockResolvedValue(new Response(JSON.stringify({ actions: [] }), { status: 202, headers: { 'Content-Type': 'application/json', 'Known-Subscription-Session': 'replacement-session' } }))
  await expect(productClient.confirmBookmarkSubscriptionExit(source, previewId, false, { intentId: 'cookie-swap' })).rejects.toMatchObject({ status: 401 })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(vi.mocked(globalThis.fetch).mock.calls.map(call => String(call[0]))).not.toContain('/api/v1/session')
})

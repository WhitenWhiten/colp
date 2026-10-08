import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBookmarkSubscription, subscriptionDeployment } from './bookmarkSubscriptionBridge'
const extensionId = 'pplpnpegpnghcddhmpgkbfkdfadjiaen'
const requestId = '12345678-1234-4123-8123-123456789abc'
afterEach(() => vi.unstubAllEnvs())
describe('bookmark subscription reference bridge', () => {
  it('only transmits the allowed source fields and requires protocol acknowledgement', async () => {
    const sendMessage = vi.fn((_id: string, _message: unknown, reply: (value: unknown) => void) => reply({ accepted: true, protocolVersion: 1 }))
    expect(await openBookmarkSubscription({ sourceType: 'digest_series', sourceId: 'series-id', serverOrigin: 'https://evil.test' } as never, requestId, { extensionId, runtime: { sendMessage } })).toBe('accepted')
    expect(sendMessage.mock.calls[0]?.[1]).toEqual({ kind: 'known.subscription.open', requestId, sourceType: 'digest_series', sourceId: 'series-id' })
    expect(await openBookmarkSubscription({ sourceType: 'collection', sourceId: 'id' }, requestId, { extensionId, runtime: { sendMessage: (_id, _body, cb) => cb({ ok: true }) } })).toBe('unavailable')
  })
  it('fails closed for bad IDs, absent extension and timeout', async () => {
    const sendMessage = vi.fn()
    expect(await openBookmarkSubscription({ sourceType: 'collection', sourceId: 'https://evil.test' }, requestId, { extensionId, runtime: { sendMessage } })).toBe('unavailable')
    expect(sendMessage).not.toHaveBeenCalled()
    expect(await openBookmarkSubscription({ sourceType: 'collection', sourceId: 'id' }, requestId, { extensionId, runtime: { sendMessage }, timeoutMs: 1 })).toBe('unavailable')
  })
  it('only exposes explicitly published deployment IDs and HTTPS stores', () => {
    vi.stubEnv('VITE_KNOWN_EXTENSION_ID', extensionId)
    vi.stubEnv('VITE_KNOWN_EXTENSION_STORE_URL', 'https://evil.test/install')
    expect(subscriptionDeployment()).toEqual({ extensionId, storeUrl: null })
    vi.stubEnv('VITE_KNOWN_EXTENSION_ID', 'anything')
    expect(subscriptionDeployment().extensionId).toBeNull()
  })
})

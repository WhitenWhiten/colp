import { getApiBaseUrl } from './config'
import { subscriptionSessionFetch, SubscriptionSessionChanged } from './subscriptionSessionFetch'
import { ProductApiError } from './errors'
import { createProductTransportHttp } from './product-transport-http'
import type { MutationCall, MutationOptions } from './product-client-shared'
import { getSessionSnapshot, privateSessionIdentity, subscribeSession } from './sessionStore'
import type { BookmarkSubscriptionSource } from '../lib/bookmarkSubscriptionBridge'
export type SubscriptionExitTarget = { mappingId: string; profileLabel: string; effectiveAction: 'keep'|'remove'; policyOrigin: 'mapping'|'global'|'authority' }
export type SubscriptionExitPreview = { previewId: string; expiresAt: string; targets: SubscriptionExitTarget[] }
export type SubscriptionConfiguration = BookmarkSubscriptionSource & { subscriptionId: string; status: 'active'|'terminated' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function fail(message: string, status = 502): never { throw new ProductApiError({ status, code: status === 401 ? 'authentication_required' : 'invalid_response', message, recovery: 'user_action', sameRequestRetrySafe: false }) }
function assertActor(identity: string) { if (!getSessionSnapshot().authenticated || privateSessionIdentity() !== identity) fail('Your session changed. Sign in and review the affected mappings again.', 401) }
function validateSource(source: BookmarkSubscriptionSource) { if (!['collection','digest_series'].includes(source.sourceType) || !/^[A-Za-z0-9._~-]{1,128}$/.test(source.sourceId)) fail('Invalid source',400) }
export function createBookmarkSubscriptionWebClient(mutationCall: MutationCall) {
  const http = createProductTransportHttp({ baseUrl: getApiBaseUrl(), fetchImpl: subscriptionSessionFetch })
  async function mutate<T>(path: string, method: string, body: unknown, options: MutationOptions, extra: Record<string,string> = {}): Promise<T> {
    const identity = privateSessionIdentity(); assertActor(identity)
    const scopeAbort = new AbortController(), signal = options.signal ? AbortSignal.any([scopeAbort.signal, options.signal]) : scopeAbort.signal
    const unsubscribe = subscribeSession(() => { if (privateSessionIdentity() !== identity) scopeAbort.abort() })
    try { return await mutationCall(async (csrfToken, commandIntentId) => {
      assertActor(identity)
      const result = await http.request<T>({ method, path, body, contentType: body === undefined ? undefined : 'application/json', signal, headers: http.mutationHeaders({ csrfToken, commandIntentId }, extra) }).catch(error => { if (error instanceof SubscriptionSessionChanged) { scopeAbort.abort(); fail(error.message, 401) } throw error })
      assertActor(identity); return result
    }, { ...options, signal, maxRetries: 0, rotateCommandOnConflict: false }) } finally { unsubscribe() }
  }
  return {
    async findBookmarkSubscription(source: BookmarkSubscriptionSource, signal?: AbortSignal): Promise<SubscriptionConfiguration | null> {
      validateSource(source); const identity = privateSessionIdentity(); assertActor(identity)
      let cursor: string | null = null; const seen = new Set<string>()
      do {
        const page: { items: SubscriptionConfiguration[]; nextCursor: string | null } = await http.request({ method: 'GET', path: '/api/v1/me/bookmark-subscriptions', query: cursor ? { cursor } : { status: 'active', limit: 50 }, signal })
        assertActor(identity)
        if (!page || !Array.isArray(page.items) || page.items.length > 50 || !(page.nextCursor === null || typeof page.nextCursor === 'string')) fail('Invalid subscription page')
        const match = page.items.find(item => item.sourceType === source.sourceType && item.sourceId === source.sourceId)
        if (match) return match
        cursor = page.nextCursor; if (cursor) { if (seen.has(cursor) || seen.size > 100) fail('Invalid subscription cursor'); seen.add(cursor) }
      } while (cursor)
      return null
    },
    async previewBookmarkSubscriptionExit(source: BookmarkSubscriptionSource, subscriptionId: string | null, options: MutationOptions): Promise<SubscriptionExitPreview> {
      validateSource(source)
      const body = subscriptionId ? { trigger: 'unsubscribe', target: { kind: 'subscription', subscriptionId } } : { trigger: 'unfollow', target: { kind: 'source', sourceType: source.sourceType, sourceId: source.sourceId } }
      const value = await mutate<unknown>('/api/v1/me/bookmark-subscription-exit-previews', 'POST', body, options)
      if (!record(value) || typeof value.previewId !== 'string' || !uuid.test(value.previewId) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || !Array.isArray(value.targets) || !value.targets.every(target => record(target) && typeof target.mappingId === 'string' && typeof target.profileLabel === 'string' && ['keep','remove'].includes(String(target.effectiveAction)) && ['global','mapping','authority'].includes(String(target.policyOrigin)))) fail('Invalid exit preview')
      return value as SubscriptionExitPreview
    },
    async confirmBookmarkSubscriptionExit(source: BookmarkSubscriptionSource, previewId: string, unfollow: boolean, options: MutationOptions): Promise<void> {
      validateSource(source); if (!uuid.test(previewId)) fail('Invalid exit preview',400)
      if (unfollow) {
        const resource = source.sourceType === 'collection' ? 'collections' : 'reports'
        await mutate('/api/v1/' + resource + '/' + encodeURIComponent(source.sourceId) + '/follow', 'DELETE', undefined, options, { 'Known-Subscription-Exit-Preview': previewId })
        const key = source.sourceType === 'collection' ? 'collection-follow' : 'report-follow'
        try { window.localStorage.setItem('known.' + key + '.invalidate.v1', source.sourceId + ':' + Date.now()); const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('known.' + key + '.v1'); channel?.postMessage(source.sourceType === 'collection' ? { collectionId: source.sourceId } : { reportId: source.sourceId }); channel?.close() } catch { /* Other tabs recheck on their next authority read. */ }
      } else await mutate('/api/v1/me/bookmark-subscription-exits', 'POST', { previewId }, options)
    },
  }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommunityNotification, CommunityNotificationPreference } from '@known/product-v1-client'
import { productClient } from '../api'
import { ProductApiError, wrapProductError } from '../api/errors'
import { readRouteCache, writeRouteCache } from './routeCache'

export type CommunityNotificationCenterState = 'flag-off' | 'loading' | 'ready' | 'empty' | 'error' | 'loading-more'
type ReadFilter = 'all' | 'unread'
type ReadOperation = { type: 'initial' | 'refresh' | 'more'; cursor?: string }
type MutationOperation =
  | { type: 'read'; notificationIds: string[]; intentId: string }
  | { type: 'preference'; enabled: boolean; intentId: string }
type CommunityPreference = { data: CommunityNotificationPreference; etag: string | null }
type Snapshot = {
  items: CommunityNotification[]
  unreadCount: number
  cursor: string | null
  hasMore: boolean
  preference: CommunityPreference | null
  state: CommunityNotificationCenterState
  error: ProductApiError | null
  mutationError: ProductApiError | null
  pending: MutationOperation['type'] | null
}

const CHANNEL_NAME = 'known.community-notifications.v1'
const STORAGE_KEY = 'known.community-notifications.refresh.v1'
const REFRESH_THROTTLE_MS = 500
const MAX_SEEN_REFRESH_MESSAGES = 64
const emptySnapshot: Snapshot = { items: [], unreadCount: 0, cursor: null, hasMore: false, preference: null, state: 'loading', error: null, mutationError: null, pending: null }

type CachedInbox = Pick<Snapshot, 'items' | 'unreadCount' | 'cursor' | 'hasMore' | 'preference'>

function cacheKey(read: ReadFilter | undefined) {
  return `community-notifications:${read ?? 'all'}`
}

function restoredSnapshot(input: { enabled: boolean; read?: ReadFilter }): Snapshot {
  if (!input.enabled) return { ...emptySnapshot, state: 'flag-off' }
  const cached = readRouteCache<CachedInbox>(cacheKey(input.read))
  if (cached === undefined || cached.items.length === 0) return emptySnapshot
  return { ...emptySnapshot, ...cached, state: 'ready' }
}

function mergeUnique(first: CommunityNotification[], second: CommunityNotification[]): CommunityNotification[] {
  const seen = new Set<string>()
  return [...first, ...second].filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

type RefreshMessage = { v: 1; type: 'authority-changed'; at: number; nonce: string }

function validRefreshMessage(value: unknown): value is RefreshMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.v === 1 && message.type === 'authority-changed'
    && typeof message.at === 'number' && Number.isFinite(message.at) && message.at > 0
    && typeof message.nonce === 'string' && message.nonce.length > 0 && message.nonce.length <= 128
}

/**
 * CS-05 community reply-notification inbox. Same load/pagination/read-retry
 * shape as useNotificationCenter but backed by the durable comment_reply
 * surface: reads page GET /api/v1/me/community-notifications, bulk read is a
 * receipted mutation, and the community-channel preference is an If-Match CAS
 * (the fresh-read ETag chains the write, mirroring the CS-04 comment manage
 * convention).
 */
export function useCommunityNotificationCenter(input: { enabled: boolean; read?: ReadFilter; limit?: number; includePreference?: boolean }) {
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const failedReadRef = useRef<ReadOperation>({ type: 'initial' })
  const failedMutationRef = useRef<MutationOperation | null>(null)
  const cursorsRef = useRef(new Set<string>())
  const inputRef = useRef(input)
  const channelRef = useRef<BroadcastChannel | null>(null)
  inputRef.current = input
  const [snapshot, setSnapshot] = useState<Snapshot>(() => restoredSnapshot(input))

  const executeRead = useCallback(async (generation: number, operation: ReadOperation) => {
    if (!inputRef.current.enabled) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    failedReadRef.current = operation
    setSnapshot((current) => {
      const revalidating = operation.type === 'initial' && current.items.length > 0
      return {
        ...(operation.type === 'initial' && !revalidating ? emptySnapshot : current),
        state: revalidating ? current.state : operation.type === 'more' ? 'loading-more' : 'loading',
        error: null,
      }
    })
    try {
      const query = operation.cursor
        ? { cursor: operation.cursor }
        : { read: inputRef.current.read ?? 'all' as const, limit: inputRef.current.limit ?? 20 }
      const [page, preference] = await Promise.all([
        productClient.getCommunityNotificationsPage(query, { maxRetries: 0, signal: controller.signal }),
        inputRef.current.includePreference
          ? productClient.getCommunityNotificationPreference({ maxRetries: 0, signal: controller.signal })
          : Promise.resolve(null),
      ])
      if (generation !== generationRef.current || controller.signal.aborted) return
      setSnapshot((current) => {
        const items = operation.type === 'more' ? mergeUnique(current.items, page.items) : page.items
        if (operation.type !== 'more') cursorsRef.current.clear()
        const cursorLoop = page.nextCursor !== null
          && (page.nextCursor === operation.cursor || cursorsRef.current.has(page.nextCursor))
        if (page.nextCursor && !cursorLoop) cursorsRef.current.add(page.nextCursor)
        const next: Snapshot = {
          ...current,
          items,
          unreadCount: page.unreadCount,
          cursor: cursorLoop ? null : page.nextCursor,
          hasMore: page.nextCursor !== null && !cursorLoop,
          preference: preference ?? current.preference,
          state: items.length ? 'ready' : 'empty',
          error: null,
        }
        writeRouteCache<CachedInbox>(cacheKey(inputRef.current.read), {
          items: next.items, unreadCount: next.unreadCount, cursor: next.cursor,
          hasMore: next.hasMore, preference: next.preference,
        })
        return next
      })
    } catch (reason) {
      if (controller.signal.aborted || generation !== generationRef.current) return
      const error = wrapProductError(reason)
      if (error.code === 'invalid_cursor') failedReadRef.current = { type: 'refresh' }
      setSnapshot((current) => current.items.length > 0 && operation.type === 'initial'
        ? current
        : { ...current, state: 'error', error })
    }
  }, [])

  const publishRefresh = useCallback(() => {
    const message = { v: 1 as const, type: 'authority-changed' as const, at: Date.now(), nonce: productClient.newCommandId() }
    channelRef.current?.postMessage(message)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(message))
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Storage can be unavailable; BroadcastChannel/focus refresh remain active.
    }
  }, [])

  const runMutation = useCallback(async (operation: MutationOperation) => {
    if (!inputRef.current.enabled) return
    failedMutationRef.current = operation
    setSnapshot((current) => ({ ...current, pending: operation.type, mutationError: null }))
    try {
      if (operation.type === 'read') {
        // Optimistic: paint the rows read before the durable write commits;
        // the authority refresh below replaces the guess either way.
        setSnapshot((current) => ({
          ...current,
          items: current.items.map((item) => operation.notificationIds.includes(item.id) ? { ...item, read: true } : item),
        }))
        await productClient.markCommunityNotificationsRead({ ids: [...operation.notificationIds] }, { intentId: operation.intentId, maxRetries: 0 })
      } else {
        // Preference CAS chains the fresh-read ETag (the getCommentWithEtag
        // convention): re-read, then conditional PUT. A concurrent change
        // between the two is a 412 surfaced as mutationError.
        const fresh = await productClient.getCommunityNotificationPreference({ maxRetries: 0 })
        if (fresh.etag === null) {
          // CS-04 discipline: a missing ETag never mints an If-Match value —
          // refuse the write, refresh the authority state, and surface the
          // same refresh-and-retry conflict a 412 would.
          await executeRead(generationRef.current, { type: 'refresh' })
          throw new ProductApiError({
            status: 409,
            code: 'revision_conflict',
            message: 'The community notification preference could not be confirmed; it was refreshed. Try again.',
            recovery: 'refresh_and_retry',
          })
        }
        const result = await productClient.updateCommunityNotificationPreference(
          { enabled: operation.enabled }, fresh.etag, { intentId: operation.intentId, maxRetries: 0 })
        setSnapshot((current) => ({ ...current, preference: result }))
      }
      failedMutationRef.current = null
      await executeRead(generationRef.current, { type: 'refresh' })
      publishRefresh()
      setSnapshot((current) => ({ ...current, pending: null, mutationError: null }))
    } catch (reason) {
      setSnapshot((current) => ({ ...current, pending: null, mutationError: wrapProductError(reason) }))
    }
  }, [executeRead, publishRefresh])

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    controllerRef.current?.abort()
    cursorsRef.current.clear()
    if (!input.enabled) {
      setSnapshot({ ...emptySnapshot, state: 'flag-off' })
      return () => controllerRef.current?.abort()
    }
    void executeRead(generation, { type: 'initial' })
    return () => controllerRef.current?.abort()
  }, [executeRead, input.enabled, input.includePreference, input.limit, input.read])

  useEffect(() => {
    if (!input.enabled) return
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = channel
    let lastRefreshAt = 0
    let timer: number | undefined
    const seenMessages = new Set<string>()
    const refresh = () => {
      const remaining = REFRESH_THROTTLE_MS - (Date.now() - lastRefreshAt)
      if (remaining > 0) {
        if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; refresh() }, remaining)
        return
      }
      lastRefreshAt = Date.now()
      void executeRead(generationRef.current, { type: 'refresh' })
    }
    const acceptMessage = (message: RefreshMessage) => {
      if (seenMessages.has(message.nonce)) return
      seenMessages.add(message.nonce)
      if (seenMessages.size > MAX_SEEN_REFRESH_MESSAGES) {
        const oldest = seenMessages.values().next().value
        if (oldest !== undefined) seenMessages.delete(oldest)
      }
      refresh()
    }
    const onMessage = (event: MessageEvent) => { if (validRefreshMessage(event.data)) acceptMessage(event.data) }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return
      try {
        const message: unknown = JSON.parse(event.newValue)
        if (validRefreshMessage(message)) acceptMessage(message)
      } catch { /* malformed low-trust message */ }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') refresh() }
    if (channel) channel.onmessage = onMessage
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
      document.removeEventListener('visibilitychange', onVisibility)
      channel?.close()
      if (channelRef.current === channel) channelRef.current = null
    }
  }, [executeRead, input.enabled])

  const retry = useCallback(() => { void executeRead(generationRef.current, failedReadRef.current) }, [executeRead])
  const refresh = useCallback(() => { void executeRead(generationRef.current, { type: 'refresh' }) }, [executeRead])
  const loadMore = useCallback(() => {
    if (snapshot.cursor && snapshot.hasMore && snapshot.state !== 'loading-more') void executeRead(generationRef.current, { type: 'more', cursor: snapshot.cursor })
  }, [executeRead, snapshot.cursor, snapshot.hasMore, snapshot.state])
  const markOne = useCallback((notificationId: string) => {
    const target = snapshot.items.find((item) => item.id === notificationId)
    if (!target || target.read) return
    void runMutation({ type: 'read', notificationIds: [notificationId], intentId: productClient.mutationIntentKey('community-notification-read', productClient.newCommandId()) })
  }, [runMutation, snapshot.items])
  const markVisibleRead = useCallback((visibleIds?: readonly string[]) => {
    const allowed = visibleIds ? new Set(visibleIds) : null
    const notificationIds = snapshot.items.filter((item) => !item.read
      && (allowed === null || allowed.has(item.id))).slice(0, 100).map((item) => item.id)
    if (notificationIds.length) void runMutation({ type: 'read', notificationIds, intentId: productClient.mutationIntentKey('community-notification-bulk-read', productClient.newCommandId()) })
  }, [runMutation, snapshot.items])
  const setPreference = useCallback((enabled: boolean) => {
    if (!snapshot.preference) return
    void runMutation({ type: 'preference', enabled, intentId: productClient.mutationIntentKey('community-notification-preference-set', productClient.newCommandId()) })
  }, [runMutation, snapshot.preference])
  const retryMutation = useCallback(() => { if (failedMutationRef.current) void runMutation(failedMutationRef.current) }, [runMutation])

  return { ...snapshot, retry, refresh, loadMore, markOne, markVisibleRead, setPreference, retryMutation }
}

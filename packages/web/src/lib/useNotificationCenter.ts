import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { productClient } from '../api'
import { ProductApiError, wrapProductError } from '../api/errors'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { readRouteCache, writeRouteCache } from './routeCache'
import type { NotificationItem, NotificationPreference, NotificationPreferenceUpdateResult } from '../api/types'

export type NotificationCenterState = 'flag-off' | 'loading' | 'ready' | 'empty' | 'error' | 'loading-more'
type FilterState = 'all' | 'read' | 'unread'
type ReadOperation = { type: 'initial' | 'refresh' | 'more'; cursor?: string }
type MutationOperation =
  | { type: 'one'; notificationId: string; stateRevision: string; intentId: string }
  | { type: 'many'; notificationIds: string[]; intentId: string }
  | { type: 'preference'; channel: 'in_app' | 'email'; value: { mode: 'set'; enabled: boolean } | { mode: 'reset' }; revision: string; intentId: string }
type Snapshot = {
  items: NotificationItem[]
  unreadCount: number
  cursor: string | null
  hasMore: boolean
  preference: NotificationPreference | null
  state: NotificationCenterState
  error: ProductApiError | null
  mutationError: ProductApiError | null
  pending: MutationOperation['type'] | null
}

const CHANNEL_NAME = 'known.notifications.v1'
const STORAGE_KEY = 'known.notifications.refresh.v1'
const REFRESH_THROTTLE_MS = 500
const MAX_SEEN_REFRESH_MESSAGES = 64
const emptySnapshot: Snapshot = { items: [], unreadCount: 0, cursor: null, hasMore: false, preference: null, state: 'loading', error: null, mutationError: null, pending: null }

type CachedInbox = Pick<Snapshot, 'items' | 'unreadCount' | 'cursor' | 'hasMore' | 'preference'>

function cacheKey(state: FilterState | undefined) {
  return `notifications:${state ?? 'all'}`
}

/** Restore the last painted inbox so a route round trip skips the skeleton. */
function restoredSnapshot(input: { enabled: boolean; state?: FilterState }): Snapshot {
  if (!input.enabled) return { ...emptySnapshot, state: 'flag-off' }
  const cached = readRouteCache<CachedInbox>(cacheKey(input.state))
  if (cached === undefined || cached.items.length === 0) return emptySnapshot
  return { ...emptySnapshot, ...cached, state: 'ready' }
}

function mergeUnique(first: NotificationItem[], second: NotificationItem[]): NotificationItem[] {
  const seen = new Set<string>()
  return [...first, ...second].filter((item) => {
    if (seen.has(item.notificationId)) return false
    seen.add(item.notificationId)
    return true
  })
}

function mergePreferenceResult(current: NotificationPreference | null, channel: 'in_app' | 'email', result: NotificationPreferenceUpdateResult): NotificationPreference | null {
  if (!current) return null
  if (channel === 'in_app') {
    return { ...current, enabled: result.enabled, revision: result.revision, updatedAt: result.updatedAt }
  }
  if (!current.email) return current
  return { ...current, email: { ...current.email, enabled: result.enabled, revision: result.revision, updatedAt: result.updatedAt } }
}

type RefreshMessage = { v: 1; type: 'authority-changed'; at: number; nonce: string }

function validRefreshMessage(value: unknown): value is RefreshMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return message.v === 1 && message.type === 'authority-changed'
    && typeof message.at === 'number' && Number.isFinite(message.at) && message.at > 0
    && typeof message.nonce === 'string' && message.nonce.length > 0 && message.nonce.length <= 128
}

export function useNotificationCenter(input: { enabled: boolean; state?: FilterState; limit?: number; includePreference?: boolean }) {
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const failedReadRef = useRef<ReadOperation>({ type: 'initial' })
  const failedMutationRef = useRef<MutationOperation | null>(null)
  const cursorsRef = useRef(new Set<string>())
  const inputRef = useRef(input)
  const channelRef = useRef<BroadcastChannel | null>(null)
  inputRef.current = input
  const [snapshot, setSnapshot] = useState<Snapshot>(() => restoredSnapshot(input))
  // Empty until a read for this session paints. A session change clears it so
  // a failed revalidation cannot keep the previous account's inbox.
  const paintedIdentityRef = useRef(privateSessionIdentity())
  const identityRef = useRef(paintedIdentityRef.current)
  const subscribeIdentity = useCallback((notify: () => void) => subscribeSession(() => {
    const next = privateSessionIdentity()
    if (next !== identityRef.current) {
      identityRef.current = next
      paintedIdentityRef.current = ''
      generationRef.current += 1
      controllerRef.current?.abort()
      failedReadRef.current = { type: 'initial' }
      failedMutationRef.current = null
      cursorsRef.current.clear()
      setSnapshot(inputRef.current.enabled ? { ...emptySnapshot } : { ...emptySnapshot, state: 'flag-off' })
    }
    notify()
  }), [])
  const identity = useSyncExternalStore(subscribeIdentity, privateSessionIdentity, privateSessionIdentity)

  const executeRead = useCallback(async (generation: number, operation: ReadOperation) => {
    if (!inputRef.current.enabled) return
    if (generation !== generationRef.current) return
    const requestedIdentity = privateSessionIdentity()
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    failedReadRef.current = operation
    setSnapshot((current) => {
      if (generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
      // An `initial` run after a remount revalidates rows already on screen —
      // TopNav keeps its unread badge the whole time, so the page blanking to a
      // skeleton was the only thing that looked like a cold load. Rows painted
      // for another session are not that inbox.
      const revalidating = operation.type === 'initial' && current.items.length > 0
        && paintedIdentityRef.current === requestedIdentity
      return {
        ...(operation.type === 'initial' && !revalidating ? emptySnapshot : current),
        state: revalidating ? current.state : operation.type === 'more' ? 'loading-more' : 'loading',
        error: null,
      }
    })
    try {
      const query = operation.cursor
        ? { cursor: operation.cursor }
        : { state: inputRef.current.state ?? 'all', limit: inputRef.current.limit ?? 20 }
      const [page, preference] = await Promise.all([
        productClient.getNotificationPage(query, { maxRetries: 0, signal: controller.signal }),
        inputRef.current.includePreference
          ? productClient.getNotificationPreference({ maxRetries: 0, signal: controller.signal })
          : Promise.resolve(null),
      ])
      if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return
      setSnapshot((current) => {
        if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
        paintedIdentityRef.current = requestedIdentity
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
        writeRouteCache<CachedInbox>(cacheKey(inputRef.current.state), {
          items: next.items, unreadCount: next.unreadCount, cursor: next.cursor,
          hasMore: next.hasMore, preference: next.preference,
        }, requestedIdentity)
        return next
      })
    } catch (reason) {
      if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return
      const error = wrapProductError(reason)
      if (error.code === 'invalid_cursor') failedReadRef.current = { type: 'refresh' }
      setSnapshot((current) => {
        if (generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
        // A failed revalidation keeps the inbox already rendered for this
        // session. It must not keep rows painted for a session that ended.
        if (paintedIdentityRef.current !== requestedIdentity) return { ...emptySnapshot, state: 'error', error }
        return current.items.length > 0 && operation.type === 'initial'
          ? current
          : { ...current, state: 'error', error }
      })
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
    const requestedIdentity = privateSessionIdentity()
    if (requestedIdentity !== privateSessionIdentity()) return
    failedMutationRef.current = operation
    setSnapshot((current) => {
      if (requestedIdentity !== privateSessionIdentity()) return current
      return { ...current, pending: operation.type, mutationError: null }
    })
    try {
      let preferenceResult: NotificationPreferenceUpdateResult | null = null
      let preferenceChannel: 'in_app' | 'email' | null = null
      if (operation.type === 'one') {
        await productClient.markNotificationRead(operation.notificationId, operation.stateRevision, { intentId: operation.intentId, maxRetries: 0 })
      } else if (operation.type === 'many') {
        await productClient.markNotificationsRead(operation.notificationIds, { intentId: operation.intentId, maxRetries: 0 })
      } else {
        preferenceChannel = operation.channel
        preferenceResult = await productClient.updateNotificationPreference(operation.channel, operation.value, operation.revision, { intentId: operation.intentId, maxRetries: 0 })
      }
      if (requestedIdentity !== privateSessionIdentity()) return
      failedMutationRef.current = null
      if (preferenceResult && preferenceChannel) setSnapshot((current) => {
        if (requestedIdentity !== privateSessionIdentity()) return current
        return { ...current, preference: mergePreferenceResult(current.preference, preferenceChannel, preferenceResult), pending: null }
      })
      await executeRead(generationRef.current, { type: 'refresh' })
      if (requestedIdentity !== privateSessionIdentity()) return
      publishRefresh()
      setSnapshot((current) => {
        if (requestedIdentity !== privateSessionIdentity()) return current
        return { ...current, pending: null, mutationError: null }
      })
    } catch (reason) {
      if (requestedIdentity !== privateSessionIdentity()) return
      setSnapshot((current) => {
        if (requestedIdentity !== privateSessionIdentity()) return current
        return { ...current, pending: null, mutationError: wrapProductError(reason) }
      })
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
    if (paintedIdentityRef.current !== identity) setSnapshot({ ...emptySnapshot })
    void executeRead(generation, { type: 'initial' })
    return () => controllerRef.current?.abort()
  }, [executeRead, identity, input.enabled, input.includePreference, input.limit, input.state])

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
    const target = snapshot.items.find((item) => item.notificationId === notificationId)
    if (!target || target.state === 'read') return
    void runMutation({ type: 'one', notificationId, stateRevision: target.stateRevision, intentId: productClient.mutationIntentKey('notification-read', productClient.newCommandId()) })
  }, [runMutation, snapshot.items])
  const markVisibleRead = useCallback((visibleIds?: readonly string[]) => {
    const allowed = visibleIds ? new Set(visibleIds) : null
    const notificationIds = snapshot.items.filter((item) => item.state === 'unread'
      && (allowed === null || allowed.has(item.notificationId))).slice(0, 100).map((item) => item.notificationId)
    if (notificationIds.length) void runMutation({ type: 'many', notificationIds, intentId: productClient.mutationIntentKey('notification-bulk-read', productClient.newCommandId()) })
  }, [runMutation, snapshot.items])
  const setPreference = useCallback((enabled: boolean) => {
    if (!snapshot.preference) return
    void runMutation({ type: 'preference', channel: 'in_app', value: { mode: 'set', enabled }, revision: snapshot.preference.revision, intentId: productClient.mutationIntentKey('notification-preference-set', productClient.newCommandId()) })
  }, [runMutation, snapshot.preference])
  const resetPreference = useCallback(() => {
    if (!snapshot.preference) return
    void runMutation({ type: 'preference', channel: 'in_app', value: { mode: 'reset' }, revision: snapshot.preference.revision, intentId: productClient.mutationIntentKey('notification-preference-reset', productClient.newCommandId()) })
  }, [runMutation, snapshot.preference])
  const setEmailPreference = useCallback((enabled: boolean) => {
    if (!snapshot.preference?.email) return
    void runMutation({ type: 'preference', channel: 'email', value: { mode: 'set', enabled }, revision: snapshot.preference.email.revision, intentId: productClient.mutationIntentKey('notification-email-preference-set', productClient.newCommandId()) })
  }, [runMutation, snapshot.preference])
  const resetEmailPreference = useCallback(() => {
    if (!snapshot.preference?.email) return
    void runMutation({ type: 'preference', channel: 'email', value: { mode: 'reset' }, revision: snapshot.preference.email.revision, intentId: productClient.mutationIntentKey('notification-email-preference-reset', productClient.newCommandId()) })
  }, [runMutation, snapshot.preference])
  const retryMutation = useCallback(() => { if (failedMutationRef.current) void runMutation(failedMutationRef.current) }, [runMutation])

  return { ...snapshot, retry, refresh, loadMore, markOne, markVisibleRead, setPreference, resetPreference, setEmailPreference, resetEmailPreference, retryMutation }
}

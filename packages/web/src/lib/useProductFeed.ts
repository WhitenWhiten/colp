import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { productClient } from '../api'
import { ProductApiError, wrapProductError } from '../api/errors'
import { privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import type { FeedItem } from '../api/types'
import { readRouteCache, writeRouteCache } from './routeCache'

export type ProductFeedState = 'flag-off' | 'loading' | 'ready' | 'empty' | 'error' | 'loading-more' | 'checking'
type FeedKind = FeedItem['kind']
type Operation = { type: 'initial' | 'refresh' | 'more' | 'check'; cursor?: string }
type Snapshot = {
  items: FeedItem[]
  newItems: FeedItem[]
  cursor: string | null
  hasMore: boolean
  state: ProductFeedState
  error: ProductApiError | null
}

const emptySnapshot: Snapshot = { items: [], newItems: [], cursor: null, hasMore: false, state: 'loading', error: null }

type CachedFeed = Pick<Snapshot, 'items' | 'cursor' | 'hasMore'>

function cacheKey(kind: FeedKind | undefined) {
  return `feed:${kind ?? 'all'}`
}

/** Restore the last painted page so a route round trip skips the skeleton. */
function restoredSnapshot(input: { enabled: boolean; kind?: FeedKind }): Snapshot {
  if (!input.enabled) return { ...emptySnapshot, state: 'flag-off' }
  const cached = readRouteCache<CachedFeed>(cacheKey(input.kind))
  if (cached === undefined || cached.items.length === 0) return emptySnapshot
  return { ...emptySnapshot, ...cached, state: 'ready' }
}

function mergeUnique(first: FeedItem[], second: FeedItem[]): FeedItem[] {
  const seen = new Set<string>()
  return [...first, ...second].filter((item) => {
    if (seen.has(item.feedItemId)) return false
    seen.add(item.feedItemId)
    return true
  })
}

export function useProductFeed(input: { enabled: boolean; kind?: FeedKind; limit?: number }) {
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const failedRef = useRef<Operation>({ type: 'initial' })
  const paramsRef = useRef(input)
  paramsRef.current = input
  const [snapshot, setSnapshot] = useState<Snapshot>(() => restoredSnapshot(input))
  // Empty until a read for this session paints. A session change clears it so
  // a failed revalidation cannot keep the previous account's rows.
  const paintedIdentityRef = useRef(privateSessionIdentity())
  const identityRef = useRef(paintedIdentityRef.current)
  const subscribeIdentity = useCallback((notify: () => void) => subscribeSession(() => {
    const next = privateSessionIdentity()
    if (next !== identityRef.current) {
      identityRef.current = next
      paintedIdentityRef.current = ''
      generationRef.current += 1
      controllerRef.current?.abort()
      failedRef.current = { type: 'initial' }
      setSnapshot(paramsRef.current.enabled ? { ...emptySnapshot } : { ...emptySnapshot, state: 'flag-off' })
    }
    notify()
  }), [])
  const identity = useSyncExternalStore(subscribeIdentity, privateSessionIdentity, privateSessionIdentity)

  const execute = useCallback(async (generation: number, operation: Operation) => {
    if (!paramsRef.current.enabled) return
    if (generation !== generationRef.current) return
    const requestedIdentity = privateSessionIdentity()
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    failedRef.current = operation
    setSnapshot((current) => {
      if (generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
      // An `initial` run after a remount is a revalidation of rows already on
      // screen: keep them and stay out of the loading state so the stream does
      // not blink back to a skeleton. Rows painted for another session are not
      // that stream.
      const revalidating = operation.type === 'initial' && current.items.length > 0
        && paintedIdentityRef.current === requestedIdentity
      return {
        ...(operation.type === 'initial' && !revalidating ? emptySnapshot : current),
        state: revalidating
          ? current.state
          : operation.type === 'more' ? 'loading-more' : operation.type === 'check' ? 'checking' : 'loading',
        error: null,
      }
    })
    try {
      const query = operation.cursor
        ? { cursor: operation.cursor }
        : { ...(paramsRef.current.kind ? { kind: paramsRef.current.kind } : {}), limit: paramsRef.current.limit ?? 20 }
      const page = await productClient.getFeedPage(query, { maxRetries: 0, signal: controller.signal })
      if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return
      setSnapshot((current) => {
        if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
        paintedIdentityRef.current = requestedIdentity
        if (operation.type === 'check') {
          const existing = new Set(current.items.map((item) => item.feedItemId))
          const newItems = page.items.filter((item) => !existing.has(item.feedItemId))
          return { ...current, newItems, state: current.items.length ? 'ready' : 'empty', error: null }
        }
        const items = operation.type === 'more' ? mergeUnique(current.items, page.items) : page.items
        const next: Snapshot = {
          items,
          newItems: [],
          cursor: page.nextCursor,
          hasMore: page.nextCursor !== null,
          state: items.length ? 'ready' : 'empty',
          error: null,
        }
        writeRouteCache<CachedFeed>(cacheKey(paramsRef.current.kind), {
          items: next.items, cursor: next.cursor, hasMore: next.hasMore,
        }, requestedIdentity)
        return next
      })
    } catch (reason) {
      if (controller.signal.aborted || generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return
      const error = wrapProductError(reason)
      if (error.code === 'invalid_cursor') failedRef.current = { type: 'refresh' }
      setSnapshot((current) => {
        if (generation !== generationRef.current || requestedIdentity !== privateSessionIdentity()) return current
        // A failed revalidation keeps the stream already rendered for this
        // session. It must not keep rows painted for a session that ended.
        if (paintedIdentityRef.current !== requestedIdentity) return { ...emptySnapshot, state: 'error', error }
        return current.items.length > 0 && operation.type === 'initial'
          ? current
          : { ...current, state: 'error', error }
      })
    }
  }, [])

  useEffect(() => {
    generationRef.current += 1
    const generation = generationRef.current
    controllerRef.current?.abort()
    failedRef.current = { type: 'initial' }
    if (!input.enabled) {
      setSnapshot({ ...emptySnapshot, state: 'flag-off' })
      return () => controllerRef.current?.abort()
    }
    setSnapshot((current) => {
      if (paintedIdentityRef.current !== identity) return { ...emptySnapshot }
      return current.items.length > 0 ? current : restoredSnapshot(paramsRef.current)
    })
    void execute(generation, { type: 'initial' })
    return () => controllerRef.current?.abort()
  }, [execute, identity, input.enabled, input.kind, input.limit])

  const retry = useCallback(() => { void execute(generationRef.current, failedRef.current) }, [execute])
  const refresh = useCallback(() => { void execute(generationRef.current, { type: 'refresh' }) }, [execute])
  const checkForNewItems = useCallback(() => { void execute(generationRef.current, { type: 'check' }) }, [execute])
  const loadMore = useCallback(() => {
    if (snapshot.cursor && snapshot.hasMore && snapshot.state !== 'loading-more') {
      void execute(generationRef.current, { type: 'more', cursor: snapshot.cursor })
    }
  }, [execute, snapshot.cursor, snapshot.hasMore, snapshot.state])
  const showNewItems = useCallback(() => setSnapshot((current) => ({
    ...current,
    items: mergeUnique(current.newItems, current.items),
    newItems: [],
    state: current.items.length || current.newItems.length ? 'ready' : 'empty',
  })), [])

  return { ...snapshot, retry, refresh, checkForNewItems, loadMore, showNewItems }
}

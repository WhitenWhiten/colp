import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type OwnedCollectionListItem } from '../api'
import { getSessionSnapshot, privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { deleteRouteCache, readRouteCache, writeRouteCache } from './routeCache'

type LoadState = 'loading' | 'ready' | 'error'

type CachedPage = {
  items: OwnedCollectionListItem[]
  cursor: string | null
  message: string
}

const FIRST_PAGE_LIMIT = 30
const CACHE_KEY = 'shared-collections'

function identity() {
  return privateSessionIdentity()
}

function usePrivateIdentity() {
  const [value, setValue] = useState(identity)
  useEffect(() => subscribeSession(() => setValue(identity())), [])
  return value
}

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function useSharedCollections() {
  const privateIdentity = usePrivateIdentity()
  const restored = readRouteCache<CachedPage>(CACHE_KEY)
  const [items, setItems] = useState<OwnedCollectionListItem[]>(restored?.items ?? [])
  const [state, setState] = useState<LoadState>(restored ? 'ready' : 'loading')
  const [message, setMessage] = useState(restored?.message ?? 'Loading shared collections')
  const [hasMore, setHasMore] = useState(Boolean(restored?.cursor))
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const itemsRef = useRef<OwnedCollectionListItem[]>(restored?.items ?? [])
  const cursorRef = useRef<string | null>(restored?.cursor ?? null)
  /**
   * Which private identity the rows in `itemsRef` belong to. Stale-while-
   * revalidate is only safe within one identity: after an account switch (or
   * a sign-out) the rows must be dropped before the new read settles, and a
   * failed revalidation must never leave the previous account's rows behind.
   */
  const rowsIdentityRef = useRef<string | null>(restored ? identity() : null)
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)

  const replaceItems = useCallback((next: OwnedCollectionListItem[]) => {
    const seen = new Set<string>()
    const unique = next.filter(({ collection }) => {
      if (seen.has(collection.id)) return false
      seen.add(collection.id)
      return true
    })
    itemsRef.current = unique
    setItems(unique)
  }, [])

  const forgetRows = useCallback(() => {
    replaceItems([])
    cursorRef.current = null
    rowsIdentityRef.current = null
    setHasMore(false)
  }, [replaceItems])

  /** Publish what the sidebar is showing so the next mount can skip the wipe. */
  const cacheCurrent = useCallback((nextMessage: string) => {
    writeRouteCache<CachedPage>(CACHE_KEY, {
      items: itemsRef.current,
      cursor: cursorRef.current,
      message: nextMessage,
    })
  }, [])

  const loadFirstPage = useCallback(async () => {
    const snapshot = getSessionSnapshot()
    controllerRef.current?.abort()
    controllerRef.current = null
    const requestGeneration = ++generation.current
    const requestedIdentity = identity()
    // Stale-while-revalidate: the desk remounts on every trip through a
    // sub-route, and the sidebar hides this section while it is empty — so
    // wiping first made "Shared with you" disappear and pop back. Rows from
    // another identity are never "stale but usable", so they are dropped.
    const revalidating = itemsRef.current.length > 0 && rowsIdentityRef.current === requestedIdentity
    if (!revalidating) {
      forgetRows()
    }
    setIsLoadingMore(false)
    if (!snapshot.authenticated) {
      forgetRows()
      deleteRouteCache(CACHE_KEY)
      setState('ready')
      setMessage('Sign in to view shared collections')
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    if (!revalidating) {
      setState('loading')
      setMessage('Loading shared collections')
    }
    try {
      const page = await productClient.listSharedCollections(
        { limit: FIRST_PAGE_LIMIT },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity()) return
      rowsIdentityRef.current = requestedIdentity
      replaceItems(page.items)
      cursorRef.current = page.page.hasMore ? page.page.nextCursor : null
      setHasMore(Boolean(page.page.hasMore && page.page.nextCursor))
      setState('ready')
      const nextMessage = page.items.length === 0 ? 'No shared collections' : `${page.items.length} shared collections`
      setMessage(nextMessage)
      cacheCurrent(nextMessage)
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity() || isAbort(error)) return
      const authRequired = isProductApiError(error) && error.isAuthRequired
      if (!revalidating || authRequired) {
        forgetRows()
        if (authRequired) deleteRouteCache(CACHE_KEY)
      }
      setState('error')
      setMessage(
        authRequired
          ? 'Sign in to view shared collections'
          : isProductApiError(error) ? error.recoveryHint : "Couldn't load shared collections",
      )
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [cacheCurrent, forgetRows, replaceItems])

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current
    if (!cursor || controllerRef.current || isLoadingMore) return
    const controller = new AbortController()
    controllerRef.current = controller
    const requestGeneration = ++generation.current
    const requestedIdentity = identity()
    setIsLoadingMore(true)
    setMessage('Loading more shared collections')
    try {
      const page = await productClient.listSharedCollections(
        { cursor },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity()) return
      const seen = new Set(itemsRef.current.map(({ collection }) => collection.id))
      const appended = page.items.filter(({ collection }) => {
        if (seen.has(collection.id)) return false
        seen.add(collection.id)
        return true
      })
      if (appended.length > 0) replaceItems([...itemsRef.current, ...appended])
      const nextCursor = page.page.hasMore ? page.page.nextCursor : null
      cursorRef.current = nextCursor && nextCursor !== cursor ? nextCursor : null
      setHasMore(Boolean(cursorRef.current))
      setState('ready')
      const nextMessage = appended.length > 0
        ? `${itemsRef.current.length} shared collections`
        : 'No new shared collections on this page'
      setMessage(nextMessage)
      cacheCurrent(nextMessage)
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity() || isAbort(error)) return
      setState('ready')
      setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load more shared collections")
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (requestGeneration === generation.current) setIsLoadingMore(false)
    }
  }, [cacheCurrent, isLoadingMore, replaceItems])

  useEffect(() => {
    void loadFirstPage()
    return () => {
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [loadFirstPage, privateIdentity])

  /* A session notification re-renders before the reset effect runs, so gate
     what is exposed: rows are only ever shown for the identity that fetched
     them, never for the account switch frame in between. */
  const rowsVisible = rowsIdentityRef.current === privateIdentity
  return {
    items: rowsVisible ? items : [],
    state,
    message,
    hasMore: rowsVisible && hasMore,
    isLoadingMore,
    reload: loadFirstPage,
    loadMore,
  }
}

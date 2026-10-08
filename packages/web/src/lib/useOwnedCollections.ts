import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient, type OwnedCollectionListItem } from '../api'
import { getSessionSnapshot, privateSessionIdentity, subscribeSession } from '../api/sessionStore'
import { readRouteCache, writeRouteCache } from './routeCache'
import { plural } from './plural'

type LoadState = 'loading' | 'ready' | 'error'

type CachedPage = {
  items: OwnedCollectionListItem[]
  cursor: string | null
  message: string
}

const FIRST_PAGE_LIMIT = 30
const CACHE_KEY = 'owned-collections'

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

export function useOwnedCollections() {
  const privateIdentity = usePrivateIdentity()
  const restored = readRouteCache<CachedPage>(CACHE_KEY)
  const [items, setItems] = useState<OwnedCollectionListItem[]>(restored?.items ?? [])
  const [state, setState] = useState<LoadState>(restored ? 'ready' : 'loading')
  const [message, setMessage] = useState(restored?.message ?? 'Loading collections')
  const [hasMore, setHasMore] = useState(Boolean(restored?.cursor))
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const itemsRef = useRef<OwnedCollectionListItem[]>(restored?.items ?? [])
  const cursorRef = useRef<string | null>(restored?.cursor ?? null)
  const generation = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const lastIdentityRef = useRef(privateIdentity)

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

  /** Publish what the desk is showing so the next mount can skip the skeleton. */
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
    // Stale-while-revalidate: with rows already on screen the desk keeps them
    // and refetches quietly, so returning from a sub-route does not replay the
    // skeleton. A cold desk still shows its loading state.
    const revalidating = itemsRef.current.length > 0
    if (!revalidating) {
      replaceItems([])
      cursorRef.current = null
      setHasMore(false)
    }
    setIsLoadingMore(false)
    if (!snapshot.authenticated) {
      setState('ready')
      setMessage('Sign in to view your collections')
      return
    }
    const controller = new AbortController()
    controllerRef.current = controller
    if (!revalidating) {
      setState('loading')
      setMessage('Loading collections')
    }
    try {
      const page = await productClient.getOwnedCollectionsPage(
        { limit: FIRST_PAGE_LIMIT },
        { signal: controller.signal, maxRetries: 0 },
      )
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity()) return
      replaceItems(page.items)
      cursorRef.current = page.page.hasMore ? page.page.nextCursor : null
      setHasMore(Boolean(page.page.hasMore && page.page.nextCursor))
      setState('ready')
      const nextMessage = page.items.length === 0 ? 'No collections yet' : plural(page.items.length, 'collection')
      setMessage(nextMessage)
      cacheCurrent(nextMessage)
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity() || isAbort(error)) return
      // A failed revalidation keeps the rows the desk is already showing: the
      // error copy only renders when the list is empty.
      if (!revalidating) {
        replaceItems([])
        cursorRef.current = null
        setHasMore(false)
      }
      setState('error')
      setMessage(
        isProductApiError(error) && error.isAuthRequired
          ? 'Sign in to view your collections'
          : isProductApiError(error) ? error.recoveryHint : "Couldn't load collections",
      )
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [cacheCurrent, replaceItems])

  const loadMore = useCallback(async () => {
    const cursor = cursorRef.current
    if (!cursor || controllerRef.current || isLoadingMore) return
    const controller = new AbortController()
    controllerRef.current = controller
    const requestGeneration = ++generation.current
    const requestedIdentity = identity()
    setIsLoadingMore(true)
    setMessage('Loading more collections')
    try {
      const page = await productClient.getOwnedCollectionsPage(
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
        ? plural(itemsRef.current.length, 'collection')
        : 'No new collections on this page'
      setMessage(nextMessage)
      cacheCurrent(nextMessage)
    } catch (error) {
      if (controller.signal.aborted || requestGeneration !== generation.current || requestedIdentity !== identity() || isAbort(error)) return
      setState('ready')
      setMessage(isProductApiError(error) ? error.recoveryHint : "Couldn't load more collections")
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
      if (requestGeneration === generation.current) setIsLoadingMore(false)
    }
  }, [cacheCurrent, isLoadingMore, replaceItems])

  useEffect(() => {
    // An account replacement can keep this hook mounted. Clear the previous
    // actor's painted rows before the new request starts; routeCache's
    // identity stamp protects future reads, but cannot clear React state.
    if (lastIdentityRef.current !== privateIdentity) {
      lastIdentityRef.current = privateIdentity
      itemsRef.current = []
      cursorRef.current = null
      setItems([])
      setState('loading')
      setMessage('Loading collections')
      setHasMore(false)
      setIsLoadingMore(false)
    }
    void loadFirstPage()
    return () => {
      controllerRef.current?.abort()
      generation.current += 1
    }
  }, [loadFirstPage, privateIdentity])

  return { items, state, message, hasMore, isLoadingMore, reload: loadFirstPage, loadMore }
}

import { createScopedRefresh } from '../../lib/scopedRefresh'
import { subscribeLibraryInvalidation } from '../../lib/libraryInvalidation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  isProductApiError,
  privateSessionIdentity,
  productClient,
  subscribeSession,
  type EditorSnapshot,
  type OwnedCollectionListItem,
} from '../../api'
import { followedDeskSnapshot } from '../../lib/followedDeskSnapshot'
import { findFolder, isAbort } from '../../lib/libraryTree'
import { readRouteCache, writeRouteCache } from '../../lib/routeCache'
import type { useFollowedCollections } from '../../lib/useFollowedCollections'
import type { useOwnedCollections } from '../../lib/useOwnedCollections'
import type { useSharedCollections } from '../../lib/useSharedCollections'

export type TreeStatus = 'loading' | 'ready' | 'error'

export type TreeEntry = {
  status: TreeStatus
  snap?: EditorSnapshot
  message?: string
}

/** What the desk restores when a sub-route sends it through a remount. */
export type CachedDesk = {
  snaps: Record<string, EditorSnapshot>
  expanded: string[]
  collapsedSections?: string[]
  /** Collections the user collapsed by hand — selection never re-expands them. */
  userCollapsed?: string[]
}

export const DESK_CACHE_KEY = 'library-desk'

/**
 * Followed collections live in the trees map under a slug key: the public
 * snapshot is fetched by publication slug, while owned/shared trees load by
 * opaque collection id. The prefix keeps the two namespaces from colliding.
 */
const FOLLOWED_KEY_PREFIX = 'f:'
/** R15-29: a tree loaded less than this long ago is not re-paged on tab return. */
export const TREE_STALE_AFTER_MS = 60_000

export function followedKey(slug: string): string {
  return `${FOLLOWED_KEY_PREFIX}${slug}`
}

export function followedSlugOf(key: string): string | null {
  return key.startsWith(FOLLOWED_KEY_PREFIX) ? key.slice(FOLLOWED_KEY_PREFIX.length) : null
}

export function restoreTrees(cached: CachedDesk | undefined): Record<string, TreeEntry> {
  const entries: Record<string, TreeEntry> = {}
  for (const [id, snap] of Object.entries(cached?.snaps ?? {})) {
    entries[id] = { status: 'ready', snap }
  }
  return entries
}

export function readDeskCache(): CachedDesk | undefined {
  return readRouteCache<CachedDesk>(DESK_CACHE_KEY)
}

export function persistDeskCache(
  trees: Record<string, TreeEntry>,
  expanded: ReadonlySet<string>,
  collapsedSections: ReadonlySet<string>,
  userCollapsed: ReadonlySet<string>,
): void {
  const snaps: Record<string, EditorSnapshot> = {}
  for (const [id, entry] of Object.entries(trees)) {
    if (entry.snap) snaps[id] = entry.snap
  }
  writeRouteCache<CachedDesk>(DESK_CACHE_KEY, {
    snaps,
    expanded: [...expanded],
    collapsedSections: [...collapsedSections],
    userCollapsed: [...userCollapsed],
  })
}

/**
 * Selecting an owned/shared collection shows its first level of folders by
 * default. Auto-expansion is computed (never written into `expanded` or the
 * desk cache); a collection the user collapsed by hand stays collapsed.
 * Followed collections keep the original lazy behaviour, and reorder mode
 * keeps every tree collapsed while it is active.
 */
export function collectionIsExpanded(
  id: string,
  expanded: ReadonlySet<string>,
  reorderSection: string | null,
  selectedId: string | null,
  selectedFollowedSlug: string | null,
  userCollapsed: ReadonlySet<string>,
): boolean {
  return expanded.has(id)
    || (reorderSection === null
      && id === selectedId
      && !selectedFollowedSlug
      && !userCollapsed.has(id))
}

export function useLibraryDeskData(options: {
  collectionId: string | undefined
  routeFollowedSlug: string | undefined
  folderId: string | null
  reading: boolean
  isLoggedIn: boolean
  bootstrapping: boolean
  collections: ReturnType<typeof useOwnedCollections>
  shared: ReturnType<typeof useSharedCollections>
  followed: ReturnType<typeof useFollowedCollections>
}) {
  const {
    collectionId,
    routeFollowedSlug,
    folderId,
    reading,
    isLoggedIn,
    bootstrapping,
    collections,
    shared,
    followed,
  } = options
  const navigate = useNavigate()

  const restoredDesk = readDeskCache()
  const [trees, setTrees] = useState<Record<string, TreeEntry>>(() => restoreTrees(restoredDesk))
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(restoredDesk?.expanded ?? []))
  const [userCollapsed, setUserCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(restoredDesk?.userCollapsed ?? []),
  )
  const loaders = useRef(new Map<string, AbortController>())
  const refreshed = useRef(new Set<string>())
  /* R15-29: when each tree last loaded, so returning to the tab does not
     re-page collections that are still fresh. */
  const loadedAt = useRef(new Map<string, number>())
  const treesRef = useRef(trees)
  treesRef.current = trees

  const selectedId = reading
    ? null
    : routeFollowedSlug
      ? followedKey(routeFollowedSlug)
      : collectionId
        ?? collections.items[0]?.collection.id
        ?? shared.items[0]?.collection.id
        ?? null
  const selectedFollowedSlug = selectedId ? followedSlugOf(selectedId) : null

  const ownedSidebarItems = useMemo(() => {
    const items = collections.items
    const snap = selectedId && !selectedFollowedSlug ? trees[selectedId]?.snap : undefined
    if (!snap) return items
    if (items.some((item) => item.collection.id === snap.collection.id)) return items
    if (shared.items.some((item) => item.collection.id === snap.collection.id)) return items
    if (shared.state === 'loading') return items
    return [{ collection: snap.collection, capabilities: snap.capabilities } satisfies OwnedCollectionListItem, ...items]
  }, [collections.items, selectedFollowedSlug, selectedId, shared.items, shared.state, trees])

  const sharedSidebarItems = shared.items
  const availableFollowedItems = useMemo(
    () => followed.items.filter((item) => item.availability !== 'unavailable'),
    [followed.items],
  )

  const loadTree = useCallback(async (key: string, opts?: { silent?: boolean; propagate?: boolean }) => {
    loaders.current.get(key)?.abort()
    const identity = privateSessionIdentity()
    const controller = new AbortController()
    loaders.current.set(key, controller)
    const slug = followedSlugOf(key)
    if (!opts?.silent) {
      setTrees((current) => ({
        ...current,
        [key]: { status: 'loading', snap: current[key]?.snap, message: 'Loading collection' },
      }))
    }
    try {
      const next = slug
        ? followedDeskSnapshot(await productClient.loadPublicCollectionSnapshot(slug, {
          signal: controller.signal,
        }))
        : await productClient.loadEditorSnapshot(key, {
          signal: controller.signal,
          maxRetries: 0,
        })
      if (controller.signal.aborted || identity !== privateSessionIdentity()) return
      if (opts?.propagate && document.querySelector('[role="dialog"], dialog[open], .library-compose')) throw new Error('refresh_deferred')
      loadedAt.current.set(key, Date.now())
      setTrees((current) => ({ ...current, [key]: { status: 'ready', snap: next } }))
    } catch (err) {
      if (controller.signal.aborted || identity !== privateSessionIdentity() || isAbort(err)) return
      if (err instanceof Error && err.message === 'refresh_deferred') throw err
      const followedGone = slug !== null && isProductApiError(err)
        && (err.status === 404 || err.code === 'resource_not_found')
      setTrees((current) => ({
        ...current,
        [key]: {
          status: 'error',
          snap: isProductApiError(err) && [401, 403, 404].includes(err.status) ? undefined : current[key]?.snap,
          message: isProductApiError(err) && err.isAuthRequired
            ? 'Sign in to open this collection'
            : followedGone
              ? 'This collection is no longer available.'
              : isProductApiError(err) ? err.recoveryHint : "Couldn't load folders",
        },
      }))
      if (isProductApiError(err) && err.isAuthRequired) {
        const returnTo = slug ? `/library/following/${slug}` : `/library/${key}`
        navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`)
      }
      if (opts?.propagate) throw err
    } finally {
      if (loaders.current.get(key) === controller) loaders.current.delete(key)
    }
  }, [navigate])

  const visible = useRef(new Set<string>())
  visible.current = new Set([...expanded, ...(selectedId ? [selectedId] : [])])
  useEffect(() => {
    let identity = privateSessionIdentity()
    const refresh = createScopedRefresh<string>({
      canRun: key => navigator.onLine !== false && document.visibilityState !== 'hidden' && visible.current.has(key)
        && !document.querySelector('[role="dialog"], dialog[open], .library-compose'),
      refresh: key => loadTree(key, { silent: true, propagate: true }),
      retryAfter: error => isProductApiError(error) && [401, 403, 404].includes(error.status) ? null
        : isProductApiError(error) ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
    })
    const unsubscribe = subscribeLibraryInvalidation(event => refresh.invalidate(event.collectionId))
    /* R15-29: tab return and reconnect revalidate only trees older than the
       staleness window; edits invalidate through subscribeLibraryInvalidation.
       `visibilitychange` alone covers tab switches (no window `focus`). */
    const onReturn = () => {
      const now = Date.now()
      for (const key of visible.current) {
        if (now - (loadedAt.current.get(key) ?? 0) >= TREE_STALE_AFTER_MS) refresh.invalidate(key)
      }
      refresh.wake()
    }
    const onInputExit = () => refresh.wake()
    const observer = new MutationObserver(onInputExit)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('online', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    const unsubscribeSession = subscribeSession(() => {
      if (identity === privateSessionIdentity()) return
      identity = privateSessionIdentity(); refresh.reset()
      for (const controller of loaders.current.values()) controller.abort()
      loaders.current.clear(); refreshed.current.clear(); loadedAt.current.clear(); treesRef.current = {}; setTrees({})
    })
    return () => { refresh.dispose(); unsubscribe(); unsubscribeSession(); observer.disconnect()
      window.removeEventListener('online', onReturn); document.removeEventListener('visibilitychange', onReturn) }
  }, [loadTree])

  useEffect(() => {
    if (!selectedId || !folderId) return
    setExpanded((current) => {
      if (current.has(selectedId)) return current
      const next = new Set(current)
      next.add(selectedId)
      return next
    })
  }, [folderId, selectedId])

  useEffect(() => {
    if (bootstrapping || !isLoggedIn) return
    const ids = new Set(expanded)
    if (selectedId) ids.add(selectedId)
    for (const id of ids) {
      const entry = treesRef.current[id]
      if (entry?.status === 'loading') continue
      if (entry?.status === 'ready') {
        // Restored from the desk cache: refresh once behind the rendered
        // snapshot instead of replaying the skeleton.
        if (refreshed.current.has(id)) continue
        refreshed.current.add(id)
        void loadTree(id, { silent: true })
        continue
      }
      refreshed.current.add(id)
      void loadTree(id)
    }
  }, [bootstrapping, expanded, isLoggedIn, loadTree, selectedId])

  useEffect(() => () => {
    for (const controller of loaders.current.values()) controller.abort()
    loaders.current.clear()
  }, [])

  const toggleExpanded = (id: string, collapsing: boolean) => {
    // Effective state, not the raw set: collapsing an auto-expanded selected
    // collection must register as a collapse (and be remembered), not a
    // redundant expand.
    setExpanded((current) => {
      const next = new Set(current)
      if (collapsing) next.delete(id)
      else next.add(id)
      return next
    })
    setUserCollapsed((current) => {
      if (collapsing === current.has(id)) return current
      const next = new Set(current)
      if (collapsing) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const snap = selectedId ? trees[selectedId]?.snap ?? null : null
  const load = selectedId ? trees[selectedId]?.status ?? 'loading' : 'ready'
  const loadMessage = selectedId ? trees[selectedId]?.message ?? 'Loading collection' : ''
  /* The folder the visitor stands in — any depth, not just the first level. */
  const selectedFolder = snap ? findFolder(snap.nodes, folderId) : null
  const collection = snap?.collection
  const caps = snap?.capabilities
  const collectionBasePath = selectedFollowedSlug
    ? `/library/following/${encodeURIComponent(selectedFollowedSlug)}`
    : selectedId
      ? `/library/${encodeURIComponent(selectedId)}`
      : '/library'
  const folderPath = (id: string | null) =>
    id ? `${collectionBasePath}?folder=${encodeURIComponent(id)}` : collectionBasePath

  return {
    trees,
    treesRef,
    expanded,
    setExpanded,
    userCollapsed,
    loadTree,
    toggleExpanded,
    selectedId,
    selectedFollowedSlug,
    ownedSidebarItems,
    sharedSidebarItems,
    availableFollowedItems,
    snap,
    load,
    loadMessage,
    selectedFolder,
    collection,
    caps,
    collectionBasePath,
    folderPath,
  }
}

export type LibraryDeskData = ReturnType<typeof useLibraryDeskData>

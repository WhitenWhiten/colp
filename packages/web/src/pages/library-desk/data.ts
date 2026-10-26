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
} from '../../api'
import { isBrowserFolderRole } from '../../generated/browser-folder-roles'
import { findFolder, isAbort } from '../../lib/libraryTree'
import { readRouteCache, writeRouteCache } from '../../lib/routeCache'
import type { useLibrary } from '../../lib/useLibrary'
import type { useSharedCollections } from '../../lib/useSharedCollections'

export type TreeStatus = 'loading' | 'ready' | 'error'

export type TreeEntry = {
  status: TreeStatus
  snap?: EditorSnapshot
  message?: string
}

/** Complete read models and view preferences restored on remount or page reload. */
export type CachedDesk = {
  snaps: Record<string, EditorSnapshot>
  expanded: string[]
  collapsedSections?: string[]
  /** Collections the user collapsed by hand — selection never re-expands them. */
  userCollapsed?: string[]
}

export const DESK_CACHE_KEY = 'library-desk'

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
 * Selecting a collection shows its first level of folders by default.
 * Auto-expansion is computed (never written into `expanded` or the desk
 * cache); a collection the user collapsed by hand stays collapsed, and
 * reorder mode keeps every tree collapsed while it is active.
 */
export function collectionIsExpanded(
  id: string,
  expanded: ReadonlySet<string>,
  reorderSection: string | null,
  selectedId: string | null,
  userCollapsed: ReadonlySet<string>,
): boolean {
  return expanded.has(id)
    || (reorderSection === null
      && id === selectedId
      && !userCollapsed.has(id))
}

export function useLibraryDeskData(options: {
  collectionId: string | undefined
  folderId: string | null
  isLoggedIn: boolean
  bootstrapping: boolean
  collections: ReturnType<typeof useLibrary>
  shared: ReturnType<typeof useSharedCollections>
}) {
  const {
    collectionId,
    folderId,
    isLoggedIn,
    bootstrapping,
    collections,
    shared,
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
  const treesRef = useRef(trees)
  treesRef.current = trees

  const selectedId = collectionId
    ?? collections.library?.id
    ?? null

  const library = collections.library

  const sharedSidebarItems = shared.items

  const loadTree = useCallback(async (key: string, opts?: { silent?: boolean; propagate?: boolean; revalidate?: boolean }) => {
    loaders.current.get(key)?.abort()
    const identity = privateSessionIdentity()
    const controller = new AbortController()
    loaders.current.set(key, controller)
    if (!opts?.silent) {
      setTrees((current) => ({
        ...current,
        [key]: { status: 'loading', snap: current[key]?.snap, message: 'Loading collection' },
      }))
    }
    try {
      const next = await productClient.loadEditorSnapshot(key, {
        signal: controller.signal,
        maxRetries: 0,
        ...(opts?.revalidate && treesRef.current[key]?.snap ? { cachedSnapshot: treesRef.current[key].snap } : {}),
      })
      if (controller.signal.aborted || identity !== privateSessionIdentity()) return
      if (opts?.propagate && document.querySelector('[role="dialog"], dialog[open], .library-compose')) throw new Error('refresh_deferred')
      setTrees((current) => ({ ...current, [key]: { status: 'ready', snap: next } }))
    } catch (err) {
      if (controller.signal.aborted || identity !== privateSessionIdentity() || isAbort(err)) return
      if (err instanceof Error && err.message === 'refresh_deferred') throw err
      setTrees((current) => ({
        ...current,
        [key]: {
          status: 'error',
          snap: isProductApiError(err) && [401, 403, 404].includes(err.status) ? undefined : current[key]?.snap,
          message: isProductApiError(err) && err.isAuthRequired
            ? 'Sign in to open this collection'
            : isProductApiError(err) ? err.recoveryHint : "Couldn't load folders",
        },
      }))
      if (isProductApiError(err) && err.isAuthRequired) {
        navigate(`/login?returnTo=${encodeURIComponent(`/library/${key}`)}`)
      }
      if (opts?.propagate) throw err
    } finally {
      if (loaders.current.get(key) === controller) loaders.current.delete(key)
    }
  }, [navigate])

  // The rail always lists the library's folders, even beside a shared collection.
  const libraryId = collections.library?.id ?? null
  const visible = useRef(new Set<string>())
  visible.current = new Set([...expanded, ...(selectedId ? [selectedId] : []), ...(libraryId ? [libraryId] : [])])
  useEffect(() => {
    let identity = privateSessionIdentity()
    const refresh = createScopedRefresh<string>({
      canRun: key => navigator.onLine !== false && document.visibilityState !== 'hidden' && visible.current.has(key)
        && !document.querySelector('[role="dialog"], dialog[open], .library-compose'),
      refresh: key => loadTree(key, { silent: true, propagate: true, revalidate: true }),
      retryAfter: error => isProductApiError(error) && [401, 403, 404].includes(error.status) ? null
        : isProductApiError(error) ? (error.retryAfterSeconds ?? 0) * 1000 : 0,
    })
    const unsubscribe = subscribeLibraryInvalidation(event => refresh.invalidate(event.collectionId))
    // Returning or reconnecting verifies versions. An unchanged tree needs no pages.
    const onReturn = () => {
      if (document.visibilityState === 'hidden') return
      for (const key of visible.current) refresh.invalidate(key)
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
      loaders.current.clear(); refreshed.current.clear(); treesRef.current = {}; setTrees({})
    })
    return () => { refresh.dispose(); unsubscribe(); unsubscribeSession(); observer.disconnect()
      window.removeEventListener('online', onReturn); document.removeEventListener('visibilitychange', onReturn) }
  }, [loadTree])

  useEffect(() => {
    // A direct /library visit mounts before /session + /me finish. Restore
    // only once the verified account can read its persisted snapshot.
    if (bootstrapping || !isLoggedIn) return
    const cached = readDeskCache()
    if (!cached || Object.keys(treesRef.current).length > 0) return
    const restored = restoreTrees(cached)
    treesRef.current = restored
    setTrees(restored)
    setExpanded(new Set(cached.expanded))
    setUserCollapsed(new Set(cached.userCollapsed ?? []))
  }, [bootstrapping, isLoggedIn, libraryId])

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
    if (libraryId) ids.add(libraryId)
    for (const id of ids) {
      const entry = treesRef.current[id]
      if (entry?.status === 'loading') continue
      if (entry?.status === 'ready') {
        // Restored from the desk cache: refresh once behind the rendered
        // snapshot instead of replaying the skeleton.
        if (refreshed.current.has(id)) continue
        refreshed.current.add(id)
        void loadTree(id, { silent: true, revalidate: true })
        continue
      }
      refreshed.current.add(id)
      void loadTree(id)
    }
  }, [bootstrapping, expanded, isLoggedIn, libraryId, loadTree, selectedId])

  useEffect(() => () => {
    for (const controller of loaders.current.values()) controller.abort()
    loaders.current.clear()
    refreshed.current.clear()
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
  const collectionBasePath = selectedId
    ? `/library/${encodeURIComponent(selectedId)}`
    : '/library'
  const folderPath = (id: string | null) =>
    id ? `${collectionBasePath}?folder=${encodeURIComponent(id)}` : collectionBasePath
  // Every browser root the server protects, a synced Mobile bookmarks included.
  const protectedFolderIds = useMemo(() => new Set(snap?.collection.library
    ? snap.nodes.filter((node) => node.kind === 'folder' && isBrowserFolderRole(node.folderRole)).map((node) => node.id) : []), [snap])

  return {
    protectedFolderIds,
    trees,
    treesRef,
    expanded,
    setExpanded,
    userCollapsed,
    loadTree,
    toggleExpanded,
    selectedId,
    library,
    sharedSidebarItems,
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

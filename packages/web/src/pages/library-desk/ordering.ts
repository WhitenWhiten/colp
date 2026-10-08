import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { productClient, type FollowedCollectionItem, type OwnedCollectionListItem } from '../../api'
import {
  applyLibraryOrder,
  LIBRARY_ORDER_SECTION_IDS,
  mergeLibraryOrder,
  type LibraryOrderSectionId,
} from '../../lib/libraryOrder'
import { isAbort } from '../../lib/libraryTree'
import { readRouteCache, writeRouteCache } from '../../lib/routeCache'
import { followedKey, readDeskCache } from './data'

/**
 * The sidebar rows themselves restore from the owned-collections route cache
 * on a desk remount, so without an order cache the first paint is the server
 * list order and the saved preference reshuffles it visibly once
 * getMyLibraryOrder resolves — every return from a sub-route replayed the
 * reorder. The route cache is identity-stamped, so one account never reads
 * another's arrangement.
 */
const ORDER_CACHE_KEY = 'library-order'

type CachedSectionOrder = Partial<Record<LibraryOrderSectionId, readonly string[]>>

function readOrderCache(): CachedSectionOrder {
  return readRouteCache<CachedSectionOrder>(ORDER_CACHE_KEY) ?? {}
}

export function useLibraryDeskOrder(options: {
  error: (message: string) => void
  isLoggedIn: boolean
  bootstrapping: boolean
  ownedSidebarItems: readonly OwnedCollectionListItem[]
  sharedSidebarItems: readonly OwnedCollectionListItem[]
  followedItems: readonly FollowedCollectionItem[]
  setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>>
}) {
  const {
    error,
    isLoggedIn,
    bootstrapping,
    ownedSidebarItems,
    sharedSidebarItems,
    followedItems,
    setExpanded,
  } = options

  const restoredDesk = readDeskCache()
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(
    () => new Set(restoredDesk?.collapsedSections ?? []),
  )

  // Long-press a collection row to reorder its own section; the drag never
  // crosses into another section because each list only knows its own rows.
  const [reorderSection, setReorderSection] = useState<LibraryOrderSectionId | null>(null)
  const restoredOrder = readOrderCache()
  const [sectionOrder, setSectionOrder] = useState<Partial<Record<LibraryOrderSectionId, readonly string[]>>>(
    () => restoredOrder,
  )
  const savedOrderRef = useRef<Partial<Record<LibraryOrderSectionId, readonly string[]>>>(restoredOrder)
  const touchedSectionsRef = useRef<Partial<Record<LibraryOrderSectionId, boolean>>>({})
  const persistGenRef = useRef<Partial<Record<LibraryOrderSectionId, number>>>({})
  const persistAbortRef = useRef<Partial<Record<LibraryOrderSectionId, AbortController>>>({})
  const sessionIdentityRef = useRef<string | null>(null)
  const [orderEpoch, setOrderEpoch] = useState(0)

  const orderedOwnedItems = useMemo(
    () => applyLibraryOrder(ownedSidebarItems, sectionOrder.mine, (item) => item.collection.id),
    [ownedSidebarItems, sectionOrder.mine],
  )
  const orderedSharedItems = useMemo(
    () => applyLibraryOrder(sharedSidebarItems, sectionOrder.shared, (item) => item.collection.id),
    [sharedSidebarItems, sectionOrder.shared],
  )
  const orderedFollowedItems = useMemo(
    () => applyLibraryOrder(followedItems, sectionOrder.following, (item) => item.collectionId),
    [followedItems, sectionOrder.following],
  )
  const loadedIdsRef = useRef<Record<LibraryOrderSectionId, readonly string[]>>({
    mine: [],
    shared: [],
    following: [],
  })
  loadedIdsRef.current = {
    mine: orderedOwnedItems.map((item) => item.collection.id),
    shared: orderedSharedItems.map((item) => item.collection.id),
    following: orderedFollowedItems.map((item) => item.collectionId),
  }

  /* Mirror the on-screen order into the route cache so the next desk mount
     paints it on the first frame. A failed persist rolls sectionOrder back,
     which re-fires this effect and corrects the cache. */
  useEffect(() => {
    if (Object.keys(sectionOrder).length === 0) return
    writeRouteCache(ORDER_CACHE_KEY, sectionOrder)
  }, [sectionOrder])

  const resetLibraryOrder = useCallback(() => {
    touchedSectionsRef.current = {}
    savedOrderRef.current = {}
    for (const controller of Object.values(persistAbortRef.current)) controller?.abort()
    persistAbortRef.current = {}
    persistGenRef.current = {}
    setSectionOrder({})
    setReorderSection(null)
  }, [])

  const setSectionIds = useCallback((section: LibraryOrderSectionId, ids: readonly string[]) => {
    touchedSectionsRef.current[section] = true
    setSectionOrder((current) => ({ ...current, [section]: ids }))
  }, [])

  const persistSectionOrder = useCallback((section: LibraryOrderSectionId) => {
    const merged = [...mergeLibraryOrder(loadedIdsRef.current[section], savedOrderRef.current[section])]
    const gen = (persistGenRef.current[section] ?? 0) + 1
    persistGenRef.current[section] = gen
    persistAbortRef.current[section]?.abort()
    const controller = new AbortController()
    persistAbortRef.current[section] = controller
    const previous = savedOrderRef.current[section]
    const commandId = productClient.newCommandId()
    void productClient.updateMyLibraryOrder(
      section,
      { collectionIds: merged },
      {
        intentId: productClient.mutationIntentKey(`library-order:${section}`, commandId),
        signal: controller.signal,
      },
    ).then(() => {
      if (persistGenRef.current[section] !== gen) return
      savedOrderRef.current[section] = merged
    }).catch((err) => {
      if (controller.signal.aborted || isAbort(err)) return
      if (persistGenRef.current[section] !== gen) return
      setSectionOrder((current) => ({ ...current, [section]: previous }))
      error('Could not save collection order')
    })
  }, [error])

  const finishReorder = useCallback((next: LibraryOrderSectionId | null = null) => {
    if (reorderSection) persistSectionOrder(reorderSection)
    setReorderSection(next)
  }, [persistSectionOrder, reorderSection])

  const beginReorder = useCallback((section: LibraryOrderSectionId) => {
    if (reorderSection && reorderSection !== section) persistSectionOrder(reorderSection)
    setReorderSection(section)
    setCollapsedSections((current) => {
      if (!current.has(section)) return current
      const next = new Set(current)
      next.delete(section)
      return next
    })
    const drop = new Set<string>()
    if (section === 'mine') {
      for (const item of ownedSidebarItems) drop.add(item.collection.id)
    } else if (section === 'shared') {
      for (const item of sharedSidebarItems) drop.add(item.collection.id)
    } else {
      for (const item of followedItems) drop.add(followedKey(item.slug))
    }
    setExpanded((current) => {
      if (current.size === 0) return current
      let changed = false
      const next = new Set(current)
      for (const id of drop) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : current
    })
  }, [followedItems, ownedSidebarItems, persistSectionOrder, reorderSection, setExpanded, sharedSidebarItems])

  useEffect(() => {
    if (!reorderSection) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishReorder()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [finishReorder, reorderSection])

  useEffect(() => {
    if (!isLoggedIn) {
      resetLibraryOrder()
      return
    }
    if (bootstrapping) return
    const controller = new AbortController()
    void productClient.getMyLibraryOrder({ signal: controller.signal, maxRetries: 0 })
      .then((view) => {
        if (controller.signal.aborted) return
        setSectionOrder((current) => {
          const next: Partial<Record<LibraryOrderSectionId, readonly string[]>> = { ...view.sections }
          for (const section of LIBRARY_ORDER_SECTION_IDS) {
            if (touchedSectionsRef.current[section] && current[section]) {
              next[section] = current[section]
              if (savedOrderRef.current[section] === undefined) {
                savedOrderRef.current[section] = view.sections[section]
              }
            } else {
              savedOrderRef.current[section] = view.sections[section]
            }
          }
          return next
        })
      })
      .catch((err) => {
        if (controller.signal.aborted || isAbort(err)) return
      })
    return () => controller.abort()
  }, [bootstrapping, isLoggedIn, orderEpoch, resetLibraryOrder])

  useEffect(() => productClient.subscribeSession((snapshot) => {
    const identity = `${snapshot.authenticated ? 'session' : 'anonymous'}:${snapshot.sessionEpoch}`
    if (sessionIdentityRef.current === null) {
      sessionIdentityRef.current = identity
      return
    }
    if (sessionIdentityRef.current === identity) return
    sessionIdentityRef.current = identity
    resetLibraryOrder()
    setOrderEpoch((value) => value + 1)
  }), [resetLibraryOrder])

  const toggleSection = (section: string) => {
    if (reorderSection === section) return
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  return {
    collapsedSections,
    reorderSection,
    orderedOwnedItems,
    orderedSharedItems,
    orderedFollowedItems,
    setSectionIds,
    persistSectionOrder,
    finishReorder,
    beginReorder,
    toggleSection,
  }
}

export type LibraryDeskOrder = ReturnType<typeof useLibraryDeskOrder>

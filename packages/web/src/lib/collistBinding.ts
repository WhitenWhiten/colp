import { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import type { OwnedCollectionListItem } from '../api'
import { useOwnedCollections } from './useOwnedCollections'

export const COLLIST_BINDING_KEY = 'known.collist.binding.v1'

export type CollistBindings = Record<string, string>

export type DashboardCollistValue = {
  owned: ReturnType<typeof useOwnedCollections>
  bindings: CollistBindings
  bind: (moduleId: string, collectionId: string) => void
}

const idleOwned: ReturnType<typeof useOwnedCollections> = {
  items: [],
  state: 'loading',
  message: 'Loading collections',
  hasMore: false,
  isLoadingMore: false,
  reload: async () => undefined,
  loadMore: async () => undefined,
}

export const DashboardCollistContext = createContext<DashboardCollistValue>({
  owned: idleOwned,
  bindings: {},
  bind: () => undefined,
})

export function loadCollistBindings(): CollistBindings {
  try {
    const raw = localStorage.getItem(COLLIST_BINDING_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: CollistBindings = {}
    for (const [moduleId, collectionId] of Object.entries(parsed)) {
      if (typeof moduleId === 'string' && typeof collectionId === 'string' && collectionId) {
        next[moduleId] = collectionId
      }
    }
    return next
  } catch {
    return {}
  }
}

export function persistCollistBindings(bindings: CollistBindings) {
  try {
    localStorage.setItem(COLLIST_BINDING_KEY, JSON.stringify(bindings))
  } catch {
    /* ignore */
  }
}

function recordsEqual(a: CollistBindings, b: CollistBindings) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/**
 * Pin each collectionlist module to an owned collection id.
 * Saved ids that are still owned (and not taken by an earlier module) stay.
 * Empty slots take the next unused owned id in list order.
 */
export function assignCollistBindings(
  moduleIds: readonly string[],
  ownedIds: readonly string[],
  saved: Readonly<CollistBindings>,
): CollistBindings {
  const ownedSet = new Set(ownedIds)
  const result: CollistBindings = {}
  const used = new Set<string>()

  for (const moduleId of moduleIds) {
    const savedId = saved[moduleId]
    if (savedId && ownedSet.has(savedId) && !used.has(savedId)) {
      result[moduleId] = savedId
      used.add(savedId)
    }
  }

  const unused = ownedIds.filter((id) => !used.has(id))
  let cursor = 0
  for (const moduleId of moduleIds) {
    if (result[moduleId]) continue
    const next = unused[cursor++]
    if (!next) continue
    result[moduleId] = next
    used.add(next)
  }

  return result
}

export function rebindCollistModule(
  moduleId: string,
  collectionId: string,
  moduleIds: readonly string[],
  ownedIds: readonly string[],
  saved: Readonly<CollistBindings>,
): CollistBindings {
  const next: CollistBindings = { ...saved }
  for (const [boundModule, boundId] of Object.entries(next)) {
    if (boundId === collectionId) delete next[boundModule]
  }
  next[moduleId] = collectionId
  return assignCollistBindings(moduleIds, ownedIds, next)
}

export function useCollistBindings(
  moduleIds: readonly string[],
  ownedIds: readonly string[],
  ready: boolean,
) {
  const [saved, setSaved] = useState<CollistBindings>(loadCollistBindings)
  const bindings = useMemo(
    () => (ready ? assignCollistBindings(moduleIds, ownedIds, saved) : saved),
    [ready, moduleIds, ownedIds, saved],
  )

  useEffect(() => {
    if (!ready) return
    if (recordsEqual(saved, bindings)) return
    persistCollistBindings(bindings)
    setSaved(bindings)
  }, [ready, bindings, saved])

  const bind = useCallback(
    (moduleId: string, collectionId: string) => {
      setSaved((prev) => {
        const next = rebindCollistModule(moduleId, collectionId, moduleIds, ownedIds, prev)
        persistCollistBindings(next)
        return recordsEqual(prev, next) ? prev : next
      })
    },
    [moduleIds, ownedIds],
  )

  return { bindings, bind }
}

export function isOwnedSignInMessage(message: string) {
  return message === 'Sign in to view your collections'
}

export function useDashboardCollist(moduleIds: readonly string[]): DashboardCollistValue {
  const owned = useOwnedCollections()
  const ownedIds = useMemo(
    () => owned.items.map((item: OwnedCollectionListItem) => item.collection.id),
    [owned.items],
  )
  const ready = owned.state === 'ready' && !isOwnedSignInMessage(owned.message)
  const { bindings, bind } = useCollistBindings(moduleIds, ownedIds, ready)
  const { items, state, message, hasMore, isLoadingMore, reload, loadMore } = owned
  const ownedValue = useMemo(
    () => ({ items, state, message, hasMore, isLoadingMore, reload, loadMore }),
    [items, state, message, hasMore, isLoadingMore, reload, loadMore],
  )
  return useMemo(
    () => ({ owned: ownedValue, bindings, bind }),
    [ownedValue, bindings, bind],
  )
}

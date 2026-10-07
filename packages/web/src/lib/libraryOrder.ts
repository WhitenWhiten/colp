/**
 * Pure helpers for the /library sidebar per-section collection order.
 *
 * A saved order is a list of collection ids. Items present in the saved
 * order render first, in that order; items the order does not know about
 * (new collections, next pages) append after them in the server list order,
 * so a stale preference never hides anything.
 */

export type LibraryOrderSectionId = 'mine' | 'shared' | 'following'

export const LIBRARY_ORDER_SECTION_IDS: readonly LibraryOrderSectionId[] = ['mine', 'shared', 'following']

/** PUT /me/library-order/{section} rejects more than 200 unique OpaqueIds. */
export const LIBRARY_ORDER_MAX_IDS = 200

/**
 * Persist the loaded-page order without dropping ranks the current page
 * has not fetched yet. Loaded ids lead; leftover saved ids append; the
 * result is capped at LIBRARY_ORDER_MAX_IDS.
 */
export function mergeLibraryOrder(
  loadedIds: readonly string[],
  previous: readonly string[] | undefined,
): readonly string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const id of loadedIds) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    next.push(id)
  }
  if (previous) {
    for (const id of previous) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      next.push(id)
    }
  }
  return next.length > LIBRARY_ORDER_MAX_IDS ? next.slice(0, LIBRARY_ORDER_MAX_IDS) : next
}

export function applyLibraryOrder<T>(
  items: readonly T[],
  order: readonly string[] | undefined,
  idOf: (item: T) => string,
): readonly T[] {
  if (!order || order.length === 0 || items.length < 2) return items
  const rank = new Map<string, number>()
  order.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index)
  })
  const ordered = items.filter((item) => rank.has(idOf(item)))
  if (ordered.length === 0) return items
  ordered.sort((a, b) => (rank.get(idOf(a)) ?? 0) - (rank.get(idOf(b)) ?? 0))
  const rest = items.filter((item) => !rank.has(idOf(item)))
  return [...ordered, ...rest]
}

/**
 * Where a dragged row should land given pointer Y in list coordinates and
 * each sibling's vertical midpoint. Missing midpoints are skipped.
 */
export function insertionIndexForPointer(
  ids: readonly string[],
  draggedId: string,
  pointerY: number,
  midpoints: ReadonlyMap<string, number>,
): number {
  let insertion = 0
  for (const id of ids) {
    if (id === draggedId) continue
    const midpoint = midpoints.get(id)
    if (midpoint !== undefined && midpoint < pointerY) insertion += 1
  }
  return insertion
}

/** Moves one id to a new index, clamping the target into the list bounds. */
export function moveId(ids: readonly string[], from: number, to: number): readonly string[] {
  if (from < 0 || from >= ids.length) return ids
  const target = Math.max(0, Math.min(ids.length - 1, to))
  if (target === from) return ids
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved!)
  return next
}

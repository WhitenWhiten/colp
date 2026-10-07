import { useSyncExternalStore } from 'react'

/* Features whose availability only the server knows (no client flag): the
   page that first meets the server's 404 records it, so navigation can show
   the entry as unavailable instead of linking into a dead end. Page-lifetime
   only; a later successful load clears it. */
export type ServerFeature = 'sync'

const unavailable = new Set<ServerFeature>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function markServerFeatureUnavailable(feature: ServerFeature): void {
  if (unavailable.has(feature)) return
  unavailable.add(feature)
  emit()
}

export function markServerFeatureAvailable(feature: ServerFeature): void {
  if (!unavailable.delete(feature)) return
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useServerFeatureUnavailable(feature: ServerFeature): boolean {
  return useSyncExternalStore(subscribe, () => unavailable.has(feature), () => false)
}

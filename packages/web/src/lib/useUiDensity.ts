import { useCallback, useSyncExternalStore } from 'react'

export type UiDensity = 'comfortable' | 'compact'

const KEY = 'known.ui.density.v1'
const LEGACY = [
  'known.explore.density.v1',
  'known.library.layout.v1',
  'known.dashboard.density.v1',
] as const

const listeners = new Set<() => void>()

function readStored(): UiDensity {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === 'comfortable' || raw === 'compact') return raw
    const explore = localStorage.getItem(LEGACY[0])
    if (explore === 'comfortable' || explore === 'compact') return explore
    const library = localStorage.getItem(LEGACY[1])
    if (library === 'full') return 'comfortable'
    if (library === 'compact') return 'compact'
    const dashboard = localStorage.getItem(LEGACY[2])
    if (dashboard === 'desk') return 'comfortable'
    if (dashboard === 'focus') return 'compact'
  } catch {
    /* ignore */
  }
  return 'comfortable'
}

function persist(value: UiDensity) {
  try {
    localStorage.setItem(KEY, value)
  } catch {
    /* ignore */
  }
}

let current: UiDensity = typeof window === 'undefined' ? 'comfortable' : readStored()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== KEY) return
    const next = event.newValue === 'compact' ? 'compact' : 'comfortable'
    if (next === current) return
    current = next
    emit()
  })
}

export function setUiDensity(next: UiDensity) {
  if (next === current) return
  current = next
  persist(next)
  emit()
}

export function useUiDensity(): [UiDensity, (next: UiDensity) => void] {
  const density = useSyncExternalStore<UiDensity>(
    subscribe,
    (): UiDensity => current,
    (): UiDensity => 'comfortable',
  )
  const setDensity = useCallback((next: UiDensity) => {
    setUiDensity(next)
  }, [])
  return [density, setDensity]
}

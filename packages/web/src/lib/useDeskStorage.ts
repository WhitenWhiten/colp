import { useCallback, useEffect, useRef, useState } from 'react'

type UseDeskStorageOptions<T> = {
  /** Full localStorage key; callers build per-resource keys and a key change reloads the state. */
  storageKey: string
  /** State when nothing is stored or the stored value is unreadable. */
  fallback: () => T
  /** Map parsed JSON (or the raw string in `raw` mode) to a valid state; null/undefined falls back. */
  normalize: (stored: unknown) => T | null | undefined
  /** State when the stored value exists but cannot be parsed. Defaults to `fallback`. */
  onCorrupt?: () => T
  /** Plain-text values skip JSON (e.g. free-text notes). */
  raw?: boolean
}

/**
 * Desk-widget localStorage state: load on mount/key change, persist on
 * update, one place for quota/JSON failure handling. Replaces the
 * per-widget loadState/persist/update trios. Widgets that persist on a
 * debounce timer rather than on every change (sticky note) keep their own
 * storage path.
 */
export function useDeskStorage<T>({ storageKey, fallback, normalize, onCorrupt, raw = false }: UseDeskStorageOptions<T>) {
  // Latest-ref mirrors keep load/persist stable across renders without
  // forcing callers to memoize their fallback/normalize closures.
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback
  const normalizeRef = useRef(normalize)
  normalizeRef.current = normalize
  const corruptRef = useRef(onCorrupt)
  corruptRef.current = onCorrupt

  const load = useCallback((): T => {
    try {
      const stored = localStorage.getItem(storageKey)
      if (stored == null) return fallbackRef.current()
      return normalizeRef.current(raw ? stored : JSON.parse(stored)) ?? fallbackRef.current()
    } catch {
      return (corruptRef.current ?? fallbackRef.current)()
    }
  }, [storageKey, raw])

  const [value, setValue] = useState<T>(load)

  const mountedRef = useRef(false)
  useEffect(() => {
    // First mount already loaded via the useState initializer — reloading
    // would regenerate fallback ids a second time.
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    setValue(load())
  }, [load])

  const persist = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(storageKey, raw ? String(next) : JSON.stringify(next))
      } catch {
        /* ignore quota / privacy-mode failures */
      }
    },
    [storageKey, raw],
  )

  const set = useCallback(
    (next: T) => {
      persist(next)
      setValue(next)
    },
    [persist],
  )

  const update = useCallback(
    (recipe: (prev: T) => T) => {
      setValue((prev) => {
        const next = recipe(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  return { value, set, update }
}

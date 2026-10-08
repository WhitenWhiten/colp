import { useCallback, useEffect, useRef } from 'react'

const DRAFT_PREFIX = 'known.draft.'
const UNSET = Symbol('draft-partition')

/** One localStorage slot for a draft key and an account or anonymous partition. */
export function autoSaveDraftStorageKey(key: string, partition: string): string {
  return `${DRAFT_PREFIX}${key}.${encodeURIComponent(partition)}`
}

export function readAutoSaveDraft<T extends Record<string, unknown>>(
  key: string,
  partition: string,
): T | null {
  try {
    const raw = localStorage.getItem(autoSaveDraftStorageKey(key, partition))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as T
      : null
  } catch {
    return null
  }
}

/**
 * Persists form fields for one partition. A null partition means identity is
 * not known yet, so nothing is read or written. A debounce that already
 * started keeps the partition it captured; switching identity resets the
 * mounted flag so the values then on screen are not copied across.
 */
export function useAutoSaveDraft<T extends Record<string, unknown>>(
  key: string,
  values: T,
  partition: string | null,
  delay = 800,
) {
  const storageKey = partition === null ? null : autoSaveDraftStorageKey(key, partition)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mountedRef = useRef(false)
  const partitionRef = useRef<string | null | typeof UNSET>(UNSET)

  useEffect(() => {
    const partitionChanged = partitionRef.current !== storageKey
    if (partitionChanged) {
      // Detach the in-flight timer. Clearing it here would drop the write,
      // and leaving it on timerRef would let the next partition cancel it.
      timerRef.current = undefined
      partitionRef.current = storageKey
      mountedRef.current = false
    }
    if (storageKey === null) {
      mountedRef.current = false
      return
    }
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    clearTimeout(timerRef.current)
    const keyAtStart = storageKey
    const snapshot = values
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(keyAtStart, JSON.stringify(snapshot))
      } catch { /* ignore quota errors */ }
    }, delay)
  }, [values, storageKey, delay])

  useEffect(() => () => { clearTimeout(timerRef.current) }, [])

  const restoreDraft = useCallback((): T | null => {
    if (partition === null) return null
    return readAutoSaveDraft<T>(key, partition)
  }, [key, partition])

  const clearDraft = useCallback(() => {
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    if (storageKey === null) return
    try {
      localStorage.removeItem(storageKey)
    } catch { /* ignore */ }
  }, [storageKey])

  return { restoreDraft, clearDraft }
}

/**
 * Helper: merge restored draft values into initial state.
 * Only copies keys that exist in both the draft and the initial values.
 */
export function mergeDraft<T extends Record<string, unknown>>(
  initial: T,
  draft: T | null,
): T {
  if (!draft) return initial
  const merged = { ...initial }
  for (const key of Object.keys(initial)) {
    if (key in draft && typeof draft[key] === typeof initial[key]) {
      ;(merged as Record<string, unknown>)[key] = draft[key]
    }
  }
  return merged
}

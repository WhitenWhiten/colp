import { useCallback, useMemo, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../../api'
import { useSavedResources } from '../../lib/useSavedResource'

/**
 * Row-level saved marks for the desk's bookmark list. One shared list read
 * (useSavedResources) instead of per-row useSavedResource fetches — the
 * detail page's button re-reads on mount, so the two surfaces never trust
 * each other's cache. Toggles are optimistic with a per-node in-flight
 * guard and roll back to the list state on a definite failure.
 */
export function useSavedMarks(error: (message: string) => void) {
  const saved = useSavedResources()
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())
  const pendingRef = useRef(new Set<string>())
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const [message, setMessage] = useState('')
  const errorRef = useRef(error)
  errorRef.current = error

  const savedIds = useMemo(() => {
    const ids = new Set(
      saved.items.filter((item) => item.resourceType === 'node').map((item) => item.resourceId),
    )
    for (const [id, value] of overrides) {
      if (value) ids.add(id)
      else ids.delete(id)
    }
    return ids
  }, [saved.items, overrides])

  const savedIdsRef = useRef(savedIds)
  savedIdsRef.current = savedIds

  const isSaved = useCallback((nodeId: string) => savedIds.has(nodeId), [savedIds])
  const isPending = useCallback((nodeId: string) => pendingIds.has(nodeId), [pendingIds])

  const toggle = useCallback((nodeId: string) => {
    if (pendingRef.current.has(nodeId)) return
    const target = !savedIdsRef.current.has(nodeId)
    pendingRef.current.add(nodeId)
    setPendingIds(new Set(pendingRef.current))
    setOverrides((current) => new Map(current).set(nodeId, target))
    const intentId = productClient.mutationIntentKey(
      target ? 'save-resource' : 'unsave-resource',
      productClient.newCommandId(),
    )
    void (target
      ? productClient.saveResource('node', nodeId, { intentId, maxRetries: 0 })
      : productClient.unsaveResource('node', nodeId, { intentId, maxRetries: 0 })
    ).then(() => {
      // The override already shows the confirmed state; the next desk mount
      // re-reads the list and the override map starts empty again.
      setMessage(target ? 'Saved' : 'Removed from saved')
    }).catch((err) => {
      setOverrides((current) => {
        if (!current.has(nodeId)) return current
        const next = new Map(current)
        next.delete(nodeId)
        return next
      })
      setMessage('Saved state could not be changed')
      errorRef.current(isProductApiError(err) ? err.recoveryHint : 'Could not change the saved state')
    }).finally(() => {
      pendingRef.current.delete(nodeId)
      setPendingIds(new Set(pendingRef.current))
    })
  }, [])

  return { isSaved, isPending, toggle, message }
}

export type SavedMarks = ReturnType<typeof useSavedMarks>

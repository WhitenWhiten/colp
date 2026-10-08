import { useCallback, useEffect, useRef, useState } from 'react'
import { isProductApiError, productClient } from '../api'
import type { ReadableReplicaView } from '../api/types'
import { isAbort } from './libraryTree'
import { readRouteCache, writeRouteCache } from './routeCache'

const POLL_MS = 2000
const POLL_MAX = 15
const EXTRACT_SCOPE = 'readable-replica-extract'

export type ReadableReplicaUiStatus = 'flag-off' | ReadableReplicaView['status']
/* Re-exported for the page: Reader.tsx consumes generated DTOs only through
   `../api` and this hook (annotation-boundary contract). */
export type ReadableReplicaFailureCode = ReadableReplicaView['failureCode']
export type ReadableReplicaSectionView = ReadableReplicaView['sections'][number]

type ReplicaFields = {
  status: ReadableReplicaUiStatus
  sections: ReadableReplicaView['sections']
  title: string | null
  byline: string | null
  wordCount: number
  failureCode: ReadableReplicaView['failureCode']
  sourceUrl: string
  pollExhausted: boolean
}

const idle: ReplicaFields = {
  status: 'flag-off',
  sections: [],
  title: null,
  byline: null,
  wordCount: 0,
  failureCode: null,
  sourceUrl: '',
  pollExhausted: false,
}

function fromView(view: ReadableReplicaView): ReplicaFields {
  return {
    status: view.status,
    sections: view.sections,
    title: view.title,
    byline: view.byline,
    wordCount: view.wordCount,
    failureCode: view.failureCode,
    sourceUrl: view.sourceUrl,
    pollExhausted: false,
  }
}

function replicaCacheKey(collectionId: string, nodeId: string): string {
  return `readable-replica:${collectionId}:${nodeId}`
}

/* First paint comes from the route cache when this replica was on screen a
   moment ago (resource detail ↔ reader hop); getOnce revalidates behind it. */
function restoredReplica(collectionId: string, nodeId: string): ReplicaFields | undefined {
  const cached = readRouteCache<ReplicaFields>(replicaCacheKey(collectionId, nodeId))
  return cached ? { ...cached, pollExhausted: false } : undefined
}

export function useReadableReplica(input: {
  collectionId: string
  nodeId: string
  enabled: boolean
}): ReplicaFields & { retry: (force: boolean) => void } {
  const [snapshot, setSnapshot] = useState<ReplicaFields>(() => (
    restoredReplica(input.collectionId, input.nodeId)
    ?? (input.enabled ? { ...idle, status: 'none' } : idle)
  ))
  const paramsRef = useRef(input)
  paramsRef.current = input
  const retryImplRef = useRef<(force: boolean) => void>(() => {})
  const autoPostedRef = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let interval: number | undefined
    let pollCount = 0
    let inflight = false
    let exhausted = false
    autoPostedRef.current = false

    const stopPolling = () => {
      if (interval === undefined) return
      window.clearInterval(interval)
      interval = undefined
    }

    const cleanup = () => {
      controller.abort()
      stopPolling()
    }

    if (!input.enabled) {
      setSnapshot(idle)
      retryImplRef.current = () => {}
      return cleanup
    }

    setSnapshot(
      restoredReplica(input.collectionId, input.nodeId) ?? { ...idle, status: 'none' },
    )

    const extractIntentId = (force: boolean) => productClient.mutationIntentKey(
      EXTRACT_SCOPE,
      `${input.collectionId}:${input.nodeId}:${force ? 'force' : 'auto'}`,
    )

    const startPolling = () => {
      if (interval !== undefined || exhausted) return
      pollCount = 0
      interval = window.setInterval(() => {
        pollCount += 1
        if (pollCount > POLL_MAX) {
          exhausted = true
          stopPolling()
          setSnapshot((prev) => ({ ...prev, pollExhausted: true }))
          return
        }
        void getOnce()
      }, POLL_MS)
    }

    const apply = (view: ReadableReplicaView) => {
      if (view.status !== 'pending') exhausted = false
      const next = {
        ...fromView(view),
        pollExhausted: view.status === 'pending' && exhausted,
      }
      setSnapshot(next)
      writeRouteCache(replicaCacheKey(input.collectionId, input.nodeId), next)
      if (view.status === 'pending') startPolling()
      else stopPolling()
    }

    async function postExtract(force: boolean) {
      exhausted = false
      try {
        const view = await productClient.enqueueNodeReadableExtract(
          paramsRef.current.collectionId,
          paramsRef.current.nodeId,
          force ? { force: true } : {},
          { intentId: extractIntentId(force), maxRetries: 0, signal: controller.signal },
        )
        if (controller.signal.aborted) return
        apply(view)
      } catch (error) {
        if (isAbort(error) || controller.signal.aborted) return
        if (isProductApiError(error) && error.status === 429) {
          // Rate-limited means the server is already extracting this node
          // (the previous enqueue is still cooling down). Poll for that
          // result instead of parking the page on `none` forever; a replica
          // that is already readable stays on screen while we look.
          setSnapshot((prev) => (prev.status === 'ready'
            ? prev
            : { ...prev, status: 'pending', sections: [], pollExhausted: false }))
          startPolling()
          return
        }
        setSnapshot((prev) => ({ ...prev, status: 'failed', sections: [] }))
        stopPolling()
      }
    }

    async function getOnce() {
      if (inflight) return
      inflight = true
      try {
        const view = await productClient.getNodeReadableReplica(
          paramsRef.current.collectionId,
          paramsRef.current.nodeId,
          { signal: controller.signal, maxRetries: 0 },
        )
        if (controller.signal.aborted) return
        apply(view)
        if (view.status === 'none' && !autoPostedRef.current) {
          autoPostedRef.current = true
          await postExtract(false)
        }
      } catch (error) {
        if (isAbort(error) || controller.signal.aborted) return
      } finally {
        inflight = false
      }
    }

    retryImplRef.current = (force: boolean) => {
      if (!paramsRef.current.enabled) return
      void postExtract(force)
    }

    void getOnce()
    return cleanup
  }, [input.collectionId, input.enabled, input.nodeId])

  const retry = useCallback((force: boolean) => {
    retryImplRef.current(force)
  }, [])

  return { ...snapshot, retry }
}

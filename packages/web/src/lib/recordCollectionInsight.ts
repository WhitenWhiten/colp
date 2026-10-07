import { isProductApiError, productClient } from '../api'
import { isSelfHostedEdition } from './edition'

const memoryRecords = new Set<string>()

function viewKey(slug: string): string {
  return `known_insight_view_${slug}`
}

function previewKey(slug: string): string {
  return `known_insight_preview_${slug}`
}

function hasTabRecord(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) !== null
  } catch {
    return memoryRecords.has(key)
  }
}

function markTabRecord(key: string): void {
  try {
    window.sessionStorage.setItem(key, '1')
  } catch {
    memoryRecords.add(key)
  }
}

function swallow(run: () => Promise<unknown>): void {
  void run().catch((error: unknown) => {
    if (isProductApiError(error)) {
      console.debug('collection insight ingest failed', error.status, error.code)
      return
    }
    console.debug('collection insight ingest failed', error)
  })
}

export function recordView(slug: string, options?: { signal?: AbortSignal }): void {
  if (isSelfHostedEdition()) return
  swallow(async () => {
    if (options?.signal?.aborted) return
    const key = viewKey(slug)
    if (hasTabRecord(key)) return
    markTabRecord(key)
    if (options?.signal?.aborted) return
    await productClient.recordPublicCollectionInsightEvent(
      { slug, eventType: 'collection_view' },
      { signal: options?.signal },
    )
  })
}

export function observePreview(element: Element, slug: string): () => void {
  if (isSelfHostedEdition()) return () => undefined
  if (typeof IntersectionObserver === 'undefined') return () => undefined
  const key = previewKey(slug)
  if (hasTabRecord(key)) return () => undefined

  let closed = false
  const observer = new IntersectionObserver((entries) => {
    if (closed) return
    if (!entries.some((entry) => entry.isIntersecting)) return
    closed = true
    observer.unobserve(element)
    markTabRecord(key)
    swallow(async () => {
      await productClient.recordPublicCollectionInsightEvent(
        { slug, eventType: 'preview_open' },
      )
    })
  }, { threshold: 0.25 })

  observer.observe(element)
  return () => {
    closed = true
    observer.disconnect()
  }
}

export function recordResourceOpen(slug: string, nodeId: string): void {
  if (isSelfHostedEdition()) return
  swallow(async () => {
    await productClient.recordPublicCollectionInsightEvent(
      { slug, eventType: 'resource_open', nodeId },
      { keepalive: true },
    )
  })
}

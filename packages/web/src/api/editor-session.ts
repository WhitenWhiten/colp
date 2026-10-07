/**
 * Editor page cursor helpers: restart, pagination, If-Match validation.
 */
import type { ProductClientError } from './product-error'

export type PageCursorSource = {
  page: {
    hasMore: boolean
    nextCursor: string | null
    returnedCount?: number
  }
}

/** True when the editor must discard partial pages and restart from page 1. */
export function shouldRestartCursor(error: ProductClientError | { code: string }): boolean {
  return error.code === 'snapshot_expired' || error.code === 'invalid_cursor'
}

/**
 * Opaque cursor for the next page request.
 * Returns null when pagination is complete or nextCursor is missing.
 */
export function nextPageCursor(page: PageCursorSource): string | null {
  if (!page?.page?.hasMore) return null
  const cursor = page.page.nextCursor
  if (typeof cursor !== 'string' || !cursor) return null
  return cursor
}

/**
 * Validate a strong EntityTag for Product concurrency headers.
 * Weak tags, empty, and * are rejected.
 */
export function buildIfMatch(etag: string): string {
  if (!etag || typeof etag !== 'string') {
    throw new Error('If-Match requires a non-empty strong entity tag')
  }
  const trimmed = etag.trim()
  if (!trimmed) {
    throw new Error('If-Match requires a non-empty strong entity tag')
  }
  if (trimmed === '*') {
    throw new Error('If-Match does not allow wildcard *')
  }
  if (/^W\//i.test(trimmed)) {
    throw new Error('If-Match does not allow weak entity tags')
  }
  return trimmed
}

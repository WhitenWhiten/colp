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


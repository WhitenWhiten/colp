/**
 * Editor page cursor helpers: restart, pagination, If-Match validation.
 */
import type { ProductApiError } from './errors'

/** True when the editor must discard partial pages and restart from page 1. */
export function shouldRestartCursor(error: ProductApiError | { code: string }): boolean {
  return error.code === 'snapshot_expired' || error.code === 'invalid_cursor'
}

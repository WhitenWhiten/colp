import { wrapProductError } from './errors'
import {
  withSameRequestRetry,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
} from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type { BookmarkPreviewModeView, LinkPreviewRequestAccepted } from './types'

/**
 * LP-05 link preview client. requestLinkPreviews is the owner/editor consent
 * that lets the server fetch preview images for a private collection; the
 * preview mode is the per-bookmark veto (auto / none) fenced by If-Match.
 */
export function createProductLinkPreviewClient(transport: ProductTransport, mutationCall: MutationCall) {
  async function requestLinkPreviews(
    collectionId: string,
    nodeIds: readonly string[],
    options: MutationOptions,
  ): Promise<LinkPreviewRequestAccepted> {
    return mutationCall(
      (csrf, commandIntentId) => transport.requestCollectionLinkPreviews(collectionId, nodeIds, {
        commandIntentId,
        csrfToken: csrf,
        signal: options.signal,
      }),
      { ...options, rotateCommandOnConflict: false },
    )
  }

  async function getBookmarkPreviewMode(
    collectionId: string,
    nodeId: string,
    options?: ReadOptions,
  ): Promise<BookmarkPreviewModeView> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getBookmarkPreviewMode(collectionId, nodeId, options?.signal)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function setBookmarkPreviewMode(
    collectionId: string,
    nodeId: string,
    mode: BookmarkPreviewModeView['mode'],
    ifMatch: string,
    options: MutationOptions,
  ): Promise<BookmarkPreviewModeView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.setBookmarkPreviewMode(collectionId, nodeId, mode, {
        commandIntentId,
        csrfToken: csrf,
        ifMatch,
        signal: options.signal,
      }),
      { ...options, rotateCommandOnConflict: false },
    )
  }

  return { requestLinkPreviews, getBookmarkPreviewMode, setBookmarkPreviewMode }
}

import type { MutationCall, MutationOptions } from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type { LinkPreviewRequestAccepted } from './types'

/**
 * LP-05 link preview client. requestLinkPreviews is the owner/editor consent
 * that lets the server fetch preview images for a private collection.
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

  return { requestLinkPreviews }
}

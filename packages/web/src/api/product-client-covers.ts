import type { MutationCall, MutationOptions } from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type { CoverPreferenceInput } from './types'

export function createProductCoverClient(transport: ProductTransport, mutationCall: MutationCall) {
  return {
    uploadCollectionImage(collectionId: string, file: File, options: MutationOptions) {
      return mutationCall((csrfToken, commandIntentId) => transport.uploadCollectionImage(collectionId, file, {
        csrfToken, commandIntentId, signal: options.signal,
      }), { ...options, rotateCommandOnConflict: false })
    },
    updateNodeCover(collectionId: string, nodeId: string, body: CoverPreferenceInput, revision: string, options: MutationOptions) {
      return mutationCall((csrfToken, commandIntentId) => transport.updateNodeCover(collectionId, nodeId, body, {
        csrfToken, commandIntentId, revision, signal: options.signal,
      }), { ...options, rotateCommandOnConflict: false })
    },
  }
}

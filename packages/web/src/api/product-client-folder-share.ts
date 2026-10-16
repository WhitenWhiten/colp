import type { ProductTransport } from './product-transport-types'
import { withSameRequestRetry, type MutationCall, type MutationOptions, type ReadOptions } from './product-client-shared'
import { wrapProductError } from './errors'

export function createProductFolderShareClient(transport: ProductTransport, mutate: MutationCall) {
  return {
    getFolderShare(collectionId: string, nodeId: string, options?: ReadOptions) {
      return withSameRequestRetry(async () => {
        try { return await transport.getFolderShare(collectionId, nodeId, options?.signal) }
        catch (error) { throw wrapProductError(error) }
      }, options ?? {})
    },
    putFolderShare(collectionId: string, nodeId: string, options: MutationOptions) {
      return mutate((csrf, commandIntentId) => transport.putFolderShare(collectionId, nodeId,
        { csrfToken: csrf, commandIntentId, signal: options.signal }), options)
    },
    deleteFolderShare(collectionId: string, nodeId: string, options: MutationOptions) {
      return mutate((csrf, commandIntentId) => transport.deleteFolderShare(collectionId, nodeId,
        { csrfToken: csrf, commandIntentId, signal: options.signal }), options)
    },
  }
}

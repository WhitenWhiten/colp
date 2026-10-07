import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions } from './product-transport-types'
import type { ReadableReplicaExtractRequest, ReadableReplicaView } from './types'

export function createReplicaTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async getNodeReadableReplica(collectionId: string, nodeId: string, signal?: AbortSignal) {
      return request<ReadableReplicaView>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/readable`,
        headers: { Accept: 'application/json' },
        signal,
      })
    },

    async enqueueNodeReadableExtract(
      collectionId: string,
      nodeId: string,
      body: ReadableReplicaExtractRequest,
      opts: MutationCallOptions,
    ) {
      return request<ReadableReplicaView>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/readable`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },
  }
}

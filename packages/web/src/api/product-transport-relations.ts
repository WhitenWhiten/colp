import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions, RelationListParams } from './product-transport-types'
import type {
  CreateRelationRequest,
  DeleteRelationResult,
  RelationMergePatch,
  RelationPage,
  RelationView,
} from './types'

export function createRelationsTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async listRelations(collectionId: string, params: RelationListParams) {
      const query: Record<string, string | number | undefined> = {
        nodeId: params.nodeId, direction: params.direction,
        type: params.type, visibility: params.visibility,
      }
      if (params.cursor) query.cursor = params.cursor
      else if (params.limit != null) query.limit = params.limit
      return request<RelationPage>({
        method: 'GET', path: `/api/v1/collections/${encodeURIComponent(collectionId)}/relations`,
        query, signal: params.signal,
      })
    },

    async getRelation(collectionId: string, relationId: string, signal?: AbortSignal) {
      return request<RelationView>({ method: 'GET', path: `/api/v1/collections/${encodeURIComponent(collectionId)}/relations/${encodeURIComponent(relationId)}`, signal })
    },

    async createRelation(collectionId: string, body: CreateRelationRequest, opts: MutationCallOptions) {
      return request<RelationView>({ method: 'POST', path: `/api/v1/collections/${encodeURIComponent(collectionId)}/relations`, headers: mutationHeaders(opts), body, contentType: 'application/json', signal: opts.signal })
    },

    async updateRelation(
      collectionId: string,
      relationId: string,
      body: RelationMergePatch,
      opts: MutationCallOptions,
    ) {
      return request<RelationView>({ method: 'PATCH', path: `/api/v1/collections/${encodeURIComponent(collectionId)}/relations/${encodeURIComponent(relationId)}`, headers: mutationHeaders(opts), body, contentType: 'application/merge-patch+json', signal: opts.signal })
    },

    async deleteRelation(collectionId: string, relationId: string, opts: MutationCallOptions) {
      return request<DeleteRelationResult>({ method: 'DELETE', path: `/api/v1/collections/${encodeURIComponent(collectionId)}/relations/${encodeURIComponent(relationId)}`, headers: mutationHeaders(opts), signal: opts.signal })
    },
  }
}

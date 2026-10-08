import type { ProductTransportHttp } from './product-transport-http'
import type {
  CollectionChildrenPageParams,
  DeleteNodeOptions,
  EditorPageParams,
  MutationCallOptions,
  OwnedCollectionPageParams,
} from './product-transport-types'
import type {
  BookmarkNodeView,
  CollectionChildrenPage,
  CollectionMergePatch,
  CreateCollectionRequest,
  CreateCollectionResult,
  CreateNodeRequest,
  CreateNodeResult,
  DeleteNodeResult,
  EditorPage,
  MoveNodeRequest,
  MoveNodeResult,
  NodeMergePatch,
  OwnedCollectionPage,
  UpdateCollectionResult,
  UpdateNodeResult,
} from './types'

export function createEditorTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async createCollection(body: CreateCollectionRequest, opts: MutationCallOptions) {
      return request<CreateCollectionResult>({
        method: 'POST',
        path: '/api/v1/collections',
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async getEditorPage(collectionId: string, params?: EditorPageParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) {
        query.cursor = params.cursor
      } else if (params?.limit != null) {
        query.limit = params.limit
      }
      return request<EditorPage>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/editor`,
        query,
        signal: params?.signal,
      })
    },

    async listOwnedCollections(params?: OwnedCollectionPageParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) query.cursor = params.cursor
      else {
        query.kind = params?.kind
        query.visibility = params?.visibility
        query.limit = params?.limit
      }
      return request<OwnedCollectionPage>({
        method: 'GET', path: '/api/v1/collections', query,
        headers: { Accept: 'application/json' }, signal: params?.signal,
      })
    },

    async listCollectionChildren(
      collectionId: string,
      params: CollectionChildrenPageParams = {},
    ) {
      const query: Record<string, string | number | undefined> = {}
      if (params.parentId !== undefined) query.parentId = params.parentId
      if (params.sort !== undefined) query.sort = params.sort
      if (params.cursor !== undefined) {
        query.cursor = params.cursor
      } else if (params.limit !== undefined) {
        query.limit = params.limit
      }
      return request<CollectionChildrenPage>({
        method: 'GET',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/children`,
        query,
        signal: params.signal,
      })
    },

    async updateCollection(collectionId: string, body: CollectionMergePatch, opts: MutationCallOptions) {
      return request<UpdateCollectionResult>({
        method: 'PATCH',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/merge-patch+json',
        signal: opts.signal,
      })
    },

    async createNode(
      collectionId: string,
      body: CreateNodeRequest | Record<string, unknown>,
      opts: MutationCallOptions,
    ) {
      return request<CreateNodeResult>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async updateNode(
      collectionId: string,
      nodeId: string,
      body: NodeMergePatch,
      opts: MutationCallOptions,
    ) {
      return request<UpdateNodeResult>({
        method: 'PATCH',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/merge-patch+json',
        signal: opts.signal,
      })
    },

    async moveNode(
      collectionId: string,
      nodeId: string,
      body: MoveNodeRequest | Record<string, unknown>,
      opts: MutationCallOptions,
    ) {
      return request<MoveNodeResult>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/move`,
        headers: mutationHeaders(opts),
        body,
        contentType: 'application/json',
        signal: opts.signal,
      })
    },

    async deleteNode(collectionId: string, nodeId: string, opts: DeleteNodeOptions) {
      const recursive = opts.recursive === true
      const headers = mutationHeaders(opts)
      if (!recursive) {
        delete headers['If-Content-Match']
      } else if (opts.ifContentMatch) {
        headers['If-Content-Match'] = opts.ifContentMatch
      }
      return request<DeleteNodeResult | void>({
        method: 'DELETE',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}`,
        query: recursive ? { recursive: true } : undefined,
        headers,
        signal: opts.signal,
        emptyOk: true,
      })
    },

    async uploadBookmarkFavicon(
      collectionId: string,
      nodeId: string,
      file: File,
      opts: MutationCallOptions,
    ) {
      return request<BookmarkNodeView>({
        method: 'POST',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/favicon`,
        headers: mutationHeaders(opts, { 'Content-Type': file.type || 'application/octet-stream' }),
        rawBody: file,
        signal: opts.signal,
      })
    },

    async deleteBookmarkFavicon(collectionId: string, nodeId: string, opts: MutationCallOptions) {
      return request<BookmarkNodeView>({
        method: 'DELETE',
        path: `/api/v1/collections/${encodeURIComponent(collectionId)}/nodes/${encodeURIComponent(nodeId)}/favicon`,
        headers: mutationHeaders(opts),
        signal: opts.signal,
      })
    },
  }
}

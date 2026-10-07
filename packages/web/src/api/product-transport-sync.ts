import type { ProductTransportHttp } from './product-transport-http'
import type { MutationCallOptions, SyncConflictListParams, SyncTrashListParams } from './product-transport-types'
import type {
  ProductSyncConflictResolution,
  ProductSyncConflictResolutionView,
  ProductSyncReplicaRetirementView,
  SyncConflictPage,
  SyncStatusView,
  SyncTrashDetail,
  SyncTrashEmptyRequest,
  SyncTrashEmptyView,
  SyncTrashPage,
  SyncTrashRestoreBatchRequest,
  SyncTrashRestoreBatchView,
  SyncTrashRestoreView,
} from './types'

export function createSyncTransport(http: ProductTransportHttp) {
  const { request, mutationHeaders } = http

  return {
    async getSyncStatus(signal?: AbortSignal) {
      return request<SyncStatusView>({ method: 'GET', path: '/api/v1/sync/status', signal })
    },

    async listSyncConflicts(params?: SyncConflictListParams) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.cursor) query.cursor = params.cursor
      else if (params?.limit != null) query.limit = params.limit
      return request<SyncConflictPage>({
        method: 'GET', path: '/api/v1/sync/conflicts', query, signal: params?.signal,
      })
    },

    async resolveSyncConflict(
      conflictId: string,
      body: ProductSyncConflictResolution,
      opts: MutationCallOptions,
    ) {
      return request<ProductSyncConflictResolutionView>({
        method: 'POST',
        path: `/api/v1/sync/conflicts/${encodeURIComponent(conflictId)}/resolution`,
        headers: mutationHeaders(opts), body, contentType: 'application/json', signal: opts.signal,
      })
    },

    async retireSyncReplica(replicaId: string, opts: MutationCallOptions) {
      return request<ProductSyncReplicaRetirementView>({
        method: 'DELETE', path: `/api/v1/sync/replicas/${encodeURIComponent(replicaId)}`,
        headers: mutationHeaders(opts), signal: opts.signal,
      })
    },

    async listSyncTrash(params: SyncTrashListParams) {
      const query: Record<string, string | number | undefined> = { collectionId: params.collectionId }
      if (params.cursor) query.cursor = params.cursor
      else if (params.limit != null) query.limit = params.limit
      return request<SyncTrashPage>({
        method: 'GET', path: '/api/v1/sync/trash', query, signal: params.signal,
      })
    },

    async getSyncTrashItem(deletionId: string, signal?: AbortSignal) {
      return request<SyncTrashDetail>({
        method: 'GET', path: `/api/v1/sync/trash/${encodeURIComponent(deletionId)}`, signal,
      })
    },

    async restoreSyncTrashItem(deletionId: string, opts: MutationCallOptions) {
      return request<SyncTrashRestoreView>({
        method: 'POST', path: `/api/v1/sync/trash/${encodeURIComponent(deletionId)}/restore`,
        headers: mutationHeaders(opts), signal: opts.signal,
      })
    },

    async restoreSyncTrashBatch(body: SyncTrashRestoreBatchRequest, opts: MutationCallOptions) {
      return request<SyncTrashRestoreBatchView>({
        method: 'POST', path: '/api/v1/sync/trash/restore-batch',
        headers: mutationHeaders(opts), body, contentType: 'application/json', signal: opts.signal,
      })
    },

    async restoreSyncTrashSubtree(deletionId: string, opts: MutationCallOptions) {
      return request<SyncTrashRestoreBatchView>({
        method: 'POST', path: `/api/v1/sync/trash/${encodeURIComponent(deletionId)}/restore-subtree`,
        headers: mutationHeaders(opts), signal: opts.signal,
      })
    },

    async emptySyncTrash(body: SyncTrashEmptyRequest, opts: MutationCallOptions) {
      return request<SyncTrashEmptyView>({
        method: 'POST', path: '/api/v1/sync/trash/empty',
        headers: mutationHeaders(opts), body, contentType: 'application/json', signal: opts.signal,
      })
    },
  }
}

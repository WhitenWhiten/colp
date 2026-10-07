import { clearCommandId } from './commandId'
import {
  createAuthRetryRead,
  invalidAnnotationCursor,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
  type SessionReader,
} from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type {
  ProductSyncConflictResolution,
  ProductSyncConflictResolutionView,
  ProductSyncReplicaRetirementView,
  SyncConflictPage,
  SyncConflictSummary,
  SyncStatusView,
  SyncTrashDetail,
  SyncTrashEmptyRequest,
  SyncTrashEmptyView,
  SyncTrashListItem,
  SyncTrashPage,
  SyncTrashRestoreBatchRequest,
  SyncTrashRestoreBatchView,
  SyncTrashRestoreView,
} from './types'

export async function loadSyncConflictPages(
  readPage: (params: { limit?: number; cursor?: string }) => Promise<SyncConflictPage>,
  limit: number,
): Promise<SyncConflictSummary[]> {
  const items: SyncConflictSummary[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let page = await readPage({ limit })
  for (;;) {
    for (const item of page.items) {
      if (ids.has(item.id)) throw invalidAnnotationCursor('Sync Conflict pagination overlapped an item.')
      ids.add(item.id)
      items.push(item)
    }
    const cursor = page.page.nextCursor
    if (cursor === null) return items
    if (!cursor || cursors.has(cursor)) throw invalidAnnotationCursor('Sync Conflict pagination returned an invalid continuation.')
    cursors.add(cursor)
    page = await readPage({ cursor })
  }
}

export async function loadSyncTrashPages(
  readPage: (params: { limit?: number; cursor?: string }) => Promise<SyncTrashPage>,
  limit: number,
): Promise<SyncTrashListItem[]> {
  const items: SyncTrashListItem[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let page = await readPage({ limit })
  for (;;) {
    for (const item of page.items) {
      if (ids.has(item.deletionId)) throw invalidAnnotationCursor('Sync Trash pagination overlapped an item.')
      ids.add(item.deletionId)
      items.push(item)
    }
    const cursor = page.page.nextCursor
    if (cursor === null) return items
    if (!cursor || cursors.has(cursor)) throw invalidAnnotationCursor('Sync Trash pagination returned an invalid continuation.')
    cursors.add(cursor)
    page = await readPage({ cursor })
  }
}

export function createProductSyncClient(
  transport: ProductTransport,
  mutationCall: MutationCall,
  getSession: SessionReader,
) {
  const authRetryRead = createAuthRetryRead(getSession)

  async function getSyncStatus(options?: ReadOptions): Promise<SyncStatusView> {
    return authRetryRead(() => transport.getSyncStatus(options?.signal), options)
  }

  async function getSyncConflictPage(
    params: { limit?: number; cursor?: string } = {}, options?: ReadOptions,
  ): Promise<SyncConflictPage> {
    return authRetryRead(
      () => transport.listSyncConflicts({ ...params, signal: options?.signal }), options,
    )
  }

  async function loadSyncConflicts(
    options?: ReadOptions & { limit?: number },
  ): Promise<SyncConflictSummary[]> {
    return loadSyncConflictPages(
      (params) => getSyncConflictPage(params, options),
      options?.limit ?? 25,
    )
  }

  function syncMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function resolveSyncConflict(
    conflictId: string,
    body: ProductSyncConflictResolution,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<ProductSyncConflictResolutionView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.resolveSyncConflict(conflictId, body, {
        commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal,
      }),
      syncMutationOptions(options),
    )
  }

  async function retireSyncReplica(
    replicaId: string, ifMatch: string, options: MutationOptions,
  ): Promise<ProductSyncReplicaRetirementView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.retireSyncReplica(replicaId, {
        commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal,
      }),
      syncMutationOptions(options),
    )
  }

  async function getSyncTrashPage(
    params: { collectionId: string; limit?: number; cursor?: string }, options?: ReadOptions,
  ): Promise<SyncTrashPage> {
    return authRetryRead(
      () => transport.listSyncTrash({ ...params, signal: options?.signal }), options,
    )
  }

  async function loadSyncTrash(
    options: ReadOptions & { collectionId: string; limit?: number },
  ): Promise<SyncTrashListItem[]> {
    return loadSyncTrashPages(
      (params) => getSyncTrashPage({ collectionId: options.collectionId, ...params }, options),
      options.limit ?? 20,
    )
  }

  async function getSyncTrashItem(deletionId: string, options?: ReadOptions): Promise<SyncTrashDetail> {
    return authRetryRead(() => transport.getSyncTrashItem(deletionId, options?.signal), options)
  }

  async function restoreSyncTrashItem(
    deletionId: string, ifMatch: string, options: MutationOptions,
  ): Promise<SyncTrashRestoreView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.restoreSyncTrashItem(deletionId, {
        commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal,
      }),
      syncMutationOptions(options),
    )
  }

  async function restoreSyncTrashBatch(
    body: SyncTrashRestoreBatchRequest, options: MutationOptions,
  ): Promise<SyncTrashRestoreBatchView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.restoreSyncTrashBatch(body, {
        commandIntentId, csrfToken: csrf, signal: options.signal,
      }),
      syncMutationOptions(options),
    )
  }

  async function restoreSyncTrashSubtree(
    deletionId: string, ifMatch: string, options: MutationOptions,
  ): Promise<SyncTrashRestoreBatchView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.restoreSyncTrashSubtree(deletionId, {
        commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal,
      }),
      syncMutationOptions(options),
    )
  }

  async function emptySyncTrash(
    body: SyncTrashEmptyRequest, options: MutationOptions,
  ): Promise<SyncTrashEmptyView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.emptySyncTrash(body, {
        commandIntentId, csrfToken: csrf, signal: options.signal,
      }),
      syncMutationOptions(options),
    )
  }

  function abandonSyncConflictIntent(intentId: string): void { clearCommandId(intentId) }
  function abandonSyncReplicaIntent(intentId: string): void { clearCommandId(intentId) }
  function abandonSyncTrashIntent(intentId: string): void { clearCommandId(intentId) }

  return {
    getSyncStatus,
    getSyncConflictPage,
    loadSyncConflicts,
    resolveSyncConflict,
    retireSyncReplica,
    getSyncTrashPage,
    loadSyncTrash,
    getSyncTrashItem,
    restoreSyncTrashItem,
    restoreSyncTrashBatch,
    restoreSyncTrashSubtree,
    emptySyncTrash,
    abandonSyncConflictIntent,
    abandonSyncReplicaIntent,
    abandonSyncTrashIntent,
  }
}

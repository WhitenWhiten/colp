import { clearCommandId } from './commandId'
import { ProductApiError, wrapProductError } from './errors'
import {
  createAuthRetryRead,
  withSameRequestRetry,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
  type SessionReader,
} from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type {
  ClassifyInboxAcceptReceipt,
  ClassifyInboxAcceptRequest,
  ClassifyInboxDecisionReceipt,
  ClassifyInboxPage,
  CollectionVersion,
  CollectionVersionCreateRequest,
  CollectionVersionPage,
  CollectionVersionRestoreReceipt,
  CollectionVersionRestoreRequest,
  ExportJob,
  ExportJobPage,
  ExportLibraryDocument,
  LinkHealthChecksReceipt,
  LinkHealthChecksRequest,
  LinkHealthPage,
  LinkHealthStatus,
  OrganizePlan,
  OrganizePlanApplyReceipt,
  OrganizePlanApplyRequest,
  OrganizePlanCreateRequest,
  ReadableReplicaExtractRequest,
  ReadableReplicaView,
  ReadingProgressMutationResult,
  ReadingProgressPage,
  ReadingProgressResourceType,
  ReadingProgressStatus,
  ReadingProgressUpdate,
  ReadingProgressView,
  SavedResourceType,
  SavedResourceView,
  SaveResourceResult,
  WriteApprovalDecision,
  WriteApprovalDecisionResult,
  WriteApprovalPage,
  WriteApprovalView,
} from './types'

export type SavedResourceQuery = {
  resourceType?: SavedResourceType
  collectionId?: string
  createdAfter?: string
  createdBefore?: string
  limit?: number
}

export type ReadingProgressQuery = { status?: ReadingProgressStatus; limit?: number }

export type WriteApprovalQuery = {
  limit?: number
}

export type LinkHealthQuery = {
  status?: LinkHealthStatus
  collectionId?: string
  duplicate?: boolean
  limit?: number
  cursor?: string
  scope?: 'owned' | 'shared' | 'all'
}

export type ClassifyInboxQuery = {
  limit?: number
  cursor?: string
}

type CollectionVersionListQuery = {
  limit?: number
  cursor?: string
}

export function createProductLibraryClient(
  transport: ProductTransport,
  mutationCall: MutationCall,
  getSession: SessionReader,
) {
  const authRetryRead = createAuthRetryRead(getSession)

  async function getSavedResourcePage(query: SavedResourceQuery & { cursor?: string } = {}, options?: ReadOptions) {
    const request = () => withSameRequestRetry(async () => {
      try { return await transport.listSavedResources({ ...query, signal: options?.signal }) }
      catch (error) { throw wrapProductError(error) }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
    try { return await request() }
    catch (error) {
      const apiError = wrapProductError(error)
      if (!apiError.isAuthRequired || options?.signal?.aborted) throw apiError
      await getSession({ signal: options?.signal, maxRetries: 0 })
      return request()
    }
  }

  async function loadSavedResources(query: SavedResourceQuery = {}, options?: ReadOptions): Promise<SavedResourceView[]> {
    const items: SavedResourceView[] = []
    const cursors = new Set<string>()
    let page = await getSavedResourcePage(query, options)
    for (;;) {
      items.push(...page.items)
      if (!page.page.hasMore) return items
      const cursor = page.page.nextCursor
      if (!cursor || cursors.has(cursor)) throw new ProductApiError({ status: 400, code: 'invalid_cursor', message: 'Saved Resource pagination returned an invalid continuation.', recovery: 'restart_from_first_page', sameRequestRetrySafe: false })
      cursors.add(cursor)
      page = await getSavedResourcePage({ cursor }, options)
    }
  }

  function savedMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function saveResource(resourceType: SavedResourceType, resourceId: string, options: MutationOptions): Promise<SaveResourceResult> {
    return mutationCall((csrf, commandIntentId) => transport.saveResource(resourceType, resourceId, { commandIntentId, csrfToken: csrf, signal: options.signal }), savedMutationOptions(options))
  }

  async function unsaveResource(resourceType: SavedResourceType, resourceId: string, options: MutationOptions): Promise<void> {
    return mutationCall((csrf, commandIntentId) => transport.unsaveResource(resourceType, resourceId, { commandIntentId, csrfToken: csrf, signal: options.signal }), savedMutationOptions(options))
  }

  function abandonSavedResourceIntent(intentId: string): void { clearCommandId(intentId) }

  async function getReadingProgress(resourceType: ReadingProgressResourceType, resourceId: string, options?: ReadOptions): Promise<ReadingProgressView | null> {
    return authRetryRead(() => transport.getReadingProgress(resourceType, resourceId, options?.signal), options)
  }

  async function getReadingProgressPage(query: ReadingProgressQuery & { cursor?: string } = {}, options?: ReadOptions): Promise<ReadingProgressPage> {
    return authRetryRead(() => transport.listReadingProgress({ ...query, signal: options?.signal }), options)
  }

  async function loadReadingProgress(query: ReadingProgressQuery = {}, options?: ReadOptions): Promise<ReadingProgressView[]> {
    const items: ReadingProgressView[] = []; const cursors = new Set<string>(); let page = await getReadingProgressPage(query, options)
    for (;;) {
      items.push(...page.items)
      if (!page.page.hasMore) return items
      const cursor = page.page.nextCursor
      if (!cursor || cursors.has(cursor)) throw new ProductApiError({ status: 400, code: 'invalid_cursor', message: 'Reading Progress pagination returned an invalid continuation.', recovery: 'refresh_and_retry', sameRequestRetrySafe: false })
      cursors.add(cursor); page = await getReadingProgressPage({ cursor }, options)
    }
  }

  function readingProgressMutationOptions(options: MutationOptions): MutationOptions { return { ...options, rotateCommandOnConflict: false } }

  async function putReadingProgress(resourceType: ReadingProgressResourceType, resourceId: string, body: ReadingProgressUpdate, ifMatch: string | null, options: MutationOptions): Promise<ReadingProgressMutationResult & { etag: string }> {
    return mutationCall((csrf, commandIntentId) => transport.putReadingProgress(resourceType, resourceId, body, { commandIntentId, csrfToken: csrf, ...(ifMatch ? { ifMatch } : {}), signal: options.signal }), readingProgressMutationOptions(options))
  }

  async function resetReadingProgress(resourceType: ReadingProgressResourceType, resourceId: string, ifMatch: string, options: MutationOptions): Promise<void> {
    return mutationCall((csrf, commandIntentId) => transport.resetReadingProgress(resourceType, resourceId, { commandIntentId, csrfToken: csrf, ifMatch, signal: options.signal }), readingProgressMutationOptions(options))
  }

  function abandonReadingProgressIntent(intentId: string): void { clearCommandId(intentId) }

  async function getWriteApprovalPage(
    query: WriteApprovalQuery = {},
    options?: ReadOptions,
  ): Promise<WriteApprovalPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.listWriteApprovals({
          limit: query.limit,
          signal: options?.signal,
        })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getWriteApproval(
    planId: string,
    options?: ReadOptions,
  ): Promise<WriteApprovalView> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getWriteApproval(planId, options?.signal)
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function writeApprovalMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function decideWriteApproval(
    planId: string,
    decision: WriteApprovalDecision,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<WriteApprovalDecisionResult> {
    return mutationCall(
      (csrf, commandIntentId) => transport.decideWriteApproval(planId, decision, {
        commandIntentId,
        csrfToken: csrf,
        ifMatch,
        signal: options.signal,
      }),
      writeApprovalMutationOptions(options),
    )
  }

  function abandonWriteApprovalIntent(intentId: string): void {
    clearCommandId(intentId)
  }

  async function getMyLinkHealth(
    query: LinkHealthQuery = {},
    options?: ReadOptions,
  ): Promise<LinkHealthPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getMyLinkHealth({
          status: query.status,
          collectionId: query.collectionId,
          duplicate: query.duplicate,
          limit: query.limit,
          cursor: query.cursor,
          scope: query.scope,
          signal: options?.signal,
        })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function linkHealthMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function enqueueMyLinkHealthChecks(
    body: LinkHealthChecksRequest,
    options: MutationOptions,
  ): Promise<LinkHealthChecksReceipt> {
    return mutationCall(
      (csrf, commandIntentId) => transport.enqueueMyLinkHealthChecks(body, {
        commandIntentId,
        csrfToken: csrf,
        signal: options.signal,
      }),
      linkHealthMutationOptions(options),
    )
  }

  async function getMyClassifyInbox(
    query: ClassifyInboxQuery = {},
    options?: ReadOptions,
  ): Promise<ClassifyInboxPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getMyClassifyInbox({
          limit: query.limit,
          cursor: query.cursor,
          signal: options?.signal,
        })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function classifyInboxMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function skipMyClassifyInboxItem(
    nodeId: string,
    options: MutationOptions,
  ): Promise<ClassifyInboxDecisionReceipt> {
    return mutationCall(
      (csrf, commandIntentId) => transport.skipMyClassifyInboxItem(nodeId, {}, {
        commandIntentId,
        csrfToken: csrf,
        signal: options.signal,
      }),
      classifyInboxMutationOptions(options),
    )
  }

  async function acceptMyClassifyInboxItem(
    nodeId: string,
    body: ClassifyInboxAcceptRequest,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<ClassifyInboxAcceptReceipt> {
    return mutationCall(
      (csrf, commandIntentId) => transport.acceptMyClassifyInboxItem(nodeId, body, {
        commandIntentId,
        csrfToken: csrf,
        ifMatch,
        signal: options.signal,
      }),
      classifyInboxMutationOptions(options),
    )
  }

  async function listMyExportJobs(options?: ReadOptions): Promise<ExportJobPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.listMyExportJobs({ signal: options?.signal })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function exportJobMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function createMyExportJob(options: MutationOptions): Promise<ExportJob> {
    return mutationCall(
      (csrf, commandIntentId) => transport.createMyExportJob({
        commandIntentId,
        csrfToken: csrf,
        signal: options.signal,
      }),
      exportJobMutationOptions(options),
    )
  }

  async function getMyExportJob(jobId: string, options?: ReadOptions): Promise<ExportJob> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getMyExportJob(jobId, { signal: options?.signal })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function downloadMyExportJob(
    jobId: string,
    options?: ReadOptions,
  ): Promise<ExportLibraryDocument> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.downloadMyExportJob(jobId, { signal: options?.signal })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function organizePlanMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  function collectionVersionMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function createCollectionVersion(
    collectionId: string,
    body: CollectionVersionCreateRequest,
    options: MutationOptions & { ifMatch: string },
  ): Promise<CollectionVersion> {
    return mutationCall(
      (csrf, commandIntentId) => transport.createCollectionVersion(collectionId, body, {
        commandIntentId,
        csrfToken: csrf,
        ifMatch: options.ifMatch,
        signal: options.signal,
      }),
      collectionVersionMutationOptions(options),
    )
  }

  async function listCollectionVersions(
    collectionId: string,
    query: CollectionVersionListQuery = {},
    options?: ReadOptions,
  ): Promise<CollectionVersionPage> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.listCollectionVersions(collectionId, {
          ...(query.cursor ? { cursor: query.cursor } : { limit: query.limit }),
          signal: options?.signal,
        })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function getCollectionVersion(
    collectionId: string,
    versionId: string,
    options?: ReadOptions,
  ): Promise<CollectionVersion> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getCollectionVersion(collectionId, versionId, {
          signal: options?.signal,
        })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function restoreCollectionVersion(
    collectionId: string,
    versionId: string,
    body: CollectionVersionRestoreRequest,
    options: MutationOptions & { ifMatch: string },
  ): Promise<CollectionVersionRestoreReceipt> {
    return mutationCall(
      (csrf, commandIntentId) => transport.restoreCollectionVersion(collectionId, versionId, body, {
        commandIntentId,
        csrfToken: csrf,
        ifMatch: options.ifMatch,
        signal: options.signal,
      }),
      collectionVersionMutationOptions(options),
    )
  }

  async function getNodeReadableReplica(
    collectionId: string,
    nodeId: string,
    options?: ReadOptions,
  ): Promise<ReadableReplicaView> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getNodeReadableReplica(collectionId, nodeId, options?.signal)
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  function readableReplicaMutationOptions(options: MutationOptions): MutationOptions {
    // Callers split auto vs force into distinct intent nonces so a stored
    // command id from force:false cannot 409 a later force:true retry.
    return { ...options, rotateCommandOnConflict: false }
  }

  async function enqueueNodeReadableExtract(
    collectionId: string,
    nodeId: string,
    body: ReadableReplicaExtractRequest,
    options: MutationOptions,
  ): Promise<ReadableReplicaView> {
    return mutationCall(
      (csrf, commandIntentId) => transport.enqueueNodeReadableExtract(collectionId, nodeId, body, {
        commandIntentId,
        csrfToken: csrf,
        signal: options.signal,
      }),
      readableReplicaMutationOptions(options),
    )
  }

  async function createCollectionOrganizePlan(
    collectionId: string,
    body: OrganizePlanCreateRequest,
    options: MutationOptions,
  ): Promise<OrganizePlan> {
    return mutationCall(
      (csrf, commandIntentId) => transport.createCollectionOrganizePlan(collectionId, body, {
        commandIntentId,
        csrfToken: csrf,
        signal: options.signal,
      }),
      organizePlanMutationOptions(options),
    )
  }

  async function getCollectionOrganizePlan(
    collectionId: string,
    planId: string,
    options?: ReadOptions,
  ): Promise<OrganizePlan> {
    return withSameRequestRetry(async () => {
      try {
        return await transport.getCollectionOrganizePlan(collectionId, planId, {
          signal: options?.signal,
        })
      } catch (error) {
        throw wrapProductError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function applyCollectionOrganizePlan(
    collectionId: string,
    planId: string,
    body: OrganizePlanApplyRequest,
    options: MutationOptions & { ifMatch: string },
  ): Promise<OrganizePlanApplyReceipt> {
    return mutationCall(
      (csrf, commandIntentId) => transport.applyCollectionOrganizePlan(collectionId, planId, body, {
        commandIntentId,
        csrfToken: csrf,
        ifMatch: options.ifMatch,
        signal: options.signal,
      }),
      organizePlanMutationOptions(options),
    )
  }

  return {
    getSavedResourcePage,
    loadSavedResources,
    saveResource,
    unsaveResource,
    abandonSavedResourceIntent,
    getReadingProgress,
    getReadingProgressPage,
    loadReadingProgress,
    putReadingProgress,
    resetReadingProgress,
    abandonReadingProgressIntent,
    getWriteApprovalPage,
    getWriteApproval,
    decideWriteApproval,
    abandonWriteApprovalIntent,
    getMyLinkHealth,
    enqueueMyLinkHealthChecks,
    getMyClassifyInbox,
    skipMyClassifyInboxItem,
    acceptMyClassifyInboxItem,
    listMyExportJobs,
    createMyExportJob,
    getMyExportJob,
    downloadMyExportJob,
    createCollectionOrganizePlan,
    getCollectionOrganizePlan,
    applyCollectionOrganizePlan,
    createCollectionVersion,
    listCollectionVersions,
    getCollectionVersion,
    restoreCollectionVersion,
    getNodeReadableReplica,
    enqueueNodeReadableExtract,
  }
}

import { clearCommandId } from './commandId'
import { wrapProductError } from './errors'
import {
  withSameRequestRetry,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
} from './product-client-shared'
import type { ProductTransport } from './product-transport-types'
import type {
  CollectionVersion,
  CollectionVersionCreateRequest,
  CollectionVersionPage,
  CollectionVersionRestoreReceipt,
  CollectionVersionRestoreRequest,
  LinkHealthChecksReceipt,
  LinkHealthChecksRequest,
  LinkHealthPage,
  LinkHealthStatus,
  WriteApprovalDecision,
  WriteApprovalDecisionResult,
  WriteApprovalPage,
  WriteApprovalView,
} from './types'

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

type CollectionVersionListQuery = {
  limit?: number
  cursor?: string
}

export function createProductLibraryClient(
  transport: ProductTransport,
  mutationCall: MutationCall,
) {
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
  return {
    getWriteApprovalPage,
    getWriteApproval,
    decideWriteApproval,
    abandonWriteApprovalIntent,
    getMyLinkHealth,
    enqueueMyLinkHealthChecks,
    createCollectionVersion,
    listCollectionVersions,
    getCollectionVersion,
    restoreCollectionVersion,
  }
}

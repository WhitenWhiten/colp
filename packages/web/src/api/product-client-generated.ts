import {
  createProductCollaborationClient,
  createProductLibraryOrderClient,
  type CollectionInviteCreated,
  type CollectionMemberRoleMergePatch,
  type CollectionMembersPage,
  type CollaborationMembershipResult,
  type MyCollaborationInvitesPage,
  type SharedCollectionPage,
  type LibraryOrderSectionName,
  type LibraryOrderSectionView,
  type LibraryOrderUpdateRequest,
  type LibraryOrderView,
  type InviteCollectionMemberRequest,
} from '@known/product-v1-client'
import { getApiBaseUrl } from './config'
import { getOrCreateCommandId } from './commandId'
import {
  withSameRequestRetry,
  wrapGeneratedFollowError,
  type MutationCall,
  type MutationOptions,
  type ReadOptions,
} from './product-client-shared'
import { timedFetch } from './requestTimeout'
import { productRequestCredentials } from './product-credentials'
import { getCsrfToken } from './sessionStore'
import type { CollectionKind, CollectionVisibility } from './types'

type OwnedCollectionQuery = {
  kind?: CollectionKind
  visibility?: CollectionVisibility
  limit?: number
}

/** Apply the same actor/cookie boundary as the hand-written Product transport. */
function timedProductFetch(signal?: AbortSignal): typeof globalThis.fetch {
  const transport = timedFetch(signal)
  return (input, init) => transport(input, {
    ...init,
    credentials: productRequestCredentials(init?.method ?? (input instanceof Request ? input.method : 'GET')),
  })
}

export function createProductGeneratedClient(
  mutationCall: MutationCall,
  requireCsrf: () => Promise<string>,
) {
  function libraryOrderClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductLibraryOrderClient({
      origin,
      csrfToken,
      fetch: fetchWithSignal,
    })
  }

  const libraryOrderMutationOptions = (options: MutationOptions): MutationOptions => ({
    ...options,
    rotateCommandOnConflict: false,
  })

  async function getMyLibraryOrder(options?: ReadOptions): Promise<LibraryOrderView> {
    return withSameRequestRetry(async () => {
      const csrf = await requireCsrf()
      try {
        return await libraryOrderClient(csrf, options?.signal).get()
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function updateMyLibraryOrder(
    section: LibraryOrderSectionName,
    body: LibraryOrderUpdateRequest,
    options: MutationOptions,
  ): Promise<LibraryOrderSectionView> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await libraryOrderClient(csrf, options.signal).update(
          section, body, getOrCreateCommandId(intentId),
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, libraryOrderMutationOptions(options))
  }

  function collaborationClient(csrfToken: string, signal?: AbortSignal) {
    const configured = getApiBaseUrl()
    const origin = configured || globalThis.location?.origin || 'http://localhost'
    const fetchWithSignal = timedProductFetch(signal)
    return createProductCollaborationClient({
      origin,
      csrfToken,
      ...(typeof globalThis.location?.origin === 'string'
        ? { originHeader: globalThis.location.origin }
        : {}),
      fetch: fetchWithSignal,
    })
  }

  function collaborationMutationOptions(options: MutationOptions): MutationOptions {
    return { ...options, rotateCommandOnConflict: false }
  }

  async function listCollectionMembers(
    collectionId: string,
    options?: ReadOptions,
  ): Promise<CollectionMembersPage> {
    return withSameRequestRetry(async () => {
      try {
        return await collaborationClient(getCsrfToken() ?? '', options?.signal).listCollectionMembers(collectionId)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listSharedCollections(
    query: OwnedCollectionQuery & { cursor?: string } = {},
    options?: ReadOptions,
  ): Promise<SharedCollectionPage> {
    return withSameRequestRetry(async () => {
      try {
        return await collaborationClient(getCsrfToken() ?? '', options?.signal).listSharedCollections(query)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function listMyCollaborationInvites(
    options?: ReadOptions,
  ): Promise<MyCollaborationInvitesPage> {
    return withSameRequestRetry(async () => {
      try {
        return await collaborationClient(getCsrfToken() ?? '', options?.signal).listMyCollaborationInvites()
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error
        throw wrapGeneratedFollowError(error)
      }
    }, { maxRetries: options?.maxRetries, signal: options?.signal })
  }

  async function acceptCollaborationInvite(
    inviteId: string,
    options: MutationOptions,
  ): Promise<CollaborationMembershipResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).acceptCollaborationInvite(
          inviteId,
          getOrCreateCommandId(intentId),
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function declineCollaborationInvite(
    inviteId: string,
    options: MutationOptions,
  ): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).declineCollaborationInvite(
          inviteId,
          getOrCreateCommandId(intentId),
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function inviteCollectionMember(
    collectionId: string,
    body: InviteCollectionMemberRequest,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CollectionInviteCreated> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).inviteCollectionMember(
          collectionId,
          body,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function revokeCollectionInvite(
    collectionId: string,
    inviteId: string,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).revokeCollectionInvite(
          collectionId,
          inviteId,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function updateCollectionMemberRole(
    collectionId: string,
    subjectId: string,
    body: CollectionMemberRoleMergePatch,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<CollaborationMembershipResult> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).updateCollectionMemberRole(
          collectionId,
          subjectId,
          body,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }

  async function removeCollectionMember(
    collectionId: string,
    subjectId: string,
    ifMatch: string,
    options: MutationOptions,
  ): Promise<void> {
    return mutationCall(async (csrf, intentId) => {
      try {
        return await collaborationClient(csrf, options.signal).removeCollectionMember(
          collectionId,
          subjectId,
          getOrCreateCommandId(intentId),
          ifMatch,
        )
      } catch (error) {
        throw wrapGeneratedFollowError(error)
      }
    }, collaborationMutationOptions(options))
  }
  return {
    getMyLibraryOrder,
    updateMyLibraryOrder,
    listCollectionMembers,
    listSharedCollections,
    listMyCollaborationInvites,
    acceptCollaborationInvite,
    declineCollaborationInvite,
    inviteCollectionMember,
    revokeCollectionInvite,
    updateCollectionMemberRole,
    removeCollectionMember,
  }
}

import { createProductFaviconClient } from './product-client-favicon'
/**
 * Canonical Product API client used by Auth, Collection editor, Annotation workflows, and public reads.
 *
 * This module owns the only shared Product client. The internal transport has
 * no singleton or application policy of its own.
 * - credentials: include
 * - Mutations: Known-Command-Id + X-CSRF-Token from session bootstrap
 * - Editor and public Collection pagination with snapshot_expired restart
 *
 * Set VITE_MOCK_SESSION=true to bypass the real /api/v1/session endpoint
 * and return mock session + me data. Useful for local dev when backend is unavailable.
 */
import { getApiBaseUrl } from './config'
import {
  mutationIntentKey,
  newCommandId,
} from './commandId'
import {
  ProductApiError,
  recoveryStrategyFor,
  isProductApiError,
  type RecoveryStrategy,
} from './errors'
import { createBookmarkSubscriptionWebClient } from './product-client-subscription-exits'
import { createBookmarkPreferencesWebClient } from './product-client-bookmark-preferences'
import { createProductCollectionsClient } from './product-client-collections'
import { createProductGeneratedClient } from './product-client-generated'
import { createProductLibraryClient } from './product-client-library'
import { createProductSearchPublicClient } from './product-client-search-public'
import { createProductSessionClient } from './product-client-session'
import { createProductSyncClient } from './product-client-sync'
import { createProductTransport } from './product-transport'
import { subscribeSession } from './sessionStore'

export type { MutationOptions, ReadOptions } from './product-client-shared'
export type { OwnedCollectionQuery } from './product-client-collections'
export type {
  LinkHealthQuery,
  WriteApprovalQuery,
} from './product-client-library'
export { loadSyncConflictPages, loadSyncTrashPages } from './product-client-sync'
export { ProductApiError, isProductApiError, recoveryStrategyFor }
export type { RecoveryStrategy }

const productTransport = createProductTransport({ baseUrl: getApiBaseUrl() })

const sessionClient = createProductSessionClient(productTransport)
const { mutationCall, requireCsrf } = sessionClient
const collectionsClient = createProductCollectionsClient(productTransport, mutationCall)
const searchPublicClient = createProductSearchPublicClient(productTransport)
const libraryClient = createProductLibraryClient(productTransport, mutationCall)
const syncClient = createProductSyncClient(productTransport, mutationCall, sessionClient.getSession)
const generatedClient = createProductGeneratedClient(mutationCall, requireCsrf)

/** The sole application-level Product client instance. */
export const productClient = Object.freeze({
  ...createProductFaviconClient(productTransport, mutationCall),
  uploadBookmarkFavicon: collectionsClient.uploadBookmarkFavicon,
  deleteBookmarkFavicon: collectionsClient.deleteBookmarkFavicon,
  ...createBookmarkPreferencesWebClient(mutationCall),
  ...createBookmarkSubscriptionWebClient(mutationCall),
  getSession: sessionClient.getSession,
  getMe: sessionClient.getMe,
  updateMe: sessionClient.updateMe,
  bootstrapSession: sessionClient.bootstrapSession,
  deleteSession: sessionClient.deleteSession,
  createCollection: collectionsClient.createCollection,
  getOwnedCollectionsPage: collectionsClient.getOwnedCollectionsPage,
  loadOwnedCollections: collectionsClient.loadOwnedCollections,
  updateCollection: collectionsClient.updateCollection,
  getCollectionEditorPage: collectionsClient.getCollectionEditorPage,
  loadEditorSnapshot: collectionsClient.loadEditorSnapshot,
  getMyLibraryOrder: generatedClient.getMyLibraryOrder,
  updateMyLibraryOrder: generatedClient.updateMyLibraryOrder,
  listCollectionMembers: generatedClient.listCollectionMembers,
  listSharedCollections: generatedClient.listSharedCollections,
  listMyCollaborationInvites: generatedClient.listMyCollaborationInvites,
  acceptCollaborationInvite: generatedClient.acceptCollaborationInvite,
  declineCollaborationInvite: generatedClient.declineCollaborationInvite,
  inviteCollectionMember: generatedClient.inviteCollectionMember,
  revokeCollectionInvite: generatedClient.revokeCollectionInvite,
  updateCollectionMemberRole: generatedClient.updateCollectionMemberRole,
  removeCollectionMember: generatedClient.removeCollectionMember,
  searchResources: searchPublicClient.searchResources,
  getSyncStatus: syncClient.getSyncStatus,
  loadSyncConflicts: syncClient.loadSyncConflicts,
  resolveSyncConflict: syncClient.resolveSyncConflict,
  retireSyncReplica: syncClient.retireSyncReplica,
  loadSyncTrash: syncClient.loadSyncTrash,
  getSyncTrashItem: syncClient.getSyncTrashItem,
  restoreSyncTrashItem: syncClient.restoreSyncTrashItem,
  restoreSyncTrashBatch: syncClient.restoreSyncTrashBatch,
  restoreSyncTrashSubtree: syncClient.restoreSyncTrashSubtree,
  emptySyncTrash: syncClient.emptySyncTrash,
  abandonSyncConflictIntent: syncClient.abandonSyncConflictIntent,
  abandonSyncReplicaIntent: syncClient.abandonSyncReplicaIntent,
  abandonSyncTrashIntent: syncClient.abandonSyncTrashIntent,
  getWriteApprovalPage: libraryClient.getWriteApprovalPage,
  getWriteApproval: libraryClient.getWriteApproval,
  decideWriteApproval: libraryClient.decideWriteApproval,
  abandonWriteApprovalIntent: libraryClient.abandonWriteApprovalIntent,
  getMyLinkHealth: libraryClient.getMyLinkHealth,
  enqueueMyLinkHealthChecks: libraryClient.enqueueMyLinkHealthChecks,
  createCollectionVersion: libraryClient.createCollectionVersion,
  listCollectionVersions: libraryClient.listCollectionVersions,
  getCollectionVersion: libraryClient.getCollectionVersion,
  restoreCollectionVersion: libraryClient.restoreCollectionVersion,
  loadPublicCollectionSnapshot: searchPublicClient.loadPublicCollectionSnapshot,
  createCollectionNode: collectionsClient.createCollectionNode,
  updateCollectionNode: collectionsClient.updateCollectionNode,
  moveCollectionNode: collectionsClient.moveCollectionNode,
  deleteCollectionNode: collectionsClient.deleteCollectionNode,
  loadAnnotations: collectionsClient.loadAnnotations,
  getAnnotation: collectionsClient.getAnnotation,
  createAnnotation: collectionsClient.createAnnotation,
  updateAnnotation: collectionsClient.updateAnnotation,
  deleteAnnotation: collectionsClient.deleteAnnotation,
  abandonAnnotationIntent: collectionsClient.abandonAnnotationIntent,
  loadRelations: collectionsClient.loadRelations,
  createRelation: collectionsClient.createRelation,
  updateRelation: collectionsClient.updateRelation,
  deleteRelation: collectionsClient.deleteRelation,
  abandonRelationIntent: collectionsClient.abandonRelationIntent,
  mutationIntentKey,
  newCommandId,
  subscribeSession,
})

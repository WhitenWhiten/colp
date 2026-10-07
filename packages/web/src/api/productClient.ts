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
import { createClassificationWebClient } from './product-client-classification'
import { createProductCollectionsClient } from './product-client-collections'
import { createProductCreditsClient } from './product-client-credits'
import { createProductFaviconClient } from './product-client-favicon'
import { createProductLinkPreviewClient } from './product-client-link-preview'
import { createProductGeneratedClient } from './product-client-generated'
import { createProductLibraryClient } from './product-client-library'
import { createProductSearchPublicClient } from './product-client-search-public'
import { createProductSessionClient } from './product-client-session'
import { createProductSyncClient } from './product-client-sync'
import type { ReadOptions } from './product-client-shared'
import { createProductTransport } from './product-transport'
import { subscribeSession } from './sessionStore'
import type { ExploreParams } from './types'

export type { MutationOptions, ReadOptions } from './product-client-shared'
export type { OwnedCollectionQuery } from './product-client-collections'
export type {
  ClassifyInboxQuery,
  LinkHealthQuery,
  ReadingProgressQuery,
  SavedResourceQuery,
  WriteApprovalQuery,
} from './product-client-library'
export type {
  CommunityTargetQuery,
  CommunityRankingQueryParams,
  CommunityCommentsQueryParams,
  CommunityCommentRepliesQueryParams,
  CommunityCommentSettingsQueryParams,
  CommunityNotificationsQueryParams,
  RecordPublicCollectionInsightEventInput,
  RecordPublicCollectionInsightEventOptions,
} from './product-client-generated'
export { loadSyncConflictPages, loadSyncTrashPages } from './product-client-sync'
export { ProductApiError, isProductApiError, recoveryStrategyFor }
export type { RecoveryStrategy }

const productTransport = createProductTransport({ baseUrl: getApiBaseUrl() })

const sessionClient = createProductSessionClient(productTransport)
const { mutationCall, requireCsrf } = sessionClient
const collectionsClient = createProductCollectionsClient(productTransport, mutationCall)
const searchPublicClient = createProductSearchPublicClient(productTransport)
const faviconClient = createProductFaviconClient(productTransport, mutationCall)
const linkPreviewClient = createProductLinkPreviewClient(productTransport, mutationCall)
const libraryClient = createProductLibraryClient(productTransport, mutationCall, sessionClient.getSession)
const syncClient = createProductSyncClient(productTransport, mutationCall, sessionClient.getSession)
const classificationClient = createClassificationWebClient(mutationCall)
const generatedClient = createProductGeneratedClient(mutationCall, requireCsrf)
const creditsClient = createProductCreditsClient(productTransport, sessionClient.getSession)

export async function getExploreCollections(
  params: ExploreParams = {},
  options?: ReadOptions,
) {
  return searchPublicClient.getExploreCollections(params, options)
}

/** The sole application-level Product client instance. */
export const productClient = Object.freeze({
  ...createBookmarkPreferencesWebClient(mutationCall),
  ...createBookmarkSubscriptionWebClient(mutationCall),
  getSession: sessionClient.getSession,
  getMyCredits: creditsClient.getMyCredits,
  listMyCreditLedger: creditsClient.listMyCreditLedger,
  getMyCreditLedgerEntry: creditsClient.getMyCreditLedgerEntry,
  getMe: sessionClient.getMe,
  updateMe: sessionClient.updateMe,
  uploadAvatar: sessionClient.uploadAvatar,
  bootstrapSession: sessionClient.bootstrapSession,
  deleteSession: sessionClient.deleteSession,
  createCollection: collectionsClient.createCollection,
  getOwnedCollectionsPage: collectionsClient.getOwnedCollectionsPage,
  loadOwnedCollections: collectionsClient.loadOwnedCollections,
  updateCollection: collectionsClient.updateCollection,
  getCollectionEditorPage: collectionsClient.getCollectionEditorPage,
  loadEditorSnapshot: collectionsClient.loadEditorSnapshot,
  listCollectionChildren: collectionsClient.listCollectionChildren,
  getPublicCollectionPage: searchPublicClient.getPublicCollectionPage,
  getPublicProfilePage: searchPublicClient.getPublicProfilePage,
  getPublicProfileActivity: searchPublicClient.getPublicProfileActivity,
  getFollowingPage: generatedClient.getFollowingPage,
  getFollowersPage: generatedClient.getFollowersPage,
  isFollowingProfile: generatedClient.isFollowingProfile,
  followProfile: generatedClient.followProfile,
  unfollowProfile: generatedClient.unfollowProfile,
  abandonFollowIntent: generatedClient.abandonFollowIntent,
  getCollectionFollowState: generatedClient.getCollectionFollowState,
  listFollowedCollections: generatedClient.listFollowedCollections,
  followCollection: generatedClient.followCollection,
  unfollowCollection: generatedClient.unfollowCollection,
  abandonCollectionFollowIntent: generatedClient.abandonCollectionFollowIntent,
  resolveCommunityTarget: generatedClient.resolveCommunityTarget,
  setCommunityVote: generatedClient.setCommunityVote,
  abandonCommunityVoteIntent: generatedClient.abandonCommunityVoteIntent,
  getCommunityRanking: generatedClient.getCommunityRanking,
  getCommunityComments: generatedClient.getCommunityComments,
  getCommunityComment: generatedClient.getCommunityComment,
  getCommunityCommentWithEtag: generatedClient.getCommunityCommentWithEtag,
  getCommunityCommentReplies: generatedClient.getCommunityCommentReplies,
  createCommunityComment: generatedClient.createCommunityComment,
  abandonCommunityCommentIntent: generatedClient.abandonCommunityCommentIntent,
  editCommunityComment: generatedClient.editCommunityComment,
  deleteCommunityComment: generatedClient.deleteCommunityComment,
  getCommentCuration: generatedClient.getCommentCuration,
  setCommentCuration: generatedClient.setCommentCuration,
  getCommunityCommentSettings: generatedClient.getCommunityCommentSettings,
  setCommunityCommentSettings: generatedClient.setCommunityCommentSettings,
  abandonCommunityCommentManageIntent: generatedClient.abandonCommunityCommentManageIntent,
  getCommunityNotificationsPage: generatedClient.getCommunityNotificationsPage,
  markCommunityNotificationsRead: generatedClient.markCommunityNotificationsRead,
  getCommunityNotificationPreference: generatedClient.getCommunityNotificationPreference,
  updateCommunityNotificationPreference: generatedClient.updateCommunityNotificationPreference,
  abandonCommunityNotificationIntent: generatedClient.abandonCommunityNotificationIntent,
  getMyLibraryOrder: generatedClient.getMyLibraryOrder,
  updateMyLibraryOrder: generatedClient.updateMyLibraryOrder,
  abandonLibraryOrderIntent: generatedClient.abandonLibraryOrderIntent,
  requestLinkPreviews: linkPreviewClient.requestLinkPreviews,
  getBookmarkPreviewMode: linkPreviewClient.getBookmarkPreviewMode,
  setBookmarkPreviewMode: linkPreviewClient.setBookmarkPreviewMode,
  getMyFaviconPolicy: faviconClient.getMyFaviconPolicy,
  updateMyFaviconPolicy: faviconClient.updateMyFaviconPolicy,
  getBookmarkFaviconSource: faviconClient.getBookmarkFaviconSource,
  setBookmarkFaviconSource: faviconClient.setBookmarkFaviconSource,
  refreshBookmarkFavicon: faviconClient.refreshBookmarkFavicon,
  createMyFaviconJob: faviconClient.createMyFaviconJob,
  getMyFaviconJob: faviconClient.getMyFaviconJob,
  retryMyFaviconJob: faviconClient.retryMyFaviconJob,
  abandonFaviconIntent: faviconClient.abandonFaviconIntent,
  recordPublicCollectionInsightEvent: generatedClient.recordPublicCollectionInsightEvent,
  getMyPublishingInsights: generatedClient.getMyPublishingInsights,
  listCollectionMembers: generatedClient.listCollectionMembers,
  listSharedCollections: generatedClient.listSharedCollections,
  listMyCollaborationInvites: generatedClient.listMyCollaborationInvites,
  acceptCollaborationInvite: generatedClient.acceptCollaborationInvite,
  declineCollaborationInvite: generatedClient.declineCollaborationInvite,
  inviteCollectionMember: generatedClient.inviteCollectionMember,
  revokeCollectionInvite: generatedClient.revokeCollectionInvite,
  updateCollectionMemberRole: generatedClient.updateCollectionMemberRole,
  removeCollectionMember: generatedClient.removeCollectionMember,
  getFeedPage: generatedClient.getFeedPage,
  getNotificationPage: generatedClient.getNotificationPage,
  markNotificationRead: generatedClient.markNotificationRead,
  markNotificationsRead: generatedClient.markNotificationsRead,
  getNotificationPreference: generatedClient.getNotificationPreference,
  updateNotificationPreference: generatedClient.updateNotificationPreference,
  getPublicReportsPage: generatedClient.getPublicReportsPage,
  getPublicReportSeries: generatedClient.getPublicReportSeries,
  getPublicReportIssuesPage: generatedClient.getPublicReportIssuesPage,
  getPublicReportIssue: generatedClient.getPublicReportIssue,
  listFollowedReports: generatedClient.listFollowedReports,
  getFollowedReportIssuesPage: generatedClient.getFollowedReportIssuesPage,
  getReportFollowState: generatedClient.getReportFollowState,
  followReport: generatedClient.followReport,
  unfollowReport: generatedClient.unfollowReport,
  abandonReportFollowIntent: generatedClient.abandonReportFollowIntent,
  listMyReports: generatedClient.listMyReports,
  getCollectionCatalog: generatedClient.getCollectionCatalog,
  updateCollectionCatalog: generatedClient.updateCollectionCatalog,
  getReportCatalog: generatedClient.getReportCatalog,
  updateReportCatalog: generatedClient.updateReportCatalog,
  getMyCatalogPreferences: generatedClient.getMyCatalogPreferences,
  updateMyCatalogPreferences: generatedClient.updateMyCatalogPreferences,
  submitModerationReport: generatedClient.submitModerationReport,
  listMyModerationReports: generatedClient.listMyModerationReports,
  getMyModerationReport: generatedClient.getMyModerationReport,
  listModerationCases: generatedClient.listModerationCases,
  getModerationCase: generatedClient.getModerationCase,
  getModerationEvidence: generatedClient.getModerationEvidence,
  updateModerationCase: generatedClient.updateModerationCase,
  createModerationAction: generatedClient.createModerationAction,
  getModerationAction: generatedClient.getModerationAction,
  revokeModerationAction: generatedClient.revokeModerationAction,
  listActionsAffectingMe: generatedClient.listActionsAffectingMe,
  createModerationAppeal: generatedClient.createModerationAppeal,
  listModerationAppeals: generatedClient.listModerationAppeals,
  listMyModerationAppeals: generatedClient.listMyModerationAppeals,
  getModerationAppeal: generatedClient.getModerationAppeal,
  decideModerationAppeal: generatedClient.decideModerationAppeal,
  getReport: generatedClient.getReport,
  listReportIssues: generatedClient.listReportIssues,
  listReportMembers: generatedClient.listReportMembers,
  getReportSchedule: generatedClient.getReportSchedule,
  createReport: generatedClient.createReport,
  patchReport: generatedClient.patchReport,
  deleteReport: generatedClient.deleteReport,
  createReportIssue: generatedClient.createReportIssue,
  patchReportIssue: generatedClient.patchReportIssue,
  deleteReportIssue: generatedClient.deleteReportIssue,
  publishReportIssue: generatedClient.publishReportIssue,
  withdrawReportIssue: generatedClient.withdrawReportIssue,
  putReportSchedule: generatedClient.putReportSchedule,
  deleteReportSchedule: generatedClient.deleteReportSchedule,
  putReportMember: generatedClient.putReportMember,
  deleteReportMember: generatedClient.deleteReportMember,
  abandonReportManageIntent: generatedClient.abandonReportManageIntent,
  searchResources: searchPublicClient.searchResources,
  getSavedResourcePage: libraryClient.getSavedResourcePage,
  loadSavedResources: libraryClient.loadSavedResources,
  saveResource: libraryClient.saveResource,
  unsaveResource: libraryClient.unsaveResource,
  abandonSavedResourceIntent: libraryClient.abandonSavedResourceIntent,
  getReadingProgress: libraryClient.getReadingProgress,
  getReadingProgressPage: libraryClient.getReadingProgressPage,
  loadReadingProgress: libraryClient.loadReadingProgress,
  putReadingProgress: libraryClient.putReadingProgress,
  resetReadingProgress: libraryClient.resetReadingProgress,
  abandonReadingProgressIntent: libraryClient.abandonReadingProgressIntent,
  getSyncStatus: syncClient.getSyncStatus,
  getSyncConflictPage: syncClient.getSyncConflictPage,
  loadSyncConflicts: syncClient.loadSyncConflicts,
  resolveSyncConflict: syncClient.resolveSyncConflict,
  retireSyncReplica: syncClient.retireSyncReplica,
  getSyncTrashPage: syncClient.getSyncTrashPage,
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
  listClassificationProfiles: classificationClient.listClassificationProfiles,
  getClassificationSettings: classificationClient.getClassificationSettings,
  updateClassificationSettings: classificationClient.updateClassificationSettings,
  confirmBookmarkClassification: classificationClient.confirmBookmarkClassification,
  previewBookmarkClassification: classificationClient.previewBookmarkClassification,
  createClassificationRun: classificationClient.createClassificationRun,
  getClassificationRun: classificationClient.getClassificationRun,
  cancelClassificationRun: classificationClient.cancelClassificationRun,
  applyClassificationRun: classificationClient.applyClassificationRun,
  forgetClassificationRunIntent: classificationClient.forgetClassificationRunIntent,
  getMyClassifyInbox: libraryClient.getMyClassifyInbox,
  skipMyClassifyInboxItem: libraryClient.skipMyClassifyInboxItem,
  acceptMyClassifyInboxItem: libraryClient.acceptMyClassifyInboxItem,
  listMyExportJobs: libraryClient.listMyExportJobs,
  createMyExportJob: libraryClient.createMyExportJob,
  getMyExportJob: libraryClient.getMyExportJob,
  downloadMyExportJob: libraryClient.downloadMyExportJob,
  createCollectionOrganizePlan: libraryClient.createCollectionOrganizePlan,
  getCollectionOrganizePlan: libraryClient.getCollectionOrganizePlan,
  applyCollectionOrganizePlan: libraryClient.applyCollectionOrganizePlan,
  createCollectionVersion: libraryClient.createCollectionVersion,
  listCollectionVersions: libraryClient.listCollectionVersions,
  getCollectionVersion: libraryClient.getCollectionVersion,
  restoreCollectionVersion: libraryClient.restoreCollectionVersion,
  getNodeReadableReplica: libraryClient.getNodeReadableReplica,
  enqueueNodeReadableExtract: libraryClient.enqueueNodeReadableExtract,
  loadPublicCollectionSnapshot: searchPublicClient.loadPublicCollectionSnapshot,
  createCollectionNode: collectionsClient.createCollectionNode,
  updateCollectionNode: collectionsClient.updateCollectionNode,
  moveCollectionNode: collectionsClient.moveCollectionNode,
  deleteCollectionNode: collectionsClient.deleteCollectionNode,
  uploadBookmarkFavicon: collectionsClient.uploadBookmarkFavicon,
  deleteBookmarkFavicon: collectionsClient.deleteBookmarkFavicon,
  getAnnotationPage: collectionsClient.getAnnotationPage,
  loadAnnotations: collectionsClient.loadAnnotations,
  getAnnotation: collectionsClient.getAnnotation,
  createAnnotation: collectionsClient.createAnnotation,
  updateAnnotation: collectionsClient.updateAnnotation,
  deleteAnnotation: collectionsClient.deleteAnnotation,
  abandonAnnotationIntent: collectionsClient.abandonAnnotationIntent,
  getRelationPage: collectionsClient.getRelationPage,
  loadRelations: collectionsClient.loadRelations,
  getRelation: collectionsClient.getRelation,
  createRelation: collectionsClient.createRelation,
  updateRelation: collectionsClient.updateRelation,
  deleteRelation: collectionsClient.deleteRelation,
  abandonRelationIntent: collectionsClient.abandonRelationIntent,
  mutationIntentKey,
  newCommandId,
  subscribeSession,
})

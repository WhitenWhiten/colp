/**
 * Convenient aliases for Product API schemas.
 * Source: generated OpenAPI types (product-v1).
 */
import type { components } from '../generated/product-v1'

export type Schemas = components['schemas']

export type OpaqueId = Schemas['OpaqueId']
export type Revision = Schemas['Revision']
export type CommandId = Schemas['CommandId']
export type CsrfToken = Schemas['CsrfToken']
export type EntityTag = Schemas['EntityTag']
export type ContentEntityTag = Schemas['ContentEntityTag']
export type Cursor = Schemas['Cursor']

export type SessionView = Schemas['SessionView']
export type AuthenticatedSessionView = Schemas['AuthenticatedSessionView']
export type MeView = Schemas['MeView']
export type UpdateMeRequest = Schemas['UpdateMeRequest']

/** Account-private credit ledger schemas. Keep these aliases tied to OpenAPI. */
export type CreditOverview = Schemas['CreditOverview']
export type CreditLedgerEntry = Schemas['CreditLedgerEntry']
export type CreditLedgerEntryResponse = Schemas['CreditLedgerEntryResponse']
export type CreditLedgerPage = Schemas['CreditLedgerPage']
export type CreditUsage = Schemas['CreditUsage']
export type CreditBillingConsent = Schemas['CreditBillingConsent']

export type CollectionKind = Schemas['CollectionKind']
export type CollectionView = Schemas['CollectionView']
export type CollectionVisibility = Schemas['CollectionVisibility']
export type PublicationSlug = Schemas['PublicationSlug']
export type CollectionMergePatch = Schemas['CollectionMergePatch']
export type CreateCollectionRequest = Schemas['CreateCollectionRequest']
export type CreateCollectionResult = Schemas['CreateCollectionResult']
export type UpdateCollectionResult = Schemas['UpdateCollectionResult']
export type CollectionCapabilities = Schemas['CollectionCapabilities']
export type OwnedCollectionListItem = Schemas['OwnedCollectionListItem']
export type OwnedCollectionPageState = Schemas['OwnedCollectionPageState']
export type OwnedCollectionPage = Schemas['OwnedCollectionPage']
export type CollectionFenceState = Schemas['CollectionFenceState']

export type RootNodeView = Schemas['RootNodeView']
export type FolderNodeView = Schemas['FolderNodeView']
export type BookmarkNodeView = Schemas['BookmarkNodeView']
export type EditableNodeView = Schemas['EditableNodeView']
export type NodeView = Schemas['NodeView']
export type NodeVisibility = Schemas['NodeVisibility']

export type CreateNodeRequest = Schemas['CreateNodeRequest']
export type CreateNodeResult = Schemas['CreateNodeResult']
export type NodeMergePatch = Schemas['NodeMergePatch']
export type UpdateNodeResult = Schemas['UpdateNodeResult']
export type MoveNodeRequest = Schemas['MoveNodeRequest']
export type MoveNodeResult = Schemas['MoveNodeResult']
export type DeleteNodeResult = Schemas['DeleteNodeResult']
export type ParentState = Schemas['ParentState']

export type EditorPage = Schemas['EditorPage']
export type EditorPageState = Schemas['EditorPageState']
export type PublicCollectionPage = Schemas['PublicCollectionPage']
export type PublicCollectionNode = Schemas['PublicCollectionNode']
export type PublicCollectionPageState = Schemas['PublicCollectionPageState']
export type PublicCollectionSummary = Schemas['PublicCollectionSummary']

export type PublicProfileView = Schemas['PublicProfileView']
export type PublicProfileCollectionSummary = Schemas['PublicProfileCollectionSummary']
export type PublicProfilePageState = Schemas['PublicProfilePageState']
export type PublicProfilePage = Schemas['PublicProfilePage']
export type ProfileSummary = Schemas['ProfileSummaryDto']
export type FollowRelation = Schemas['FollowRelationDto']
export type CollectionFollowState = Schemas['CollectionFollowState']

export type CommunityTarget = Schemas['CommunityTarget']
export type CommunityTargetKind = CommunityTarget['kind']
export type CommunityVoteState = Schemas['CommunityVoteState']
export type CommunityTargetView = Schemas['CommunityTargetView']
export type CommunityVoteRequest = Schemas['CommunityVoteRequest']
export type CommunityRankingItem = Schemas['CommunityRankingItem']
export type CommunityRankingPage = Schemas['CommunityRankingPage']
export type CommunityPublicActor = Schemas['CommunityPublicActor']
export type CommunityComment = Schemas['CommunityComment']
export type CommunityCommentPage = Schemas['CommunityCommentPage']
export type CommunityCreateComment = Schemas['CommunityCreateComment']
export type FollowedCollectionItem = Schemas['FollowedCollectionItem']
export type FollowedCollectionPage = Schemas['FollowedCollectionPage']
export type LibraryOrderSection = Schemas['LibraryOrderSection']
export type LibraryOrderView = Schemas['LibraryOrderView']
export type LibraryOrderUpdateRequest = Schemas['LibraryOrderUpdateRequest']
export type LibraryOrderSectionView = Schemas['LibraryOrderSectionView']

/** FO-01 favicon policy/source DTOs (FaviconOrdering* components). */
export type FaviconIconPolicy = Schemas['FaviconOrderingIconPolicy']
export type FaviconIconPolicyPatch = Schemas['FaviconOrderingIconPolicyPatch']
export type FaviconPolicyResult = Schemas['FaviconOrderingPolicyResult']
export type BookmarkFaviconSource = Schemas['FaviconOrderingIconSource']
export type SetBookmarkFaviconSourceRequest = Schemas['FaviconOrderingSetIconSource']
export type FaviconSourceMode = BookmarkFaviconSource['sourceMode']
export type FaviconIconJobAccepted = Schemas['FaviconOrderingIconJobAccepted']
export type FaviconIconJob = Schemas['FaviconOrderingIconJob']
export type FaviconCreateIconJobRequest = Schemas['FaviconOrderingCreateIconJob']
export type FaviconJobStatus = FaviconIconJob['status']
export type CollectionChildrenItem = Schemas['FaviconOrderingBrowseNode']
export type CollectionChildrenPage = Schemas['FaviconOrderingChildrenPage']
export type CollectionChildrenSort = NonNullable<CollectionChildrenPage['sort']>
export type CollectionChildrenItemKind = CollectionChildrenItem['kind']
export type FollowPage = Schemas['FollowPageDto']
export type FeedProfileSummary = Schemas['FeedProfileSummaryDto']
export type FeedItem = Schemas['FeedItemDto']
export type FeedPage = Schemas['FeedPageDto']
export type NotificationItem = Schemas['NotificationItem']
export type NotificationInboxPage = Schemas['NotificationInboxPage']
export type NotificationReadResult = Schemas['NotificationReadResult']
export type NotificationBulkReadResult = Schemas['NotificationBulkReadResult']
export type NotificationPreference = Schemas['NotificationPreference']
export type NotificationPreferenceEmailStatus = Schemas['NotificationPreferenceEmailStatus']
export type NotificationPreferenceUpdate = Schemas['NotificationPreferenceUpdate']
export type NotificationPreferenceUpdateResult = Schemas['NotificationPreferenceUpdateResult']

export type AnnotationSubject = Schemas['AnnotationSubject']
export type AnnotationType = Schemas['AnnotationType']
export type AnnotationFormat = Schemas['AnnotationFormat']
export type AnnotationVisibility = Schemas['AnnotationVisibility']
export type AnnotationView = Schemas['AnnotationView']
export type AnnotationPage = Schemas['AnnotationPage']
export type AnnotationPageState = Schemas['AnnotationPageState']
export type CreateAnnotationRequest = Schemas['CreateAnnotationRequest']
export type AnnotationMergePatch = Schemas['AnnotationMergePatch']
export type DeleteAnnotationResult = Schemas['DeleteAnnotationResult']

export type RelationDirection = Schemas['RelationDirection']
export type RelationType = Schemas['RelationType']
export type RelationVisibility = Schemas['RelationVisibility']
export type RelationView = Schemas['RelationView']
export type RelationPage = Schemas['RelationPage']
export type RelationPageState = Schemas['RelationPageState']
export type CreateRelationRequest = Schemas['CreateRelationRequest']
export type RelationMergePatch = Schemas['RelationMergePatch']
export type DeleteRelationResult = Schemas['DeleteRelationResult']

export type SavedResourceType = Schemas['SavedResourceType']
export type SavedResourceView = Schemas['SavedResourceView']
export type SavedResourcePage = Schemas['SavedResourcePage']
export type SavedResourcePageState = Schemas['SavedResourcePageState']
export type SaveResourceResult = Schemas['SaveResourceResult']

export type ReadingProgressResourceType = Schemas['ReadingProgressResourceType']
export type ReadingProgressStatus = Schemas['ReadingProgressStatus']
export type ReadingProgressView = Schemas['ReadingProgressView']
export type ReadingProgressPage = Schemas['ReadingProgressPage']
export type ReadingProgressPageState = Schemas['ReadingProgressPageState']
export type ReadingProgressUpdate = Schemas['ReadingProgressUpdate']
export type ReadingProgressMutationResult = Schemas['ReadingProgressMutationResult']

export type WriteApprovalStatus = Schemas['WriteApprovalStatus']
export type WriteApprovalDecision = Schemas['WriteApprovalDecision']
export type WriteApprovalDecisionState = Schemas['WriteApprovalDecisionState']
export type WriteApprovalImpact = Schemas['WriteApprovalImpact']
export type WriteApprovalNodeSummary = Schemas['WriteApprovalNodeSummary']
export type WriteApprovalOperationPreview = Schemas['WriteApprovalOperationPreview']
export type WriteApprovalTarget = Schemas['WriteApprovalTarget']
export type WriteApprovalView = Schemas['WriteApprovalView']
export type WriteApprovalPage = Schemas['WriteApprovalPage']
export type WriteApprovalDecisionRequest = Schemas['WriteApprovalDecisionRequest']
export type WriteApprovalDecisionResult = Schemas['WriteApprovalDecisionResult']

export type LinkHealthStatus = Schemas['LinkHealthStatus']
export type LinkHealthItem = Schemas['LinkHealthItem']
export type LinkHealthPage = Schemas['LinkHealthPage']
export type LinkHealthChecksRequest = Schemas['LinkHealthChecksRequest']
export type LinkHealthChecksReceipt = Schemas['LinkHealthChecksReceipt']

export type ClassifyInboxSuggestionKind = Schemas['ClassifyInboxSuggestionKind']
export type ClassifyInboxSuggestion = Schemas['ClassifyInboxSuggestion']
export type ClassifyInboxItem = Schemas['ClassifyInboxItem']
export type ClassifyInboxPage = Schemas['ClassifyInboxPage']
export type ClassifyInboxSkipRequest = Schemas['ClassifyInboxSkipRequest']
export type ClassifyInboxAcceptRequest = Schemas['ClassifyInboxAcceptRequest']
export type ClassifyInboxDecisionReceipt = Schemas['ClassifyInboxDecisionReceipt']
export type ClassifyInboxAcceptReceipt = Schemas['ClassifyInboxAcceptReceipt']

export type ExportJobStatus = Schemas['ExportJobStatus']
export type ExportJob = Schemas['ExportJob']
export type ExportJobPage = Schemas['ExportJobPage']
export type ExportLibraryDocument = Schemas['ExportLibraryDocument']

export type OrganizePlanCreateRequest = Schemas['OrganizePlanCreateRequest']
export type OrganizePlan = Schemas['OrganizePlan']
export type OrganizePlanAction = Schemas['OrganizePlanAction']
export type OrganizePlanApplyRequest = Schemas['OrganizePlanApplyRequest']
export type OrganizePlanApplyReceipt = Schemas['OrganizePlanApplyReceipt']

export type CollectionVersionCreateRequest = Schemas['CollectionVersionCreateRequest']
export type CollectionVersion = Schemas['CollectionVersion']
export type CollectionVersionPage = Schemas['CollectionVersionPage']
export type CollectionVersionRestoreRequest = Schemas['CollectionVersionRestoreRequest']
export type CollectionVersionRestoreReceipt = Schemas['CollectionVersionRestoreReceipt']

export type ReportSeries = Schemas['ReportSeries']
export type ReportSeriesPage = Schemas['ReportSeriesPage']
export type ReportSeriesCreate = Schemas['ReportSeriesCreate']
export type ReportSeriesPatch = Schemas['ReportSeriesPatch']
export type ReportEdition = Schemas['ReportEdition']
export type ReportEditionPage = Schemas['ReportEditionPage']
export type ReportEditionAttach = Schemas['ReportEditionAttach']
export type ReportEditionPatch = Schemas['ReportEditionPatch']
export type ReportMember = Schemas['ReportMember']
export type ReportMemberPage = Schemas['ReportMemberPage']
export type ReportMemberMutation = Schemas['ReportMemberMutation']
export type ReportSchedule = Schemas['ReportSchedule']
export type ReportScheduleInput = Schemas['ReportScheduleInput']
export type ReportScheduleEnvelope = Schemas['ReportScheduleEnvelope']
export type ReportFollowState = Schemas['ReportFollowState']
export type ReportIssueTimelineItem = Schemas['ReportIssueTimelineItem']
export type ReportIssueTimelinePage = Schemas['ReportIssueTimelinePage']
export type PublicReportSeries = Schemas['PublicReportSeries']
export type PublicReportIssue = Schemas['PublicReportIssue']
export type PublicReportPage = Schemas['PublicReportPage']
export type PublicReportIssuePage = Schemas['PublicReportIssuePage']

export type ReadableReplicaExtractRequest = Schemas['ReadableReplicaExtractRequest']
export type ReadableReplicaParagraph = Schemas['ReadableReplicaParagraph']
export type ReadableReplicaSection = Schemas['ReadableReplicaSection']
export type ReadableReplicaView = Schemas['ReadableReplicaView']
export type BookmarkPreviewImage = Schemas['BookmarkPreviewImage']
export type BookmarkPreviewModeView = Schemas['BookmarkPreviewModeView']
export type LinkPreviewRequestAccepted = Schemas['LinkPreviewRequestAccepted']

export type SearchResourceType = Schemas['SearchResourceType']
export type SearchResult = Schemas['SearchResult']
export type SearchPage = Schemas['SearchPage']

export interface ExploreCreator {
  id: string
  name: string
  handle: string | null
  avatar: string | null
}

export interface ExploreCollection {
  id: string
  title: string
  summary: string | null
  kind: string
  tags: string[]
  language?: string | null
  nodeCount: number
  updatedAt: string
  /**
   * Public slug of the collection. Null on a moderation tombstone (#21):
   * the row keeps its Explore slot but has no page to open.
   */
  publicationSlug: string | null
  visibility: string
  creators: ExploreCreator[]
  viewCount?: number
  /** Latest public collection tldr (curator recommendation), when present. */
  curatorNote?: string | null
  /** True when an official hide_public action is in force and the row is an inert tombstone (#21). */
  hiddenPublic?: boolean
}

export interface ExploreParams {
  q?: string
  tag?: string
  sort?: 'updated' | 'popular' | 'links'
  language?: string
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export interface ExplorePage {
  items: ExploreCollection[]
  nextCursor: string | null
}
export type SearchPageState = Schemas['SearchPageState']

export type SyncReplicaStatus = Schemas['SyncReplicaStatus']
export type SyncDeviceView = Schemas['SyncDeviceView']
export type SyncReplicaView = Schemas['SyncReplicaView']
export type SyncStatusView = Schemas['SyncStatusView']
export type SyncConflictSafeSummary = Schemas['SyncConflictSafeSummary']
export type SyncConflictSummary = Schemas['SyncConflictSummary']
export type SyncConflictPage = Schemas['SyncConflictPage']
export type ProductSyncConflictResolution = Schemas['ProductSyncConflictResolution']
export type ProductSyncConflictResolutionView = Schemas['ProductSyncConflictResolutionView']
export type ProductSyncReplicaRetirementView = Schemas['ProductSyncReplicaRetirementView']
export type SyncTrashDeletionId = Schemas['SyncTrashDeletionId']
export type SyncTrashListItem = Schemas['SyncTrashListItem']
export type SyncTrashPage = Schemas['SyncTrashPage']
export type SyncTrashDetail = Schemas['SyncTrashDetail']
export type SyncTrashRestoreView = Schemas['SyncTrashRestoreView']
export type SyncTrashRestoreBatchItem = Schemas['SyncTrashRestoreBatchItem']
export type SyncTrashRestoreBatchRequest = Schemas['SyncTrashRestoreBatchRequest']
export type SyncTrashRestoreItemResult = Schemas['SyncTrashRestoreItemResult']
export type SyncTrashRestoreBatchSummary = Schemas['SyncTrashRestoreBatchSummary']
export type SyncTrashRestoreBatchView = Schemas['SyncTrashRestoreBatchView']
export type SyncTrashEmptyRequest = Schemas['SyncTrashEmptyRequest']
export type SyncTrashEmptySkipReason = Schemas['SyncTrashEmptySkipReason']
export type SyncTrashEmptyItemResult = Schemas['SyncTrashEmptyItemResult']
export type SyncTrashEmptySummary = Schemas['SyncTrashEmptySummary']
export type SyncTrashEmptyView = Schemas['SyncTrashEmptyView']

/**
 * Wire codes frozen out of the OpenAPI ProductErrorCode enum by ADR-0015.
 * Keep in sync with DriftedProductErrorCode in Known-Backend
 * src/transport/product-codes.ts. The generated enum is not exhaustive.
 */
type DriftedProductErrorCode =
  | 'handle_taken'
  | 'invalid_handle'
  | 'invalid_display_name'
  | 'invalid_about'
  | 'mutation_conflict'
  | 'not_acceptable'
  | 'invalid_credentials'
  | 'verification_required'
  | 'account_link_required'
  | 'email_delivery_unavailable'

/** Generated OpenAPI enum ∪ drifted wire codes (ADR-0015). */
export type ProductErrorCode = Schemas['ProductErrorCode'] | DriftedProductErrorCode
export type ProductError = Schemas['ProductError']
export type ProductErrorEnvelope = Schemas['ProductErrorEnvelope']
export type RecoveryAction = Schemas['RecoveryAction']
export type FieldError = Schemas['FieldError']

/** Assembled editor snapshot after all pages are loaded (hasMore=false). */
export type EditorSnapshot = {
  collection: CollectionView
  root: RootNodeView
  nodes: EditableNodeView[]
  capabilities: CollectionCapabilities
  page: EditorPageState
}

/** Complete public/member projection, exposed only after pagination finishes. */
export type PublicCollectionRelation = Schemas['PublicCollectionRelation']

export type PublicCollectionSnapshot = {
  relations?: PublicCollectionRelation[]
  collection: PublicCollectionSummary
  nodes: PublicCollectionNode[]
  page: PublicCollectionPageState
}

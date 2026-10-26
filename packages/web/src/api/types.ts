/**
 * Convenient aliases for Product API schemas.
 * Source: generated OpenAPI types (product-v1).
 */
import type { components } from '../generated/product-v1'

export type Schemas = components['schemas']

export type CsrfToken = Schemas['CsrfToken']

export type SessionView = Schemas['SessionView']
export type AuthenticatedSessionView = Schemas['AuthenticatedSessionView']
export type MeView = Schemas['MeView']
export type UpdateMeRequest = Schemas['UpdateMeRequest']

export type FolderShareView = Schemas['FolderShareView']
export type FolderShareState = Schemas['FolderShareState']
export type LibraryCollection = Schemas['LibraryCollection']
export type CollectionKind = Schemas['CollectionKind']
export type CollectionView = Schemas['CollectionView']
export type CollectionVisibility = Schemas['CollectionVisibility']
export type CollectionMergePatch = Schemas['CollectionMergePatch']
export type CreateCollectionRequest = Schemas['CreateCollectionRequest']
export type CreateCollectionResult = Schemas['CreateCollectionResult']
export type UpdateCollectionResult = Schemas['UpdateCollectionResult']
export type CollectionCapabilities = Schemas['CollectionCapabilities']
export type OwnedCollectionListItem = Schemas['OwnedCollectionListItem']
export type OwnedCollectionPageState = Schemas['OwnedCollectionPageState']
export type OwnedCollectionPage = Schemas['OwnedCollectionPage']

export type RootNodeView = Schemas['RootNodeView']
export type FolderNodeView = Schemas['FolderNodeView']
export type EditableNodeView = Schemas['EditableNodeView']

export type CreateNodeRequest = Schemas['CreateNodeRequest']
export type CreateNodeResult = Schemas['CreateNodeResult']
export type NodeMergePatch = Schemas['NodeMergePatch']
export type UpdateNodeResult = Schemas['UpdateNodeResult']
export type MoveNodeRequest = Schemas['MoveNodeRequest']
export type MoveNodeResult = Schemas['MoveNodeResult']
export type DeleteNodeResult = Schemas['DeleteNodeResult']

export type EditorPage = Schemas['EditorPage'] & { readRevision?: string }
export type EditorPageState = Schemas['EditorPageState']
export type PublicCollectionPage = Schemas['PublicCollectionPage']
export type PublicCollectionNode = Schemas['PublicCollectionNode']
export type PublicCollectionPageState = Schemas['PublicCollectionPageState']
export type PublicCollectionSummary = Schemas['PublicCollectionSummary']

export type AnnotationSubject = Schemas['AnnotationSubject']
export type AnnotationType = Schemas['AnnotationType']
export type AnnotationFormat = Schemas['AnnotationFormat']
export type AnnotationVisibility = Schemas['AnnotationVisibility']
export type AnnotationView = Schemas['AnnotationView']
export type AnnotationPage = Schemas['AnnotationPage']
export type CreateAnnotationRequest = Schemas['CreateAnnotationRequest']
export type AnnotationMergePatch = Schemas['AnnotationMergePatch']
export type DeleteAnnotationResult = Schemas['DeleteAnnotationResult']

export type RelationDirection = Schemas['RelationDirection']
export type RelationType = Schemas['RelationType']
export type RelationVisibility = Schemas['RelationVisibility']
export type RelationView = Schemas['RelationView']
export type RelationPage = Schemas['RelationPage']
export type CreateRelationRequest = Schemas['CreateRelationRequest']
export type RelationMergePatch = Schemas['RelationMergePatch']
export type DeleteRelationResult = Schemas['DeleteRelationResult']

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

export type CollectionVersionCreateRequest = Schemas['CollectionVersionCreateRequest']
export type CollectionVersion = Schemas['CollectionVersion']
export type CollectionVersionPage = Schemas['CollectionVersionPage']
export type CollectionVersionRestoreRequest = Schemas['CollectionVersionRestoreRequest']
export type CollectionVersionRestoreReceipt = Schemas['CollectionVersionRestoreReceipt']

/** This server has no profile pages, so the UI searches only what it can open. */
export type SearchResourceType = Exclude<Schemas['SearchResourceType'], 'profile'>
export type SearchResult = Exclude<Schemas['SearchResult'], { resourceType: 'profile' }>
export type SearchPage = Schemas['SearchPage']

export type SearchPageState = Schemas['SearchPageState']

export type SyncReplicaStatus = Schemas['SyncReplicaStatus']
export type SyncDeviceView = Schemas['SyncDeviceView']
export type SyncReplicaView = Schemas['SyncReplicaView']
export type SyncReplicaHealthView = Schemas['SyncReplicaHealthView']
export type SyncReplicaIssue = Schemas['SyncReplicaIssue']
export type SyncReplicaIssuesView = Schemas['SyncReplicaIssuesView']
export type SyncReplicaCommandRequest = Schemas['SyncReplicaCommandRequest']
export type SyncReplicaCommandView = Schemas['SyncReplicaCommandView']
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

/** Assembled editor snapshot after all pages are loaded (hasMore=false). */
export type EditorSnapshot = {
  /** Whole read-model version from Known-Editor-Revision; absent on older servers. */
  readRevision?: string
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

export type FaviconIconPolicy = Schemas['FaviconOrderingIconPolicy']
export type FaviconIconPolicyPatch = Schemas['FaviconOrderingIconPolicyPatch']
export type FaviconPolicyResult = Schemas['FaviconOrderingPolicyResult']
export type BookmarkFaviconSource = Schemas['FaviconOrderingIconSource']
export type SetBookmarkFaviconSourceRequest = Schemas['FaviconOrderingSetIconSource']
export type FaviconIconJobAccepted = Schemas['FaviconOrderingIconJobAccepted']
export type FaviconIconJob = Schemas['FaviconOrderingIconJob']
export type FaviconJobActivity = Schemas['FaviconOrderingJobActivity']
export type FaviconCreateIconJobRequest = Schemas['FaviconOrderingCreateIconJob']
export type FaviconJobStatus = FaviconIconJob['status']
export type LinkPreviewRequestAccepted = Schemas['LinkPreviewRequestAccepted']

export type BookmarkNodeView = Schemas['BookmarkNodeView']

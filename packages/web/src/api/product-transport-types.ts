/**
 * Shared Product transport types. Domain transport modules and the barrel
 * import from here so they never import `./product-transport`.
 */
import type { components } from '../generated/product-v1'
import type {
  AnnotationMergePatch,
  AnnotationPage,
  AnnotationView,
  BookmarkFaviconSource,
  BookmarkNodeView,
  CollectionMergePatch,
  CollectionKind,
  CollectionVisibility,
  CreateCollectionRequest,
  CreateCollectionResult,
  CreateAnnotationRequest,
  CreateNodeRequest,
  CreateNodeResult,
  FaviconCreateIconJobRequest,
  FaviconIconJob,
  FaviconIconJobAccepted,
  FaviconIconPolicy,
  FaviconIconPolicyPatch,
  FaviconPolicyResult,
  DeleteNodeResult,
  DeleteAnnotationResult,
  CreateRelationRequest,
  DeleteRelationResult,
  EditorPage,
  MeView,
  UpdateMeRequest,
  MoveNodeRequest,
  MoveNodeResult,
  OwnedCollectionPage,
  NodeMergePatch,
  PublicCollectionPage,
  PublicProfilePage,
  RelationDirection,
  RelationMergePatch,
  RelationPage,
  RelationType,
  RelationView,
  ReadingProgressMutationResult,
  ReadingProgressPage,
  ReadingProgressResourceType,
  ReadingProgressStatus,
  ReadingProgressUpdate,
  ReadingProgressView,
  SavedResourcePage,
  SavedResourceType,
  SetBookmarkFaviconSourceRequest,
  SaveResourceResult,
  SearchPage,
  SearchResourceType,
  SessionView,
  SyncConflictPage,
  SyncStatusView,
  WriteApprovalDecision,
  WriteApprovalDecisionResult,
  WriteApprovalPage,
  WriteApprovalView,
  LinkHealthChecksReceipt,
  LinkHealthChecksRequest,
  LinkHealthPage,
  LinkHealthStatus,
  ClassifyInboxAcceptReceipt,
  ClassifyInboxAcceptRequest,
  ClassifyInboxDecisionReceipt,
  ClassifyInboxPage,
  ClassifyInboxSkipRequest,
  ExportJob,
  ExportJobPage,
  ExportLibraryDocument,
  OrganizePlan,
  OrganizePlanApplyReceipt,
  OrganizePlanApplyRequest,
  OrganizePlanCreateRequest,
  CollectionVersion,
  CollectionVersionCreateRequest,
  CollectionVersionPage,
  CollectionVersionRestoreReceipt,
  CollectionVersionRestoreRequest,
  ReadableReplicaExtractRequest,
  ReadableReplicaView,
  ProductSyncConflictResolution,
  ProductSyncConflictResolutionView,
  ProductSyncReplicaRetirementView,
  SyncTrashDetail,
  SyncTrashEmptyRequest,
  SyncTrashEmptyView,
  SyncTrashPage,
  SyncTrashRestoreBatchRequest,
  SyncTrashRestoreBatchView,
  SyncTrashRestoreView,
  UpdateCollectionResult,
  UpdateNodeResult,
  ExploreParams,
  ExplorePage,
  CollectionChildrenPage,
  CreditLedgerEntryResponse,
  CreditLedgerPage,
  CreditOverview,
} from './types'

type PublicProfileActivityPage = components['schemas']['PublicProfileActivityPage']

export type ProductTransportOptions = {
  /**
   * API origin without trailing slash, e.g. `https://api.example.com`.
   * Empty / omitted → relative URLs (same-origin Vite proxy or co-hosted static).
   */
  baseUrl?: string
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch
}

export type MutationCallOptions = {
  /** Stable intent key → Known-Command-Id via allocateCommandId. */
  commandIntentId: string
  csrfToken: string
  ifMatch?: string
  ifContentMatch?: string
  signal?: AbortSignal
}

export type DeleteNodeOptions = MutationCallOptions & {
  recursive?: boolean
}

export type EditorPageParams = {
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type PublicCollectionPageParams = {
  includeRelations?: boolean
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type OwnedCollectionPageParams = {
  kind?: CollectionKind
  visibility?: CollectionVisibility
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type CollectionChildrenSort = 'curated' | 'created_asc' | 'created_desc'

export type CollectionChildrenPageParams = {
  parentId?: string
  sort?: CollectionChildrenSort
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type PublicProfilePageParams = {
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type AnnotationSubjectParams = {
  resourceType: 'collection' | 'node'
  resourceId: string
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type RelationListParams = {
  nodeId: string
  direction: RelationDirection
  type?: RelationType
  visibility?: 'private' | 'protected' | 'unlisted' | 'public'
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type SessionCallOptions = {
  csrfToken?: string
  signal?: AbortSignal
}

/**
 * Cloud credit-ledger query. GET /api/v1/me/credits/ledger is not in the
 * trimmed edition document, so this is not indexed from `operations`.
 */
export type CreditLedgerListParams = {
  limit?: number
  cursor?: string
  kind?: 'grant' | 'reserve' | 'spend' | 'release' | 'expire' | 'refund' | 'topup' | 'payment_refund'
  from?: string
  to?: string
  chargeId?: string
  runId?: string
  signal?: AbortSignal
}

export type SavedResourceListParams = {
  resourceType?: SavedResourceType
  collectionId?: string
  createdAfter?: string
  createdBefore?: string
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type ReadingProgressListParams = {
  status?: ReadingProgressStatus
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type SyncConflictListParams = {
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type SyncTrashListParams = {
  collectionId: string
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type WriteApprovalListParams = {
  limit?: number
  signal?: AbortSignal
}

export type LinkHealthListParams = {
  status?: LinkHealthStatus
  collectionId?: string
  duplicate?: boolean
  limit?: number
  cursor?: string
  scope?: 'owned' | 'shared' | 'all'
  signal?: AbortSignal
}

export type ClassifyInboxListParams = {
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type SearchParams = {
  q: string
  types?: SearchResourceType[]
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type Etagged<T> = T & { etag: string }

export type ProductTransport = {
  requestCollectionLinkPreviews: (collectionId: string, nodeIds: readonly string[], opts: MutationCallOptions) =>
    Promise<import('./types').LinkPreviewRequestAccepted>
  getBookmarkPreviewMode: (collectionId: string, nodeId: string, signal?: AbortSignal) =>
    Promise<import('./types').BookmarkPreviewModeView>
  setBookmarkPreviewMode: (
    collectionId: string,
    nodeId: string,
    mode: import('./types').BookmarkPreviewModeView['mode'],
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<import('./types').BookmarkPreviewModeView>
  getMyFaviconPolicy: (signal?: AbortSignal) => Promise<FaviconIconPolicy & { etag: string }>
  updateMyFaviconPolicy: (
    patch: FaviconIconPolicyPatch,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<FaviconPolicyResult>
  getBookmarkFaviconSource: (collectionId: string, nodeId: string, signal?: AbortSignal) =>
    Promise<BookmarkFaviconSource & { etag: string }>
  setBookmarkFaviconSource: (
    collectionId: string,
    nodeId: string,
    body: SetBookmarkFaviconSourceRequest,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<BookmarkFaviconSource>
  refreshBookmarkFavicon: (
    collectionId: string,
    nodeId: string,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<FaviconIconJobAccepted>
  createMyFaviconJob: (
    body: FaviconCreateIconJobRequest,
    opts: MutationCallOptions,
  ) => Promise<FaviconIconJobAccepted>
  getMyFaviconJob: (jobId: string, signal?: AbortSignal) => Promise<FaviconIconJob>
  retryMyFaviconJob: (jobId: string, opts: MutationCallOptions) => Promise<FaviconIconJobAccepted>
  getSession: (opts?: SessionCallOptions) => Promise<SessionView>
  getMyCredits: (signal?: AbortSignal) => Promise<CreditOverview>
  listMyCreditLedger: (params?: CreditLedgerListParams) => Promise<CreditLedgerPage>
  getMyCreditLedgerEntry: (entryId: string, signal?: AbortSignal) => Promise<CreditLedgerEntryResponse>
  getMe: (opts?: SessionCallOptions) => Promise<MeView>
  updateMe: (body: UpdateMeRequest, opts: MutationCallOptions) => Promise<MeView>
  uploadAvatar: (file: File, opts: MutationCallOptions) => Promise<MeView>
  deleteSession: (opts: { csrfToken: string; signal?: AbortSignal }) => Promise<void>
  listSavedResources: (params?: SavedResourceListParams) => Promise<SavedResourcePage>
  saveResource: (resourceType: SavedResourceType, resourceId: string, opts: MutationCallOptions) => Promise<SaveResourceResult>
  unsaveResource: (resourceType: SavedResourceType, resourceId: string, opts: MutationCallOptions) => Promise<void>
  listReadingProgress: (params?: ReadingProgressListParams) => Promise<ReadingProgressPage>
  getReadingProgress: (resourceType: ReadingProgressResourceType, resourceId: string, signal?: AbortSignal) => Promise<ReadingProgressView | null>
  putReadingProgress: (resourceType: ReadingProgressResourceType, resourceId: string, body: ReadingProgressUpdate, opts: MutationCallOptions) => Promise<Etagged<ReadingProgressMutationResult>>
  resetReadingProgress: (resourceType: ReadingProgressResourceType, resourceId: string, opts: MutationCallOptions) => Promise<void>
  searchResources: (params: SearchParams) => Promise<SearchPage>
  listExploreCollections: (params?: ExploreParams) => Promise<ExplorePage>
  getSyncStatus: (signal?: AbortSignal) => Promise<SyncStatusView>
  listSyncConflicts: (params?: SyncConflictListParams) => Promise<SyncConflictPage>
  resolveSyncConflict: (conflictId: string, body: ProductSyncConflictResolution, opts: MutationCallOptions) => Promise<ProductSyncConflictResolutionView>
  retireSyncReplica: (replicaId: string, opts: MutationCallOptions) => Promise<ProductSyncReplicaRetirementView>
  listSyncTrash: (params: SyncTrashListParams) => Promise<SyncTrashPage>
  getSyncTrashItem: (deletionId: string, signal?: AbortSignal) => Promise<SyncTrashDetail>
  restoreSyncTrashItem: (deletionId: string, opts: MutationCallOptions) => Promise<SyncTrashRestoreView>
  restoreSyncTrashBatch: (body: SyncTrashRestoreBatchRequest, opts: MutationCallOptions) => Promise<SyncTrashRestoreBatchView>
  restoreSyncTrashSubtree: (deletionId: string, opts: MutationCallOptions) => Promise<SyncTrashRestoreBatchView>
  emptySyncTrash: (body: SyncTrashEmptyRequest, opts: MutationCallOptions) => Promise<SyncTrashEmptyView>
  listWriteApprovals: (params?: WriteApprovalListParams) => Promise<WriteApprovalPage>
  getWriteApproval: (planId: string, signal?: AbortSignal) => Promise<WriteApprovalView>
  decideWriteApproval: (
    planId: string,
    decision: WriteApprovalDecision,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<WriteApprovalDecisionResult>
  getMyLinkHealth: (params?: LinkHealthListParams) => Promise<LinkHealthPage>
  enqueueMyLinkHealthChecks: (
    body: LinkHealthChecksRequest,
    opts: MutationCallOptions,
  ) => Promise<LinkHealthChecksReceipt>
  getMyClassifyInbox: (params?: ClassifyInboxListParams) => Promise<ClassifyInboxPage>
  skipMyClassifyInboxItem: (
    nodeId: string,
    body: ClassifyInboxSkipRequest,
    opts: MutationCallOptions,
  ) => Promise<ClassifyInboxDecisionReceipt>
  acceptMyClassifyInboxItem: (
    nodeId: string,
    body: ClassifyInboxAcceptRequest,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<ClassifyInboxAcceptReceipt>
  listMyExportJobs: (opts?: { signal?: AbortSignal }) => Promise<ExportJobPage>
  createMyExportJob: (opts: MutationCallOptions) => Promise<ExportJob>
  getMyExportJob: (jobId: string, opts?: { signal?: AbortSignal }) => Promise<ExportJob>
  downloadMyExportJob: (
    jobId: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<ExportLibraryDocument>
  createCollectionOrganizePlan: (
    collectionId: string,
    body: OrganizePlanCreateRequest,
    opts: MutationCallOptions,
  ) => Promise<OrganizePlan>
  getCollectionOrganizePlan: (
    collectionId: string,
    planId: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<OrganizePlan>
  applyCollectionOrganizePlan: (
    collectionId: string,
    planId: string,
    body: OrganizePlanApplyRequest,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<OrganizePlanApplyReceipt>
  createCollectionVersion: (
    collectionId: string,
    body: CollectionVersionCreateRequest,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<CollectionVersion>
  listCollectionVersions: (
    collectionId: string,
    params?: { limit?: number; cursor?: string; signal?: AbortSignal },
  ) => Promise<CollectionVersionPage>
  getCollectionVersion: (
    collectionId: string,
    versionId: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<CollectionVersion>
  restoreCollectionVersion: (
    collectionId: string,
    versionId: string,
    body: CollectionVersionRestoreRequest,
    opts: MutationCallOptions & { ifMatch: string },
  ) => Promise<CollectionVersionRestoreReceipt>
  getNodeReadableReplica: (
    collectionId: string,
    nodeId: string,
    signal?: AbortSignal,
  ) => Promise<ReadableReplicaView>
  enqueueNodeReadableExtract: (
    collectionId: string,
    nodeId: string,
    body: ReadableReplicaExtractRequest,
    opts: MutationCallOptions,
  ) => Promise<ReadableReplicaView>
  listOwnedCollections: (params?: OwnedCollectionPageParams) => Promise<OwnedCollectionPage>
  listCollectionChildren: (
    collectionId: string,
    params?: CollectionChildrenPageParams,
  ) => Promise<CollectionChildrenPage>
  createCollection: (
    body: CreateCollectionRequest,
    opts: MutationCallOptions,
  ) => Promise<CreateCollectionResult>
  getEditorPage: (collectionId: string, params?: EditorPageParams) => Promise<EditorPage>
  getPublicCollectionPage: (
    slug: string,
    params?: PublicCollectionPageParams,
  ) => Promise<PublicCollectionPage>
  getPublicProfilePage: (
    handle: string,
    params?: PublicProfilePageParams,
  ) => Promise<PublicProfilePage>
  getPublicProfileActivity: (
    handle: string,
    params?: PublicProfilePageParams,
  ) => Promise<PublicProfileActivityPage>
  listAnnotations: (collectionId: string, params: AnnotationSubjectParams) => Promise<AnnotationPage>
  getAnnotation: (collectionId: string, annotationId: string, signal?: AbortSignal) => Promise<AnnotationView>
  createAnnotation: (
    collectionId: string,
    subject: Pick<AnnotationSubjectParams, 'resourceType' | 'resourceId'>,
    body: CreateAnnotationRequest,
    opts: MutationCallOptions,
  ) => Promise<AnnotationView>
  updateAnnotation: (
    collectionId: string,
    annotationId: string,
    body: AnnotationMergePatch,
    opts: MutationCallOptions,
  ) => Promise<AnnotationView>
  deleteAnnotation: (
    collectionId: string,
    annotationId: string,
    opts: MutationCallOptions,
  ) => Promise<DeleteAnnotationResult>
  listRelations: (collectionId: string, params: RelationListParams) => Promise<RelationPage>
  getRelation: (collectionId: string, relationId: string, signal?: AbortSignal) => Promise<RelationView>
  createRelation: (collectionId: string, body: CreateRelationRequest, opts: MutationCallOptions) => Promise<RelationView>
  updateRelation: (collectionId: string, relationId: string, body: RelationMergePatch, opts: MutationCallOptions) => Promise<RelationView>
  deleteRelation: (collectionId: string, relationId: string, opts: MutationCallOptions) => Promise<DeleteRelationResult>
  updateCollection: (
    collectionId: string,
    body: CollectionMergePatch,
    opts: MutationCallOptions,
  ) => Promise<UpdateCollectionResult>
  createNode: (
    collectionId: string,
    body: CreateNodeRequest | Record<string, unknown>,
    opts: MutationCallOptions,
  ) => Promise<CreateNodeResult>
  updateNode: (
    collectionId: string,
    nodeId: string,
    body: NodeMergePatch,
    opts: MutationCallOptions,
  ) => Promise<UpdateNodeResult>
  moveNode: (
    collectionId: string,
    nodeId: string,
    body: MoveNodeRequest | Record<string, unknown>,
    opts: MutationCallOptions,
  ) => Promise<MoveNodeResult>
  deleteNode: (
    collectionId: string,
    nodeId: string,
    opts: DeleteNodeOptions,
  ) => Promise<DeleteNodeResult | void>
  uploadBookmarkFavicon: (
    collectionId: string,
    nodeId: string,
    file: File,
    opts: MutationCallOptions,
  ) => Promise<BookmarkNodeView>
  deleteBookmarkFavicon: (
    collectionId: string,
    nodeId: string,
    opts: MutationCallOptions,
  ) => Promise<BookmarkNodeView>
}

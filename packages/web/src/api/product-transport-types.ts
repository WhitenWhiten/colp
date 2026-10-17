import type { BookmarkNodeView, LinkPreviewRequestAccepted } from './types'
import type { BookmarkFaviconSource, FaviconCreateIconJobRequest, FaviconIconJob, FaviconIconJobAccepted, FaviconIconPolicy, FaviconIconPolicyPatch, FaviconPolicyResult, SetBookmarkFaviconSourceRequest, FaviconJobStatus, FaviconJobActivity } from './types'
/**
 * Shared Product transport types. Domain transport modules and the barrel
 * import from here so they never import `./product-transport`.
 */
import type {
  AnnotationMergePatch,
  AnnotationPage,
  AnnotationView,
  CollectionMergePatch,
  CollectionKind,
  CollectionVisibility,
  CreateCollectionRequest,
  CreateCollectionResult,
  CreateAnnotationRequest,
  CreateNodeRequest,
  CreateNodeResult,
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
  RelationDirection,
  RelationMergePatch,
  RelationPage,
  RelationType,
  RelationView,
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
  CollectionVersion,
  CollectionVersionCreateRequest,
  CollectionVersionPage,
  CollectionVersionRestoreReceipt,
  CollectionVersionRestoreRequest,
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
} from './types'

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

export type SearchParams = {
  q: string
  types?: SearchResourceType[]
  limit?: number
  cursor?: string
  signal?: AbortSignal
}

export type ProductTransport = {
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
  getMyFaviconJobActivity: (signal?: AbortSignal) => Promise<FaviconJobActivity>
  retryMyFaviconJob: (jobId: string, opts: MutationCallOptions) => Promise<FaviconIconJobAccepted>
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
  requestCollectionLinkPreviews: (collectionId: string, nodeIds: readonly string[], opts: MutationCallOptions) =>
    Promise<LinkPreviewRequestAccepted>
  getSession: (opts?: SessionCallOptions) => Promise<SessionView>
  getMe: (opts?: SessionCallOptions) => Promise<MeView>
  updateMe: (body: UpdateMeRequest, opts: MutationCallOptions) => Promise<MeView>
  deleteSession: (opts: { csrfToken: string; signal?: AbortSignal }) => Promise<void>
  searchResources: (params: SearchParams) => Promise<SearchPage>
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
  getFolderShare: (collectionId: string, nodeId: string, signal?: AbortSignal) => Promise<import('./types').FolderShareState>
  putFolderShare: (collectionId: string, nodeId: string, options: MutationCallOptions) => Promise<import('./types').FolderShareState>
  deleteFolderShare: (collectionId: string, nodeId: string, options: MutationCallOptions) => Promise<import('./types').FolderShareState>
  getLibrary: (signal?: AbortSignal) => Promise<import('./types').LibraryCollection>
  listOwnedCollections: (params?: OwnedCollectionPageParams) => Promise<OwnedCollectionPage>
  createCollection: (
    body: CreateCollectionRequest,
    opts: MutationCallOptions,
  ) => Promise<CreateCollectionResult>
  getEditorPage: (collectionId: string, params?: EditorPageParams) => Promise<EditorPage>
  getPublicCollectionPage: (
    slug: string,
    params?: PublicCollectionPageParams,
  ) => Promise<PublicCollectionPage>
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
}

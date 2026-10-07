export type SourceType = 'collection' | 'digest_series';
export type SubscriptionCapabilities = {
  protocolVersion: 1; contentEnabled: boolean;
  limits: { editionsPerMapping: 20; mappingsPerProfile: 50;
    nodesPerProfile: 20000; nodesPerSnapshot: 20000;
    nodeAccessBatchSize: 128; nodeAccessRequestBytes: 65536;
    maxDepth: 128; snapshotBytes: 33554432; editionScanCandidates: 10000 };
};
export type ExitAction = 'keep' | 'remove';
export type ExitOverride = 'inherit' | ExitAction;
export type SourceRef = { sourceType: SourceType; sourceId: string };
export type SourceView = SourceRef & {
  title: string; owner: { displayName: string; handle: string | null } | null;
  visibility: 'private' | 'protected' | 'unlisted' | 'public';
  relations: ('followed' | 'shared')[]; sourceRole: 'viewer' | 'editor';
  openUrl: string; updatedAt: string; allowedMappingModes: ['readonly'];
};
export type Subscription = SourceRef & {
  subscriptionId: string; status: 'active' | 'terminated';
  revision: string; createdAt: string; terminatedAt: string | null;
};
export type CreateMapping = {
  mappingId: string; profileId: string; profileLabel: string; mode: 'readonly';
  digestMode: 'latest' | 'recent' | null; editionLimit: number | null;
  checkIntervalMinutes: 5 | 15 | 60 | null;
  exitPolicy: { onUnfollow: ExitOverride; onUnsubscribe: ExitOverride };
};
export type Mapping = CreateMapping & {
  subscriptionId: string; generation: string; revision: string;
  status: 'active' | 'terminating' | 'detached';
  createdAt: string; detachedAt: string | null;
};
export type MappingPatch = {
  profileLabel?: string;
  digestMode?: 'latest' | 'recent' | null; editionLimit?: number | null;
  checkIntervalMinutes?: 5 | 15 | 60 | null;
  exitPolicy?: { onUnfollow: ExitOverride; onUnsubscribe: ExitOverride };
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type SourcePage = Page<SourceView>;
export type SubscriptionListItem = Subscription & {
  availability: 'available' | 'unavailable'; source: SourceView | null;
};
export type SubscriptionPage = Page<SubscriptionListItem>;
export type MappingListItem = Mapping & {
  sourceRef: SourceRef; availability: 'available' | 'unavailable'; source: SourceView | null;
};
export type MappingPage = Page<MappingListItem>;

export type ProjectionCheck =
  | { state: 'available'; mappingId: string; generation: string;
      projectionRevision: string; policyRevision: string;
      contentDigest: string; rootKey: string;
      counts: { nodes: number; bookmarks: number; editions: number; skipped: number } }
  | { state: 'unavailable'; mappingId: string; generation: string;
      cleanup: 'remove_managed'; authorityRevision: string; reason: 'access_lost' }
  | { state: 'terminated'; mappingId: string; generation: string;
      next: 'fetch_actions' };
export type AccessFence = {
  mappingId: string; generation: string; mappingRevision: string;
  authorityRevision: string; contentEnabled: boolean;
};
export type AccessCheck = AccessFence & (
  | { state: 'available'; removeEditionIds: string[] }
  | { state: 'unavailable'; cleanup: 'remove_managed'; reason: 'access_lost' }
  | { state: 'terminated'; next: 'fetch_actions' }
);
export type SourceNodeRef = { sourceCollectionId: string; nodeId: string; editionId: string | null };
export type NodeAccessCheck = AccessFence & (
  | { state: 'available'; requestDigest: string; removeNodes: SourceNodeRef[] }
  | { state: 'unavailable'; cleanup: 'remove_managed'; reason: 'access_lost' }
  | { state: 'terminated'; next: 'fetch_actions' }
);

export type SnapshotDescriptor = {
  snapshotId: string; source: SourceRef; mappingId: string | null; generation: string | null;
  digestMode: 'latest' | 'recent' | null; editionLimit: number | null;
  projectionVersion: '1'; projectionRevision: string; projectionEtag: string;
  policyRevision: string; contentDigest: string; rootKey: string;
  counts: { nodes: number; bookmarks: number; editions: number; skipped: number };
  skippedByReason: { reason: 'unsupported_node' | 'unsafe_url'; count: number }[];
  editions: { editionId: string; title: string; publishedAt: string }[];
  expiresAt: string; maxPageSize: 200;
};
export type ProjectionNode = {
  key: string; parentKey: string | null; index: number; kind: 'folder' | 'bookmark';
  role: 'root' | 'content' | 'source_link' | 'edition_folder' | 'edition_link';
  editionId: string | null;
  title: string; url?: string;
};
export type NodePage = {
  snapshotId: string; projectionRevision: string;
  items: ProjectionNode[]; nextCursor: string | null; complete: boolean;
};

export type ExitPreviewInput =
  | { trigger: 'unsubscribe'; target: { kind: 'mapping'; mappingId: string } }
  | { trigger: 'unsubscribe'; target: { kind: 'subscription'; subscriptionId: string } }
  | { trigger: 'unfollow'; target: { kind: 'source'; sourceType: SourceType; sourceId: string } };
export type ExitTarget = {
  mappingId: string; subscriptionId: string; profileId: string; profileLabel: string;
  generation: string; mappingRevision: string; effectiveAction: ExitAction;
  policyOrigin: 'mapping' | 'global' | 'authority';
};
export type ExitPreview = ExitPreviewInput & {
  previewId: string; preferenceRevision: string; expiresAt: string; targets: ExitTarget[];
};
export type ExitBatch = {
  exitId: string; trigger: 'unsubscribe' | 'unfollow';
  actions: { actionId: string; mappingId: string; generation: string; effectiveAction: ExitAction }[];
};
export type ExitTask = {
  actionId: string; exitId: string; sequence: string; subscriptionId: string;
  mappingId: string; profileId: string; generation: string;
  trigger: 'unsubscribe' | 'unfollow'; effectiveAction: ExitAction;
  policyOrigin: 'mapping' | 'global' | 'authority'; preferenceRevision: string; mappingRevision: string;
  createdAt: string;
};
export type ActionPage = Page<ExitTask>;
export type ActionReceipt = {
  actionId: string; mappingId: string; generation: string;
  result: 'kept' | 'removed' | 'removed_access_lost' | 'no_local_mount'; acknowledgedAt: string;
};

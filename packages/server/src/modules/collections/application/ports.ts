import type {
  CanonicalMutationInput,
  CanonicalMutationResult,
  JsonObject,
} from '../domain/canonical-mutation.js';
import type { CollectionKind, NodeKind, NodeVisibility } from '../domain/validation.js';
import type {
  ProductCommandReceiptPort,
  ProductCommandResult,
} from '../../commands/index.js';
import type {
  AccessPolicyFactsPort,
  AccessPolicyWritePort,
} from '../../access-policy/index.js';
import type { GetCollectionEditorPagePorts } from './get-editor-page.js';

export type * from './canonical-stage-ports.js';

// ---------------------------------------------------------------------------
// CreateOwnedCollection (ADR-0009) — transaction-bound ports
// ---------------------------------------------------------------------------

export type ResourceLedgerType =
  | 'collection'
  | 'node'
  | 'annotation'
  | 'relation' | 'digest_series' | 'digest_edition'
  | 'operation'
  | 'domain-event'
  | 'outbox';

export interface IdLedgerReserveEntry {
  readonly resourceId: string;
  readonly resourceType: ResourceLedgerType;
}

export interface IdLedgerPort {
  reserve(entries: readonly IdLedgerReserveEntry[]): Promise<void>;
}

export interface CollectionBootstrapRow {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: CollectionKind;
  readonly visibility: 'private';
  readonly rootNodeId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly commitOrdinal: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Locked Collection row for metadata mutation (SELECT … FOR UPDATE). */
export interface LockedCollectionRow {
  readonly id: string;
  readonly ownerSubjectId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: CollectionKind;
  readonly visibility: 'private' | 'protected' | 'unlisted' | 'public';
  readonly allowSearchIndexing?: boolean;
  readonly publicationSlug?: string | null;
  readonly publishedAt?: Date | null;
  readonly rootNodeId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly commitOrdinal: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
  readonly payloadJson?: Readonly<Record<string, unknown>> | null;
}

/** Advances content (+ optional policy) fence and commit ordinal without metadata fields. */
export interface CollectionContentFenceUpdate {
  readonly contentRevision: string;
  readonly commitOrdinal: bigint;
  readonly updatedAt: Date;
  /** When set, advances collection policy_revision in the same write. */
  readonly policyRevision?: string;
}

export interface CollectionWritePort {
  insertBootstrap(row: CollectionBootstrapRow): Promise<void>;
  /** Row-level write lock for Collection metadata mutation. Null when absent. */
  lockForUpdate(collectionId: string): Promise<LockedCollectionRow | null>;
  /** Row-level shared lock for Collection editor reads (SELECT … FOR SHARE). Null when absent. */
  lockForShare(collectionId: string): Promise<LockedCollectionRow | null>;
  /** Node create/update/move/delete content fence. */
  advanceContentFence(
    collectionId: string,
    update: CollectionContentFenceUpdate,
  ): Promise<void>;
}

export interface RootNodeBootstrapRow {
  readonly id: string;
  readonly collectionId: string;
  readonly title: string;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Live node row for parent/anchor validation and content update. */
export interface LockedNodeRow {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly kind: NodeKind;
  readonly isRoot: boolean;
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
  readonly positionToken: string | null;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export interface BookmarkIconRow {
  readonly nodeId: string;
  readonly collectionId: string;
  readonly objectId: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly digestSha256: Buffer;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Live bookmark_icons lookup. Empty `nodeIds` must be a no-op (no SQL).
 * Missing node ids are omitted from the map (callers treat miss as null).
 */
export interface BookmarkIconReadPort {
  findObjectIdsByNodeIds(nodeIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/**
 * Collections-owned bookmark icon binding (1:1 with a bookmark node).
 * Optional on CollectionsWritePorts so existing test doubles keep compiling.
 */
export interface BookmarkIconWritePort extends BookmarkIconReadPort {
  findByNodeId(nodeId: string): Promise<BookmarkIconRow | null>;
  upsert(row: BookmarkIconRow): Promise<void>;
  deleteByNodeId(nodeId: string): Promise<BookmarkIconRow | null>;
  deleteByNodeIds(nodeIds: readonly string[]): Promise<void>;
  deleteByCollectionId(collectionId: string): Promise<void>;
}

export interface SiblingPositionRow {
  readonly id: string;
  readonly positionToken: string;
}

export interface NodeInsertRow {
  readonly id: string;
  readonly collectionId: string;
  readonly parentId: string;
  readonly kind: NodeKind;
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
  readonly positionToken: string;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NodeContentUpdateRow {
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
  readonly resourceRevision: string;
  readonly updatedAt: Date;
}

/** Sibling rebalance: rewrite position_token + resource_revision. */
export interface NodePositionUpdateRow {
  readonly positionToken: string;
  readonly resourceRevision: string;
  readonly updatedAt: Date;
}

/** Node move: rewrite parent_id + position_token + resource_revision. */
export interface NodeParentPositionUpdateRow {
  readonly parentId: string;
  readonly positionToken: string;
  readonly resourceRevision: string;
  readonly updatedAt: Date;
}

/** Soft-delete stamp applied to one live node. */
export interface NodeSoftDeleteRow {
  readonly deletedAt: Date;
  readonly deletedCommitOrdinal: bigint;
  /** Tombstone-side resource revision (opaque); live representation is gone. */
  readonly resourceRevision: string;
  readonly updatedAt: Date;
}

export interface NodeWritePort {
  insertRoot(row: RootNodeBootstrapRow): Promise<void>;
  insertNode(row: NodeInsertRow): Promise<void>;
  /**
   * Load a node in the collection (including soft-deleted). Null when absent.
   * Caller holds the collection write lock for serialization.
   */
  getNode(collectionId: string, nodeId: string): Promise<LockedNodeRow | null>;
  /** Return the parent chain in one set-based read, including the seed parent. */
  readParentAncestry?(collectionId: string, parentId: string, maxDepth: number): Promise<readonly LockedNodeRow[]>;
  listLiveSiblingPositions(
    collectionId: string,
    parentId: string,
  ): Promise<readonly SiblingPositionRow[]>;
  /**
   * True when the parent has at least one live child. Optional: application falls
   * back to listLiveSiblingPositions.length when omitted (e.g. test doubles).
   */
  hasLiveChildren?(collectionId: string, parentId: string): Promise<boolean>;
  /**
   * Live descendant node ids under rootNodeId within collection_id (excludes rootNodeId).
   * Postgres implements a collection-scoped recursive CTE. Optional: application falls
   * back to iterative BFS over listLiveSiblingPositions when omitted (e.g. test doubles).
   */
  listLiveDescendantIds?(
    collectionId: string,
    rootNodeId: string,
  ): Promise<readonly string[]>;
  /**
   * Live non-separator nodes in the collection (includes root). Same row shape as getNode,
   * including resourceRevision and childrenRevision. Optional: restore prefetches when
   * present; otherwise each lookup uses getNode (e.g. test doubles).
   */
  listLiveNodes?(collectionId: string): Promise<readonly LockedNodeRow[]>;
  updateContent(
    collectionId: string,
    nodeId: string,
    update: NodeContentUpdateRow,
  ): Promise<void>;
  updatePosition(
    collectionId: string,
    nodeId: string,
    update: NodePositionUpdateRow,
  ): Promise<void>;
  /** Move within the same collection: parent + position + resource revision. */
  updateParentAndPosition(
    collectionId: string,
    nodeId: string,
    update: NodeParentPositionUpdateRow,
  ): Promise<void>;
  advanceChildrenRevision(
    collectionId: string,
    nodeId: string,
    childrenRevision: string,
    updatedAt: Date,
  ): Promise<void>;
  /**
   * Soft-delete one live node: set deleted_at + deleted_commit_ordinal (+ resource_revision).
   * Does not release resource_id_ledger. Throws if the row is missing or already deleted.
   */
  markDeleted(
    collectionId: string,
    nodeId: string,
    update: NodeSoftDeleteRow,
  ): Promise<void>;
}

export interface ResourceRevisionInsert {
  readonly collectionId: string;
  readonly resourceId: string;
  readonly revision: string;
  readonly ordinal: bigint;
  readonly createdAt: Date;
}

export interface ContentRevisionInsert {
  readonly collectionId: string;
  readonly revision: string;
  readonly ordinal: bigint;
  readonly createdAt: Date;
}

export interface PolicyRevisionInsert {
  readonly collectionId: string;
  readonly revision: string;
  readonly ordinal: bigint;
  readonly createdAt: Date;
}

export interface ChildrenRevisionInsert {
  readonly collectionId: string;
  readonly parentId: string;
  readonly revision: string;
  readonly ordinal: bigint;
}

export interface RevisionWritePort {
  insertResourceRevision(row: ResourceRevisionInsert): Promise<void>;
  insertContentRevision(row: ContentRevisionInsert): Promise<void>;
  insertPolicyRevision(row: PolicyRevisionInsert): Promise<void>;
  insertChildrenRevision(row: ChildrenRevisionInsert): Promise<void>;
}

export interface BootstrapOperationRecord {
  readonly operationId: string;
  readonly collectionId: string;
  readonly commitOrdinal: bigint;
  readonly operationType: string;
  readonly payload: JsonObject;
  readonly actorPrincipalId: string;
  readonly createdAt: Date;
}

export interface BootstrapOperationPort {
  append(record: BootstrapOperationRecord): Promise<void>;
}

export interface BootstrapAuditRecord {
  readonly operationId: string;
  readonly collectionId: string;
  readonly principalId: string;
  readonly eventType: string;
  readonly details: JsonObject;
  readonly createdAt: Date;
}

export interface BootstrapAuditPort {
  append(record: BootstrapAuditRecord): Promise<void>;
}

export interface BootstrapOutboxRecord {
  readonly outboxId: string;
  readonly domainEventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly handlerName: string;
  readonly handlerMode: 'projection_latest_only' | 'delivery_each_event';
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateScope: string | null;
  readonly aggregateRevision: string | null;
  readonly commitOrdinal: bigint;
  readonly payload: JsonObject;
  readonly occurredAt: Date;
}

export interface BootstrapOutboxPort {
  append(record: BootstrapOutboxRecord): Promise<void>;
}

export interface CollectionsClock {
  now(): Promise<Date>;
}

export interface CanonicalOwnedCollectionBootstrapInput {
  readonly actor: { readonly principalId: string; readonly principalType: 'account'; readonly subjectId: string };
  readonly collectionId: string;
  readonly rootNodeId: string;
  readonly operationId: string;
  readonly domainEventId: string;
  readonly outboxId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: CollectionKind;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly rootResourceRevision: string;
  readonly rootChildrenRevision: string;
}

export interface CanonicalOwnedCollectionBootstrapResult {
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly commitOrdinal: bigint;
}

/** Transaction-bound persistence boundary for the canonical collection bootstrap service. */
export interface CanonicalOwnedCollectionBootstrapPorts {
  readonly clock: CollectionsClock;
  readonly idLedger: IdLedgerPort;
  readonly collections: Pick<CollectionWritePort, 'insertBootstrap'>;
  readonly nodes: Pick<NodeWritePort, 'insertRoot'>;
  readonly revisions: RevisionWritePort;
  readonly operations: BootstrapOperationPort;
  readonly audit: BootstrapAuditPort;
  readonly outbox: BootstrapOutboxPort;
  readonly accessPolicy: AccessPolicyWritePort;
}

/** Product admission surface for collection and node canonical mutations. */
export interface ProductCollectionCanonicalPorts {
  readonly receipts: Pick<ProductCommandReceiptPort, 'claim' | 'complete'>;
  readonly clock: CollectionsClock;
  readonly collections: Pick<CollectionWritePort, 'lockForUpdate'>;
  readonly nodes: Pick<
    NodeWritePort,
    'getNode' | 'readParentAncestry' | 'listLiveSiblingPositions' | 'hasLiveChildren' | 'listLiveNodes'
  >;
  readonly accessPolicy: AccessPolicyFactsPort;
  readonly canonical: {
    execute(input: CanonicalMutationInput): Promise<CanonicalMutationResult>;
    bootstrapOwnedCollection(
      input: CanonicalOwnedCollectionBootstrapInput,
    ): Promise<CanonicalOwnedCollectionBootstrapResult>;
  };
  /** PRODUCT_ORIGIN used to project same-origin `/api/v1/favicon/{uuid}` URLs. */
  readonly productOrigin?: string;
  /** Optional so existing create/update/move doubles keep compiling. */
  readonly bookmarkIcons?: Pick<BookmarkIconWritePort, 'findByNodeId' | 'findObjectIdsByNodeIds'>;
  /** FO-07: tx-scoped favicon ports for the create-time online auto-fetch. */
  readonly faviconAutoRefresh?: import('./favicon-job.js').FaviconAutoEnqueuePorts;
  readonly accountControl?: { accountControl(accountId: string): Promise<{ readonly restrictPublication: boolean }> };
}

export interface ProductCollectionMutationUnitOfWork {
  execute<Result>(work: (ports: ProductCollectionCanonicalPorts) => Promise<Result>): Promise<Result>;
}

/** Annotation commands use their purpose-built canonical transaction adapter. */
export interface AnnotationMutationUnitOfWork {
  execute<Result>(work: (ports: import('./update-annotation.js').AnnotationMutationPorts) => Promise<Result>): Promise<Result>;
}

/** Relation commands share one Collection-serialized canonical transaction boundary. */
export interface RelationMutationUnitOfWork {
  execute<Result>(work: (ports: import('./update-relation.js').RelationMutationPorts) => Promise<Result>): Promise<Result>;
}

/**
 * Ports for node move/reorder (P1-09), bound to one transaction.
 */
export interface MoveCollectionNodePorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly clock: CollectionsClock;
  readonly idLedger: IdLedgerPort;
  readonly collections: CollectionWritePort;
  readonly nodes: NodeWritePort;
  readonly revisions: RevisionWritePort;
  readonly operations: BootstrapOperationPort;
  readonly audit: BootstrapAuditPort;
  readonly outbox: BootstrapOutboxPort;
  readonly accessPolicy: AccessPolicyFactsPort;
}

/**
 * Ports for node / subtree delete (P1-10), bound to one transaction.
 */
export interface DeleteCollectionNodePorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly clock: CollectionsClock;
  readonly idLedger: IdLedgerPort;
  readonly collections: CollectionWritePort;
  readonly nodes: NodeWritePort;
  readonly revisions: RevisionWritePort;
  readonly operations: BootstrapOperationPort;
  readonly audit: BootstrapAuditPort;
  readonly outbox: BootstrapOutboxPort;
  readonly accessPolicy: AccessPolicyFactsPort;
}

/**
 * Superset write ports for Collection mutations sharing one UoW transaction.
 * Create uses accessPolicy (writes); update/node use accessPolicyFacts (authorize).
 */
export interface CollectionsWritePorts {
  readonly receipts: ProductCommandReceiptPort;
  readonly clock: CollectionsClock;
  readonly idLedger: IdLedgerPort;
  readonly collections: CollectionWritePort;
  readonly nodes: NodeWritePort;
  readonly revisions: RevisionWritePort;
  readonly operations: BootstrapOperationPort;
  readonly audit: BootstrapAuditPort;
  readonly outbox: BootstrapOutboxPort;
  readonly accessPolicy: AccessPolicyWritePort;
  readonly accessPolicyFacts: AccessPolicyFactsPort;
  /** Present on postgres write ports; optional so memory doubles stay compiling. */
  readonly bookmarkIcons?: BookmarkIconWritePort;
  readonly faviconPolicies?: import('./favicon-policy.js').FaviconPolicyWritePort;
  readonly faviconSources?: import('./favicon-icon-source.js').BookmarkIconSourceWritePort;
  /** FO-02 durable favicon refresh jobs (enqueue + worker); optional for existing doubles. */
  readonly faviconJobs?: import('./favicon-job.js').FaviconJobWritePort;
  readonly faviconJobsRead?: import('./favicon-job.js').FaviconJobReadPort;
  /** FO-07 durable favicon object retirement (retention window); optional for existing doubles. */
  readonly faviconGc?: import('./favicon-job.js').FaviconGcWritePort;
  readonly faviconSourceMembership?: import('./favicon-icon-source.js').FaviconSourceMembershipReadPort;
}

/**
 * Module-owned unit of work. Implementation lives in infrastructure and must not
 * leak Kysely/pg types into the collections module.
 */
export interface CollectionsUnitOfWork {
  execute<Result>(
    work: (ports: CollectionsWritePorts) => Promise<Result>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Result>;
}

/**
 * REPEATABLE READ unit of work for revision-fenced Editor page queries (ADR-0004).
 * cursorSigner is not transaction-bound; infrastructure injects it alongside DB ports.
 */
export interface CollectionsEditorReadUnitOfWork {
  execute<Result>(
    work: (ports: GetCollectionEditorPagePorts) => Promise<Result>,
  ): Promise<Result>;
}

export type {
  ProductCommandReceiptPort,
  ProductCommandResult,
  AccessPolicyFactsPort,
  AccessPolicyWritePort,
};

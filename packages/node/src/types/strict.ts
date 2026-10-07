import type {
  AbsoluteUri,
  AccessPublicationChangedFeedEventData,
  AnnotationUpdateOperationPayload,
  AttachmentUpdateOperationPayload,
  BookmarkUrl,
  CollectionFeedEventData,
  CollectionMetadataUpdateOperationPayload,
  CreateAnnotationOperationPayload,
  CreateAttachmentOperationPayload,
  CreateCollectionOperationPayload,
  CreateRelationOperationPayload,
  DateTime,
  DeleteOperationPayload,
  ExtensionFeedEventData,
  Extensions,
  FolderRole,
  HttpUrl,
  MoveOperationPayload,
  NodeChangedFeedEventData,
  NodeContentUpdateOperationPayload,
  NodeConstraints,
  NodeDeletedFeedEventData,
  NodeVisibility,
  OpaqueId,
  OperationSource,
  OrderKey,
  ReleaseCreate,
  ReleasePublishedFeedEventData,
  RelationUpdateOperationPayload,
  ReorderOperationPayload,
  RestoreOperationPayload,
  SourceRef,
  SyncSessionCollectionResult,
  UrlHash,
  Warning,
} from './generated.js';

interface NodeCommon {
  readonly id: OpaqueId;
  readonly collectionId: OpaqueId;
  readonly createdAt: DateTime;
  readonly updatedAt: DateTime;
  readonly revision: OpaqueId;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly constraints?: NodeConstraints;
  readonly extensions?: Extensions;
}

interface FeedNodeCommon {
  readonly id: OpaqueId;
  readonly title?: string;
  readonly targetNodeId?: OpaqueId;
}

/** Feed Bookmark summaries distinguish redacted nodes from nodes that may carry a safe URL. */
export type StrictFeedNode =
  | (FeedNodeCommon & {
      readonly kind: 'bookmark';
      readonly redacted: true;
      readonly url?: never;
    })
  | (FeedNodeCommon & {
      readonly kind: 'bookmark';
      readonly redacted?: false;
      readonly url?: HttpUrl;
    })
  | (FeedNodeCommon & {
      readonly kind: 'folder' | 'separator' | 'alias';
      readonly redacted?: boolean;
      readonly url?: HttpUrl;
    });

interface AuthoritativeNodeFields {
  readonly sourceRefs?: readonly SourceRef[];
  readonly redacted?: false;
  readonly accessUrl?: never;
}

export type StrictRootNode = NodeCommon &
  AuthoritativeNodeFields & {
    readonly kind: 'root';
    readonly parentId: null;
    readonly position: null;
    readonly folderRole: 'root';
    readonly title: string;
    readonly childrenModifiedAt?: DateTime;
    readonly visibility?: never;
    readonly url?: never;
    readonly canonicalUrl?: never;
    readonly urlHash?: never;
    readonly targetNodeId?: never;
    readonly lastUsedAt?: never;
  };

export type StrictFolderNode = NodeCommon &
  AuthoritativeNodeFields & {
    readonly kind: 'folder';
    readonly parentId: OpaqueId;
    readonly position: OrderKey;
    readonly folderRole?: Exclude<FolderRole, 'root'>;
    readonly title: string;
    readonly visibility?: NodeVisibility;
    readonly childrenModifiedAt?: DateTime;
    readonly url?: never;
    readonly canonicalUrl?: never;
    readonly urlHash?: never;
    readonly targetNodeId?: never;
    readonly lastUsedAt?: never;
  };

export type StrictBookmarkNode = NodeCommon &
  AuthoritativeNodeFields & {
    readonly kind: 'bookmark';
    readonly parentId: OpaqueId;
    readonly position: OrderKey;
    readonly title: string;
    readonly url: BookmarkUrl;
    readonly canonicalUrl?: HttpUrl;
    readonly urlHash?: UrlHash;
    readonly visibility?: NodeVisibility;
    readonly lastUsedAt?: DateTime;
    readonly folderRole?: never;
    readonly targetNodeId?: never;
    readonly childrenModifiedAt?: never;
  };

export type StrictRedactedBookmarkNode = NodeCommon & {
  readonly kind: 'bookmark';
  readonly parentId: OpaqueId;
  readonly position: OrderKey;
  readonly title: string;
  readonly redacted: true;
  readonly visibility: Exclude<NodeVisibility, 'inherit'>;
  readonly accessUrl?: HttpUrl;
  readonly url?: never;
  readonly canonicalUrl?: never;
  readonly urlHash?: never;
  readonly sourceRefs?: never;
  readonly folderRole?: never;
  readonly targetNodeId?: never;
  readonly childrenModifiedAt?: never;
  readonly lastUsedAt?: never;
};

export type StrictSeparatorNode = NodeCommon &
  AuthoritativeNodeFields & {
    readonly kind: 'separator';
    readonly parentId: OpaqueId;
    readonly position: OrderKey;
    readonly visibility?: NodeVisibility;
    readonly title?: never;
    readonly url?: never;
    readonly canonicalUrl?: never;
    readonly urlHash?: never;
    readonly targetNodeId?: never;
    readonly folderRole?: never;
    readonly childrenModifiedAt?: never;
    readonly lastUsedAt?: never;
  };

export type StrictAliasNode = NodeCommon &
  AuthoritativeNodeFields & {
    readonly kind: 'alias';
    readonly parentId: OpaqueId;
    readonly position: OrderKey;
    readonly title: string;
    readonly targetNodeId: OpaqueId;
    readonly visibility?: NodeVisibility;
    readonly lastUsedAt?: DateTime;
    readonly url?: never;
    readonly canonicalUrl?: never;
    readonly urlHash?: never;
    readonly folderRole?: never;
    readonly childrenModifiedAt?: never;
  };

export type StrictNode =
  | StrictRootNode
  | StrictFolderNode
  | StrictBookmarkNode
  | StrictRedactedBookmarkNode
  | StrictSeparatorNode
  | StrictAliasNode;

type SnapshotNodeProjection<Node extends StrictNode> = Node extends StrictRootNode
  ? Node & { readonly index?: null }
  : Node & { readonly index?: number };

/** Snapshot-only Node projection. Its optional index is derived and non-authoritative. */
export type StrictSnapshotNode = SnapshotNodeProjection<StrictNode>;

interface NodeCreateCommon {
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly visibility?: NodeVisibility;
  readonly extensions?: Extensions;
}

export type StrictNodeCreate =
  | (NodeCreateCommon & {
      readonly kind: 'folder';
      readonly title: string;
      readonly folderRole?: Exclude<FolderRole, 'root'>;
      readonly url?: never;
      readonly canonicalUrl?: never;
      readonly urlHash?: never;
      readonly targetNodeId?: never;
    })
  | (NodeCreateCommon & {
      readonly kind: 'bookmark';
      readonly title: string;
      readonly url: BookmarkUrl;
      readonly canonicalUrl?: HttpUrl;
      readonly urlHash?: UrlHash;
      readonly targetNodeId?: never;
      readonly folderRole?: never;
    })
  | (NodeCreateCommon & {
      readonly kind: 'separator';
      readonly title?: never;
      readonly url?: never;
      readonly canonicalUrl?: never;
      readonly urlHash?: never;
      readonly targetNodeId?: never;
      readonly folderRole?: never;
    })
  | (NodeCreateCommon & {
      readonly kind: 'alias';
      readonly title: string;
      readonly targetNodeId: OpaqueId;
      readonly url?: never;
      readonly canonicalUrl?: never;
      readonly urlHash?: never;
      readonly folderRole?: never;
    });

interface OperationBase<Type extends string, Payload> {
  readonly opId: OpaqueId;
  readonly replicaId: OpaqueId;
  readonly sequence: number;
  readonly type: Type;
  readonly occurredAt: DateTime;
  readonly dependencies?: readonly OpaqueId[];
  readonly payload: Payload;
  readonly source?: OperationSource;
}

type CreateOperation<Type extends string, Payload> = OperationBase<Type, Payload> & {
  readonly collectionId: OpaqueId;
  readonly baseRevision: null;
  readonly targetId?: never;
};

type TargetOperation<Type extends string, Payload> = OperationBase<Type, Payload> & {
  readonly collectionId: OpaqueId;
  readonly targetId: OpaqueId;
  readonly baseRevision: OpaqueId;
};

type CreateCollectionOperation = OperationBase<
  'create_collection',
  CreateCollectionOperationPayload
> & {
  readonly sequence: 1;
  readonly collectionId?: never;
  readonly targetId?: never;
  readonly baseRevision: null;
};

export type StrictOperation =
  | CreateCollectionOperation
  | TargetOperation<'update_collection_metadata', CollectionMetadataUpdateOperationPayload>
  | TargetOperation<'delete_collection', DeleteOperationPayload>
  | TargetOperation<'restore_collection', RestoreOperationPayload>
  | TargetOperation<'publish_release', ReleaseCreate>
  | CreateOperation<'create_node', { readonly parentId: OpaqueId; readonly afterId?: OpaqueId | null; readonly beforeId?: OpaqueId | null; readonly node: StrictNodeCreate }>
  | TargetOperation<'update_node_content', NodeContentUpdateOperationPayload>
  | TargetOperation<'move_node', MoveOperationPayload>
  | TargetOperation<'reorder_children', ReorderOperationPayload>
  | TargetOperation<'delete_node', DeleteOperationPayload>
  | TargetOperation<'delete_subtree', DeleteOperationPayload>
  | TargetOperation<'restore_node', RestoreOperationPayload>
  | CreateOperation<'create_annotation', CreateAnnotationOperationPayload>
  | TargetOperation<'update_annotation', AnnotationUpdateOperationPayload>
  | TargetOperation<'delete_annotation', DeleteOperationPayload>
  | CreateOperation<'create_attachment', CreateAttachmentOperationPayload>
  | TargetOperation<'update_attachment', AttachmentUpdateOperationPayload>
  | TargetOperation<'delete_attachment', DeleteOperationPayload>
  | CreateOperation<'create_relation', CreateRelationOperationPayload>
  | TargetOperation<'update_relation', RelationUpdateOperationPayload>
  | TargetOperation<'delete_relation', DeleteOperationPayload>;

interface OperationResultBase<Status extends string> {
  readonly opId: OpaqueId;
  readonly sequence: number;
  readonly status: Status;
  readonly targetId?: OpaqueId;
  readonly warnings: readonly Warning[];
}

export type StrictOperationResult =
  | (OperationResultBase<'applied'> & {
      readonly revision: OpaqueId;
      readonly cursor: OpaqueId;
      readonly boundCollection?: SyncSessionCollectionResult;
      readonly transform?: Readonly<Record<string, unknown>>;
      readonly conflictId?: never;
      readonly retryAfterSeconds?: never;
    })
  | (OperationResultBase<'rebased'> & {
      readonly revision: OpaqueId;
      readonly cursor: OpaqueId;
      readonly transform?: Readonly<Record<string, unknown>>;
      readonly conflictId?: never;
      readonly boundCollection?: never;
      readonly retryAfterSeconds?: never;
    })
  | (OperationResultBase<'noop'> & {
      readonly revision?: OpaqueId;
      readonly cursor?: never;
      readonly conflictId?: never;
      readonly boundCollection?: never;
      readonly transform?: never;
      readonly retryAfterSeconds?: never;
    })
  | (OperationResultBase<'conflicted'> & {
      readonly cursor: OpaqueId;
      readonly conflictId: OpaqueId;
      readonly revision?: never;
      readonly boundCollection?: never;
      readonly transform?: never;
      readonly retryAfterSeconds?: never;
    })
  | (OperationResultBase<'rejected'> & {
      readonly code: string;
      readonly revision?: never;
      readonly cursor?: never;
      readonly conflictId?: never;
      readonly boundCollection?: never;
      readonly transform?: never;
      readonly retryAfterSeconds?: never;
    })
  | (OperationResultBase<'deferred'> & {
      readonly code: string;
      readonly retryAfterSeconds?: number;
      readonly revision?: never;
      readonly cursor?: never;
      readonly conflictId?: never;
      readonly boundCollection?: never;
      readonly transform?: never;
    });

interface FeedEventBase<Type extends string, Data> {
  readonly specversion: '1.0';
  readonly id: OpaqueId;
  readonly source: AbsoluteUri;
  readonly type: Type;
  readonly subject: string;
  readonly time: DateTime;
  readonly datacontenttype: 'application/json';
  readonly collectionprotocolversion: '0.1';
  readonly data: Data;
}

export type StrictFeedEvent =
  | FeedEventBase<
      | 'com.know-n.colp.collection.created.v1'
      | 'com.know-n.colp.collection.updated.v1'
      | 'com.know-n.colp.collection.deleted.v1'
      | 'com.know-n.colp.annotation.published.v1',
      CollectionFeedEventData
    >
  | FeedEventBase<'com.know-n.colp.release.published.v1', ReleasePublishedFeedEventData>
  | FeedEventBase<
      | 'com.know-n.colp.node.created.v1'
      | 'com.know-n.colp.node.updated.v1'
      | 'com.know-n.colp.node.moved.v1',
      NodeChangedFeedEventData
    >
  | FeedEventBase<'com.know-n.colp.node.deleted.v1', NodeDeletedFeedEventData>
  | FeedEventBase<
      'com.know-n.colp.access.publication_changed.v1',
      AccessPublicationChangedFeedEventData
    >
  | FeedEventBase<`https://${string}`, ExtensionFeedEventData>;

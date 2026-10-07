import type {
  AccessPolicy,
  FeedEvent,
  FeedNode,
  HttpUrl,
  Node,
  Operation,
  OperationResult,
  SyncPullEventV02,
} from '../../src/types/index.js';

const timestamp = '2026-07-16T00:00:00Z';
const publicBookmarkUrl = 'https://example.com/public' as HttpUrl;
const privateBookmarkUrl = 'https://example.com/private' as HttpUrl;

export const policyWithoutInheritanceSwitch: AccessPolicy = {
  visibility: 'private',
  entries: [],
  publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
  revision: 'acl-1',
};

export const legacyPolicyInheritanceSwitch: AccessPolicy = {
  visibility: 'private',
  // @ts-expect-error Access Policy inheritance is mandatory and has no Wire switch
  inherit: false,
  entries: [],
  publication: { listInDirectory: false, allowSearchIndexing: false, allowEmbedding: false },
  revision: 'acl-1',
};

export const bookmarkNode: Node = {
  id: 'node-1',
  collectionId: 'collection-1',
  kind: 'bookmark',
  parentId: 'root-1',
  position: 'a',
  title: 'Local guide',
  url: 'file:///C:/Docs/guide.html',
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 'r-1',
};

// @ts-expect-error folders cannot carry bookmark URLs
export const folderWithUrl: Node = {
  id: 'folder-1',
  collectionId: 'collection-1',
  kind: 'folder',
  parentId: 'root-1',
  position: 'b',
  title: 'Folder',
  url: 'https://example.com/',
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 'r-1',
};

export const moveWithUpdatePayload: Operation = {
  opId: 'op-1',
  replicaId: 'replica-1',
  sequence: 1,
  collectionId: 'collection-1',
  type: 'move_node',
  targetId: 'node-1',
  baseRevision: 'r-1',
  occurredAt: timestamp,
  payload: {
    // @ts-expect-error move payload cannot contain field changes
    changes: [{ path: '/title', base: 'Before', value: 'After' }],
  },
};

export const instanceCollectionCreate: Operation = {
  opId: 'op-create',
  replicaId: 'replica-1',
  sequence: 1,
  type: 'create_collection',
  baseRevision: null,
  occurredAt: timestamp,
  payload: {
    collection: { kind: 'bookmarks', title: 'Imported', visibility: 'private' },
    root: { title: 'Imported', folderRole: 'root' },
  },
};

export const typedNodeUpdate: Operation = {
  opId: 'op-update',
  replicaId: 'replica-1',
  sequence: 2,
  collectionId: 'collection-1',
  type: 'update_node_content',
  targetId: 'node-1',
  baseRevision: 'r-1',
  occurredAt: timestamp,
  payload: {
    base: { title: 'Before', tags: ['old'] },
    value: { title: 'After', tags: ['new'] },
  },
};

// @ts-expect-error COLP 0.2 operation events require an authoritative effect
export const incompleteV02OperationEvent: SyncPullEventV02 = {
  cursor: 'cursor-1',
  kind: 'operation',
  operation: typedNodeUpdate,
  effect: undefined,
};

export const deferredResult: OperationResult = {
  opId: 'op-deferred',
  sequence: 3,
  status: 'deferred',
  code: 'dependency_pending',
  retryAfterSeconds: 5,
  warnings: [],
};

// @ts-expect-error rejected results cannot carry a Sync cursor
export const rejectedResultWithCursor: OperationResult = {
  opId: 'op-rejected',
  sequence: 4,
  status: 'rejected',
  code: 'invalid_update',
  cursor: 'sync-4',
  warnings: [],
};

// @ts-expect-error release events require release metadata and digest
export const incompleteReleaseEvent: FeedEvent = {
  specversion: '1.0',
  id: 'event-1',
  source: 'https://example.com/collections',
  type: 'com.know-n.colp.release.published.v1',
  subject: 'collections/c/collection-1/releases/release-1',
  time: timestamp,
  datacontenttype: 'application/json',
  collectionprotocolversion: '0.1',
  data: { collectionId: 'collection-1', revision: 'r-1' },
};

export const redactedFeedBookmark: FeedNode = {
  id: 'node-redacted',
  kind: 'bookmark',
  redacted: true,
};

export const targetBearingFeedBookmark: FeedNode = {
  id: 'node-public',
  kind: 'bookmark',
  url: publicBookmarkUrl,
};

// @ts-expect-error redacted Feed Bookmarks cannot carry their original target URL
export const redactedFeedBookmarkWithUrl: FeedNode = {
  id: 'node-invalid',
  kind: 'bookmark',
  redacted: true,
  url: privateBookmarkUrl,
};

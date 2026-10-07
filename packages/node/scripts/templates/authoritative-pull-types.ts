/** COLP 0.2 RFC 9530 SHA-256 Content-Digest field value. */
export type AuthoritativeDigest = string;
export type ManifestV02 = Omit<Manifest, 'protocol'> & {
  protocol: 'https://know-n.com/colp/spec/0.2';
  protocolVersions: [string, string, ...string[]];
  syncEffectPages: HttpsUriTemplate;
};
export interface AuthoritativeEffectBinding {
  effectId: OpaqueId;
  status: 'applied' | 'rebased';
  opId: OpaqueId;
  replicaId: OpaqueId;
  sequence: number;
  collectionId: OpaqueId;
  operationDigest: AuthoritativeDigest;
  effectDigest: AuthoritativeDigest;
}
export interface AuthoritativePlacement {
  parentId: OpaqueId;
  afterId: OpaqueId | null;
  beforeId: OpaqueId | null;
  position: OrderKey;
}
export interface AuthoritativeParentRevision {
  parentId: OpaqueId;
  childrenRevision: OpaqueId;
}
export interface AuthoritativeEffectPageRef {
  pageCount: number;
  memberCount: number;
  memberDigest: AuthoritativeDigest;
  firstPageDigest: AuthoritativeDigest;
}
export interface AuthoritativeEffectPage {
  effectId: OpaqueId;
  pageNumber: number;
  pageCount: number;
  members: OpaqueId[];
  memberCount: number;
  pageDigest: AuthoritativeDigest;
  previousPageDigest: AuthoritativeDigest | null;
}
export type NodeCreatedEffect = AuthoritativeEffectBinding & {
  kind: 'node_created'; node: Node; placement: AuthoritativePlacement;
  parentRevision: AuthoritativeParentRevision;
  nodeChildrenRevision: OpaqueId | null;
};
export type NodeContentUpdatedEffect = AuthoritativeEffectBinding & {
  kind: 'node_content_updated'; node: Node;
};
export type NodeMovedEffect = AuthoritativeEffectBinding & {
  kind: 'node_moved'; node: Node; placement: AuthoritativePlacement;
  parentRevisions: AuthoritativeParentRevision[];
};
export type NodeDeletedEffect = AuthoritativeEffectBinding & {
  kind: 'node_deleted'; deletion: SyncTombstone; tombstone: SyncTombstone;
  parentRevision: AuthoritativeParentRevision;
};
export type SubtreeDeletedEffect = AuthoritativeEffectBinding & {
  kind: 'subtree_deleted'; rootTombstone: SyncTombstone; memberCount: number;
  memberDigest: AuthoritativeDigest; parentRevision: AuthoritativeParentRevision;
} & ({ members: OpaqueId[]; effectRef?: never } | { members?: never; effectRef: AuthoritativeEffectPageRef });
export type NodeRestoredEffect = AuthoritativeEffectBinding & {
  kind: 'node_restored'; node: Node; placement: AuthoritativePlacement;
  parentRevision: AuthoritativeParentRevision; consumedTombstone: SyncTombstone;
};
export type AuthoritativePullEffect =
  | NodeCreatedEffect | NodeContentUpdatedEffect | NodeMovedEffect | NodeDeletedEffect
  | SubtreeDeletedEffect | NodeRestoredEffect;
export type SyncPullEventV02 =
  | { cursor: OpaqueId; kind: 'operation'; operation: Extract<Operation, { type: 'create_node' }>; effect: NodeCreatedEffect; conflict?: never }
  | { cursor: OpaqueId; kind: 'operation'; operation: Extract<Operation, { type: 'update_node_content' }>; effect: NodeContentUpdatedEffect; conflict?: never }
  | { cursor: OpaqueId; kind: 'operation'; operation: Extract<Operation, { type: 'move_node' }>; effect: NodeMovedEffect; conflict?: never }
  | { cursor: OpaqueId; kind: 'operation'; operation: Extract<Operation, { type: 'delete_node' }>; effect: NodeDeletedEffect; conflict?: never }
  | { cursor: OpaqueId; kind: 'operation'; operation: Extract<Operation, { type: 'delete_subtree' }>; effect: SubtreeDeletedEffect; conflict?: never }
  | { cursor: OpaqueId; kind: 'operation'; operation: Extract<Operation, { type: 'restore_node' }>; effect: NodeRestoredEffect; conflict?: never }
  | { cursor: OpaqueId; kind: 'conflict'; conflict: Conflict; operation?: never; effect?: never };
export interface SyncPullV02 {
  events: SyncPullEventV02[];
  nextCursor: OpaqueId;
  hasMore: boolean;
  collectionRevision: OpaqueId;
  recommendedPullAfterSeconds: number;
}
export type SyncSnapshotV02 = Omit<Snapshot, 'protocolVersion' | 'mode'> & {
  protocolVersion: '0.2';
  mode: 'sync';
  syncCursor: OpaqueId;
  parentRevisions: AuthoritativeParentRevision[];
};
export type SyncSessionRequestV02 =
  | (Omit<SyncCollectionSessionRequest, 'protocolVersion'> & { protocolVersion: '0.2' })
  | (Omit<SyncInstanceSessionRequest, 'protocolVersion'> & { protocolVersion: '0.2' });
export type SyncSessionResultV02 =
  | (Omit<SyncCollectionSessionResult, 'acceptedProtocolVersion'> & { acceptedProtocolVersion: '0.2' })
  | (Omit<SyncInstanceSessionResult, 'acceptedProtocolVersion'> & { acceptedProtocolVersion: '0.2' });

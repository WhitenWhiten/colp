import type { MappingFact, MountFact, LocalNodeFact, RemoteNodeFact } from './matcher.js';
import type { MappingInput, SyncScope } from '../sync-state-store.js';

/** The two destructive directions supported by the advanced bootstrap UI. */
export type AdvancedMode = 'upload' | 'download' | 'mirror';

export type AdvancedNodeKind = 'folder' | 'bookmark' | 'separator';

/**
 * A parent is either already known on the target side or will be materialised
 * by an earlier plan step.  Keeping this reference symbolic is important:
 * Chrome ids and server Node ids are both unavailable until their create step
 * has received its authoritative receipt.
 */
export type AdvancedParentRef =
  | { readonly kind: 'remote-node'; readonly id: string }
  | { readonly kind: 'native-node'; readonly id: string }
  | { readonly kind: 'step'; readonly stepId: string };

export type AdvancedRevisionRef =
  | string
  | { readonly kind: 'step'; readonly stepId: string; readonly field: 'revision' | 'childrenRevision' };

export interface AdvancedNodeValue {
  readonly kind: AdvancedNodeKind;
  readonly title: string;
  readonly url?: string;
  readonly folderRole?: string;
}

/** A local fact copied into a step without exposing any browser credentials. */
export interface AdvancedLocalState {
  readonly nativeId: string;
  readonly mountNativeRootId: string;
  readonly parentNativeId: string | null;
  readonly kind: AdvancedNodeKind;
  readonly title: string;
  readonly url?: string;
  readonly index?: number;
}

/** A remote fact copied from the complete, confirmation-bound snapshot. */
export interface AdvancedRemoteState {
  readonly nodeId: string;
  readonly parentId: string | null;
  readonly kind: AdvancedNodeKind;
  readonly title: string;
  readonly url?: string;
  readonly revision: string;
  readonly position?: string | null;
  readonly childrenRevision?: string | null;
  readonly folderRole?: string;
}

export interface AdvancedDesiredRemoteState {
  readonly nodeId: string | null;
  readonly parent: AdvancedParentRef;
  readonly node: AdvancedNodeValue;
}

export interface AdvancedDesiredLocalState {
  readonly nativeId: string | null;
  readonly parent: AdvancedParentRef;
  readonly node: AdvancedNodeValue;
  /** Chrome's zero-based child position after this step settles. */
  readonly index?: number;
}

export interface AdvancedStepBase {
  readonly stepId: string;
  readonly order: number;
  readonly dependsOn: readonly string[];
  readonly side: 'remote' | 'local';
  readonly action: 'create' | 'update' | 'move' | 'delete' | 'remove';
  readonly operation: string;
}

export interface AdvancedRemoteCreateStep extends AdvancedStepBase {
  readonly side: 'remote';
  readonly action: 'create';
  readonly operation: 'create_node';
  readonly source: { readonly nativeId: string; readonly fact: AdvancedLocalState };
  readonly parent: AdvancedParentRef;
  readonly payload: {
    readonly type: 'create_node';
    readonly parent: AdvancedParentRef;
    readonly afterId: null;
    readonly beforeId: null;
    readonly node: AdvancedNodeValue;
  };
  readonly before: null;
  readonly after: AdvancedDesiredRemoteState;
}

export interface AdvancedRemoteUpdateStep extends AdvancedStepBase {
  readonly side: 'remote';
  readonly action: 'update';
  readonly operation: 'update_node_content';
  readonly target: { readonly nodeId: string; readonly nativeId: string };
  readonly payload: {
    readonly type: 'update_node_content';
    readonly targetId: string;
    readonly baseRevision: string;
    readonly base: Readonly<Record<string, string>>;
    readonly value: Readonly<Record<string, string>>;
  };
  readonly before: AdvancedRemoteState;
  readonly after: AdvancedDesiredRemoteState;
}

export interface AdvancedRemoteMoveStep extends AdvancedStepBase {
  readonly side: 'remote';
  readonly action: 'move';
  readonly operation: 'move_node';
  readonly source: { readonly nodeId: string; readonly fact: AdvancedRemoteState };
  readonly target: { readonly nodeId: string; readonly nativeId: string };
  readonly parent: AdvancedParentRef;
  readonly payload: {
    readonly type: 'move_node';
    readonly targetId: string;
    readonly baseRevision: AdvancedRevisionRef;
    readonly newParent: AdvancedParentRef;
    readonly afterId: null;
    readonly beforeId: null;
    readonly baseSourceParentRevision: string;
    readonly baseTargetParentRevision: AdvancedRevisionRef;
  };
  readonly before: AdvancedRemoteState;
  readonly after: AdvancedDesiredRemoteState;
}

export interface AdvancedRemoteDeleteStep extends AdvancedStepBase {
  readonly side: 'remote';
  readonly action: 'delete';
  /** Chosen from `before.kind`: a folder is always `delete_subtree`. */
  readonly operation: 'delete_node' | 'delete_subtree';
  readonly target: { readonly nodeId: string };
  readonly payload: {
    readonly type: 'delete_node' | 'delete_subtree';
    readonly targetId: string;
    readonly baseRevision: string;
  };
  readonly before: AdvancedRemoteState;
  readonly after: null;
}

export interface AdvancedLocalCreateStep extends AdvancedStepBase {
  readonly side: 'local';
  readonly action: 'create';
  readonly operation: 'create';
  readonly source: { readonly nodeId: string; readonly fact: AdvancedRemoteState };
  readonly parent: AdvancedParentRef;
  readonly payload: {
    readonly type: 'create';
    readonly parent: AdvancedParentRef;
    readonly index: number;
    readonly node: AdvancedNodeValue;
  };
  readonly before: null;
  readonly after: AdvancedDesiredLocalState;
}

export interface AdvancedLocalUpdateStep extends AdvancedStepBase {
  readonly side: 'local';
  readonly action: 'update';
  readonly operation: 'update';
  readonly source: { readonly nodeId: string; readonly fact: AdvancedRemoteState };
  readonly target: { readonly nativeId: string; readonly nodeId: string };
  readonly payload: {
    readonly type: 'update';
    readonly nativeId: string;
    readonly before: AdvancedNodeValue;
    readonly after: AdvancedNodeValue;
  };
  readonly before: AdvancedLocalState;
  readonly after: AdvancedDesiredLocalState;
}

export interface AdvancedLocalMoveStep extends AdvancedStepBase {
  readonly side: 'local';
  readonly action: 'move';
  readonly operation: 'move';
  readonly source: { readonly nodeId: string; readonly fact: AdvancedRemoteState };
  readonly target: { readonly nativeId: string; readonly nodeId: string };
  readonly parent: AdvancedParentRef;
  readonly payload: {
    readonly type: 'move';
    readonly nativeId: string;
    readonly newParent: AdvancedParentRef;
    readonly index: number;
  };
  readonly before: AdvancedLocalState;
  readonly after: AdvancedDesiredLocalState;
}

export interface AdvancedLocalRemoveStep extends AdvancedStepBase {
  readonly side: 'local';
  readonly action: 'remove';
  readonly operation: 'remove';
  readonly target: { readonly nativeId: string };
  readonly payload: {
    readonly type: 'remove';
    readonly nativeId: string;
    readonly recursive: false;
  };
  readonly before: AdvancedLocalState;
  readonly after: null;
}

export type AdvancedStep =
  | AdvancedRemoteCreateStep
  | AdvancedRemoteUpdateStep
  | AdvancedRemoteMoveStep
  | AdvancedRemoteDeleteStep
  | AdvancedLocalCreateStep
  | AdvancedLocalUpdateStep
  | AdvancedLocalMoveStep
  | AdvancedLocalRemoveStep;

export interface AdvancedChecklistItem {
  readonly itemId: string;
  readonly stepId: string;
  readonly order: number;
  readonly side: AdvancedStep['side'];
  readonly action: AdvancedStep['action'];
  readonly targetId: string;
  readonly title: string;
  readonly kind: AdvancedNodeKind;
  readonly parentId: string | null;
}

export interface AdvancedPlan {
  readonly kind: 'advanced-bootstrap-plan';
  readonly planId: string;
  readonly scopeKey: string;
  readonly mode: AdvancedMode;
  readonly scopeFingerprint: string;
  readonly treeDigest: string;
  readonly remoteSnapshotId: string;
  readonly remoteRevision: string;
  readonly remoteCursor: string;
  readonly destructivePlanDigest: string;
  readonly matched: readonly { readonly nativeId: string; readonly nodeId: string }[];
  readonly bindings: readonly {
    readonly nativeId: string;
    readonly nodeId: string;
    readonly remote: AdvancedRemoteState;
  }[];
  readonly mountBindings: readonly {
    readonly nativeRootId: string;
    readonly rootRole?: string;
    readonly remoteNodeId?: string;
    readonly createStepId?: string;
  }[];
  readonly localOnly: readonly string[];
  readonly remoteOnly: readonly string[];
  readonly steps: readonly AdvancedStep[];
  readonly checklist: readonly AdvancedChecklistItem[];
  readonly digest: string;
}

export interface AdvancedPlanInput {
  readonly scope?: SyncScope;
  readonly scopeKey?: string;
  readonly planId?: string;
  readonly confirmationId: string;
  readonly mode: AdvancedMode;
  readonly boundaryVersion?: string;
  readonly scopeFingerprint?: string;
  readonly treeDigest?: string;
  readonly remoteSnapshotId: string;
  readonly remoteRevision: string;
  readonly remoteCursor: string;
  readonly local: readonly LocalNodeFact[];
  readonly remote: readonly RemoteNodeFact[];
  readonly mappings: readonly (MappingFact | MappingInput)[];
  readonly sidecars?: readonly MappingFact[];
  readonly mounts: readonly MountFact[];
  readonly rootNodeId: string | null;
}

export type AdvancedPlanErrorCode =
  | 'advanced_mode_invalid'
  | 'advanced_binding_invalid'
  | 'advanced_input_invalid'
  | 'advanced_duplicate_id'
  | 'advanced_mapping_collision'
  | 'advanced_parent_missing'
  | 'advanced_parent_cycle'
  | 'advanced_root_invalid'
  | 'advanced_mount_invalid'
  | 'advanced_mount_ambiguous'
  | 'advanced_mount_missing'
  | 'advanced_identity_ambiguous'
  | 'advanced_identity_kind_mismatch'
  | 'advanced_parent_revision_missing'
  | 'advanced_unsupported_node'
  | 'advanced_boundary_violation';

export class AdvancedPlanError extends Error {
  constructor(readonly code: AdvancedPlanErrorCode, readonly details: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'AdvancedPlanError';
  }
}

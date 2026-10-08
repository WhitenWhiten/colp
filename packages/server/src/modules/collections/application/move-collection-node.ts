import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  CollectionAuthorizationError,
  CollectionPreconditionError,
  CollectionsError,
  NodeConflictError,
  assertNonEmptyField,
  generateOpaqueId,
  strongEntityTag,
} from '../domain/index.js';
import type {
  LockedNodeRow,
  ProductCollectionCanonicalPorts,
} from './ports.js';
import type { EditableNodeView } from './get-editor-page.js';
import { projectBookmarkIconUrl } from './bookmark-icon-url.js';
import {
  authorizeCollectionCapability,
  claimProductMutation,
  projectEditableNodeView,
} from './product-mutation-admission.js';
import {
  type CollectionFenceSnapshot,
  type ParentStateSnapshot,
} from './create-collection-node.js';
import { ifMatchSatisfied } from './update-collection-metadata.js';
import { classifyParentAncestry } from './ancestry-validation.js';

/** Walk ancestry at most this many steps when detecting folder reparent cycles. */
const MAX_PARENT_ANCESTRY_DEPTH = 256;

export function moveCollectionNodeCommandScope(
  collectionId: string,
  nodeId: string,
): string {
  return `collection:${collectionId}:node:${nodeId}:move`;
}

export const MOVE_COLLECTION_NODE_COMMAND_SCOPE =
  'collection:{collectionId}:node:{nodeId}:move';
export const MOVE_COLLECTION_NODE_CONTRACT_VERSION = '1.0.0';
export const MOVE_COLLECTION_NODE_OPERATION_TYPE = 'move_collection_node';
export const NODE_MOVED_EVENT_TYPE = 'node.moved';
export const NODE_MOVED_EVENT_VERSION = 1;
export const NODE_MOVED_HANDLER_NAME = 'node_moved_projection';

export interface MoveCollectionNodeActor {
  readonly principalId: string;
  readonly principalType: 'account';
  readonly subjectId: string;
}

export interface MoveCollectionNodeCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  /** Defaults to a transport-neutral node-move intent. */
  readonly commandScope?: string;
}

export interface MoveCollectionNodeInput {
  readonly actor: MoveCollectionNodeActor;
  readonly command: MoveCollectionNodeCommand;
  readonly collectionId: string;
  readonly nodeId: string;
  /**
   * Strong entity-tag (`"revision"`) or bare revision token from If-Match.
   * Missing If-Match is a transport concern (428); application only compares.
   */
  readonly ifMatch: string;
  readonly newParentId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly baseSourceParentRevision: string;
  readonly baseTargetParentRevision: string;
  /** Optional overrides for deterministic tests only. */
  readonly operationId?: string;
}

export type MoveCollectionNodeResult =
  | {
      readonly kind: 'moved';
      readonly node: EditableNodeView;
      readonly sourceParent: ParentStateSnapshot;
      readonly targetParent: ParentStateSnapshot;
      readonly fence: CollectionFenceSnapshot;
      readonly operationId: string;
      readonly commitOrdinal: bigint;
    }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly body: Uint8Array;
      readonly stableHeaders: Readonly<Record<string, string>>;
      readonly mediaType: string;
      readonly contractVersion: string;
      readonly targetIdentity?: string;
    }
  | {
      readonly kind: 'in_progress';
      readonly retryAfterSeconds: number;
    }
  | { readonly kind: 'reused' }
  | {
      readonly kind: 'expired';
      readonly resultDigest: string | null;
    };

/**
 * ADR-0002 / docs matrix: Node move/reorder in one Collection-locked transaction.
 * claim → lock collection → authorize move_node → load node (root_immutable)
 * → If-Match → validate target parent + cycle → source/target children revision fence
 * → one canonical mutation allocates position and advances children/content/ordinal
 * → Operation/Audit/Outbox node.moved → complete product receipt (200 MoveNodeResult).
 */
export async function moveCollectionNode(
  ports: ProductCollectionCanonicalPorts,
  input: MoveCollectionNodeInput,
): Promise<MoveCollectionNodeResult> {
  const validated = validateInput(input);
  const binding: ProductCommandBinding = {
    principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope,
    commandId: validated.command.commandId,
  };

  const claim = await claimProductMutation(ports, binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') {
    return claim;
  }

  const locked = await ports.collections.lockForUpdate(validated.collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  await authorizeCollectionCapability(ports.accessPolicy, {
    collectionId: validated.collectionId,
    actor: validated.actor,
    capability: 'move_node',
  }, locked);

  const node = await ports.nodes.getNode(validated.collectionId, validated.nodeId);
  if (!node || node.deletedAt !== null) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  if (node.isRoot) {
    throw new NodeConflictError('root_immutable');
  }

  // Non-root nodes always have a parent; defend against corrupt rows.
  if (node.parentId === null) {
    throw new CollectionsError(
      'invalid_node_input',
      'node is missing parent_id',
    );
  }

  if (!ifMatchSatisfied(validated.ifMatch, node.resourceRevision)) {
    throw new CollectionPreconditionError({
      currentEtag: strongEntityTag(node.resourceRevision),
    });
  }

  const sourceParentId = node.parentId;
  const sameParent = sourceParentId === validated.newParentId;

  const sourceParent = await ports.nodes.getNode(
    validated.collectionId,
    sourceParentId,
  );
  assertValidStructuralParent(sourceParent, validated.collectionId, 'source parent');

  const targetParent = sameParent
    ? sourceParent
    : await ports.nodes.getNode(validated.collectionId, validated.newParentId);
  assertValidStructuralParent(targetParent, validated.collectionId, 'newParent');

  if (node.kind === 'folder') {
    await assertNoFolderCycle(
      ports,
      validated.collectionId,
      validated.nodeId,
      validated.newParentId,
    );
  } else if (validated.newParentId === validated.nodeId) {
    // Bookmarks cannot parent, but self-parent is always invalid.
    throw new CollectionsError(
      'invalid_node_parent',
      'newParent must not be the moved node',
    );
  }

  if (sourceParent.childrenRevision !== validated.baseSourceParentRevision) {
    throw new NodeConflictError(
      'position_context_stale',
      'source parent children revision does not match baseSourceParentRevision',
    );
  }
  if (targetParent.childrenRevision !== validated.baseTargetParentRevision) {
    throw new NodeConflictError(
      'position_context_stale',
      'target parent children revision does not match baseTargetParentRevision',
    );
  }

  const now = await ports.clock.now();
  const operationId = validated.operationId ?? generateOpaqueId();
  const mutation = await ports.canonical.execute({
    operationId,
    collectionId: validated.collectionId,
    actor: {
      principalId: validated.actor.principalId,
      principalType: validated.actor.principalType,
    },
    mutation: {
      action: 'move',
      target: {
        collectionId: validated.collectionId,
        resourceId: validated.nodeId,
        resourceKind: 'node',
      },
      parentId: validated.newParentId,
      relativePosition: {
        ...(validated.afterId ? { afterId: validated.afterId } : {}),
        ...(validated.beforeId ? { beforeId: validated.beforeId } : {}),
      },
      expectedResourceRevision: node.resourceRevision,
      fields: {
        kindFields: {
          kind: node.kind,
          title: node.title,
          url: node.url,
          description: node.description,
          tags: node.tags,
          visibility: node.visibility,
        },
        extensions: {},
      },
    },
  });
  const resourceRevision = mutation.allocation.resourceRevision!;
  const contentRevision = mutation.allocation.contentRevision!;
  const sourceChildrenRevision = mutation.allocation.childrenRevisions[sourceParentId]!;
  const targetChildrenRevision = mutation.allocation.childrenRevisions[validated.newParentId]!;
  const positionToken = mutation.allocation.positionToken!;
  const policyRevision = mutation.allocation.policyRevision ?? locked.policyRevision;
  const commitOrdinal = mutation.allocation.commitOrdinal;

  const iconUrl = node.kind === 'bookmark'
    ? await projectBookmarkIconUrl(ports.bookmarkIcons, validated.nodeId, ports.productOrigin)
    : null;
  const nodeView = projectEditableNodeView({
    id: node.id,
    collectionId: node.collectionId,
    parentId: validated.newParentId,
    kind: node.kind,
    title: node.title,
    url: node.url,
    description: node.description,
    tags: node.tags,
    visibility: node.visibility,
    position: positionToken,
    resourceRevision,
    childrenRevision: node.childrenRevision,
    createdAt: node.createdAt,
    updatedAt: now,
    iconUrl,
  });

  const sourceParentState: ParentStateSnapshot = {
    id: sourceParentId,
    childrenRevision: sourceChildrenRevision,
    childrenEtag: strongEntityTag(sourceChildrenRevision),
  };
  const targetParentState: ParentStateSnapshot = {
    id: validated.newParentId,
    childrenRevision: targetChildrenRevision,
    childrenEtag: strongEntityTag(targetChildrenRevision),
  };
  const fence: CollectionFenceSnapshot = {
    contentRevision,
    contentEtag: strongEntityTag(contentRevision),
    policyRevision,
    policyEtag: strongEntityTag(policyRevision),
  };

  const productResult = buildProductResult(
    nodeView,
    sourceParentState,
    targetParentState,
    fence,
  );
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult);

  return {
    kind: 'moved',
    node: nodeView,
    sourceParent: sourceParentState,
    targetParent: targetParentState,
    fence,
    operationId,
    commitOrdinal,
  };
}

// ---------------------------------------------------------------------------
// Validation / placement / cycle
// ---------------------------------------------------------------------------

interface ValidatedMoveCollectionNodeInput {
  readonly actor: MoveCollectionNodeActor;
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly collectionId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
  readonly newParentId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly baseSourceParentRevision: string;
  readonly baseTargetParentRevision: string;
  readonly operationId?: string;
}

function validateInput(input: MoveCollectionNodeInput): ValidatedMoveCollectionNodeInput {
  if (!input || typeof input !== 'object') {
    throw new CollectionsError('invalid_node_input', 'input is required');
  }
  if (!input.actor || typeof input.actor !== 'object') {
    throw new CollectionsError('invalid_node_input', 'actor is required');
  }
  if (!input.command || typeof input.command !== 'object') {
    throw new CollectionsError('invalid_node_input', 'command is required');
  }
  if (input.actor.principalType !== 'account') {
    throw new CollectionsError('invalid_node_input', 'actor.principalType must be account');
  }

  const principalId = assertNonEmptyField(input.actor.principalId, 'actor.principalId');
  const subjectId = assertNonEmptyField(input.actor.subjectId, 'actor.subjectId');
  const commandId = assertCanonicalCommandId(
    assertNonEmptyField(input.command.commandId, 'command.commandId'),
  );
  const fingerprint = assertNonEmptyField(input.command.fingerprint, 'command.fingerprint');
  const collectionId = assertNonEmptyField(input.collectionId, 'collectionId');
  const nodeId = assertNonEmptyField(input.nodeId, 'nodeId');
  const ifMatch = assertNonEmptyField(input.ifMatch, 'ifMatch');
  const newParentId = assertNonEmptyField(input.newParentId, 'newParentId');
  const baseSourceParentRevision = assertNonEmptyField(
    input.baseSourceParentRevision,
    'baseSourceParentRevision',
  );
  const baseTargetParentRevision = assertNonEmptyField(
    input.baseTargetParentRevision,
    'baseTargetParentRevision',
  );
  const commandScope = input.command.commandScope?.trim()
    ? input.command.commandScope
    : moveCollectionNodeCommandScope(collectionId, nodeId);
  assertNonEmptyField(commandScope, 'command.commandScope');

  if (input.afterId !== null && typeof input.afterId !== 'string') {
    throw new CollectionsError('invalid_node_anchor', 'afterId must be a string or null');
  }
  if (input.beforeId !== null && typeof input.beforeId !== 'string') {
    throw new CollectionsError('invalid_node_anchor', 'beforeId must be a string or null');
  }
  if (typeof input.afterId === 'string' && input.afterId.trim().length === 0) {
    throw new CollectionsError('invalid_node_anchor', 'afterId cannot be empty');
  }
  if (typeof input.beforeId === 'string' && input.beforeId.trim().length === 0) {
    throw new CollectionsError('invalid_node_anchor', 'beforeId cannot be empty');
  }

  return {
    actor: {
      principalId,
      principalType: 'account',
      subjectId,
    },
    command: { commandId, fingerprint, commandScope },
    collectionId,
    nodeId,
    ifMatch,
    newParentId,
    afterId: input.afterId,
    beforeId: input.beforeId,
    baseSourceParentRevision,
    baseTargetParentRevision,
    operationId: input.operationId,
  };
}

function assertValidStructuralParent(
  parent: LockedNodeRow | null,
  collectionId: string,
  label: string,
): asserts parent is LockedNodeRow {
  if (!parent || parent.collectionId !== collectionId) {
    throw new CollectionsError(
      'invalid_node_parent',
      `${label} must be a live Root or Folder in the same collection`,
    );
  }
  if (parent.deletedAt !== null) {
    throw new CollectionsError(
      'invalid_node_parent',
      `${label} must not be deleted`,
    );
  }
  if (parent.kind !== 'folder') {
    throw new CollectionsError(
      'invalid_node_parent',
      `${label} must be a folder or root`,
    );
  }
}

/**
 * Folder move: new parent must not be the node itself or any descendant.
 * Walks from newParent toward root; if the moving node is encountered, cycle.
 */
async function assertNoFolderCycle(
  ports: ProductCollectionCanonicalPorts,
  collectionId: string,
  nodeId: string,
  newParentId: string,
): Promise<void> {
  if (newParentId === nodeId) {
    throw new CollectionsError('invalid_node_input', 'parent ancestry already contains a cycle');
  }
  if (!ports.nodes.readParentAncestry) {
    throw new CollectionsError('invalid_node_parent', 'newParent ancestry reader is unavailable');
  }
  const rows = await ports.nodes.readParentAncestry(collectionId, newParentId, MAX_PARENT_ANCESTRY_DEPTH);
  const result = classifyParentAncestry(rows.map((row, depth) => ({
    id: row.id, parentId: row.parentId, depth, isRoot: row.isRoot,
    kind: row.kind, collectionId: row.collectionId, deletedAt: row.deletedAt,
  })), collectionId, nodeId, newParentId, true);
  if (result.ok) return;
  if (result.code === 'target') throw new CollectionsError('invalid_node_parent', 'newParent must not be a descendant of the moved folder (would create a cycle)');
  if (result.code === 'cycle') throw new CollectionsError('invalid_node_input', 'parent ancestry already contains a cycle');
  if (result.code === 'depth') throw new CollectionsError('invalid_node_parent', 'newParent ancestry exceeds maximum depth');
  throw new CollectionsError('invalid_node_parent', 'newParent ancestry is incomplete or deleted');
}

// ---------------------------------------------------------------------------
// Snapshots / product result
// ---------------------------------------------------------------------------

function buildProductResult(
  node: EditableNodeView,
  sourceParent: ParentStateSnapshot,
  targetParent: ParentStateSnapshot,
  fence: CollectionFenceSnapshot,
): ProductCommandResult {
  const bodyObject = {
    node,
    sourceParent: {
      id: sourceParent.id,
      childrenRevision: sourceParent.childrenRevision,
      childrenEtag: sourceParent.childrenEtag,
    },
    targetParent: {
      id: targetParent.id,
      childrenRevision: targetParent.childrenRevision,
      childrenEtag: targetParent.childrenEtag,
    },
    fence: {
      contentRevision: fence.contentRevision,
      contentEtag: fence.contentEtag,
      policyRevision: fence.policyRevision,
      policyEtag: fence.policyEtag,
    },
  };
  const bodyText = JSON.stringify(bodyObject);
  return {
    status: 200,
    body: new TextEncoder().encode(bodyText),
    stableHeaders: {
      etag: node.etag,
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: MOVE_COLLECTION_NODE_CONTRACT_VERSION,
    targetIdentity: node.id,
  };
}

/** Closed payload for node.moved@1 — fail closed before outbox insert. */
export function assertNodeMovedPayload(payload: unknown): asserts payload is {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly sourceParentId: string;
  readonly targetParentId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly sourceChildrenRevision: string;
  readonly targetChildrenRevision: string;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CollectionsError('invalid_node_input', 'node.moved payload must be an object');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'collectionId',
    'contentRevision',
    'kind',
    'nodeId',
    'policyRevision',
    'resourceRevision',
    'sourceChildrenRevision',
    'sourceParentId',
    'targetChildrenRevision',
    'targetParentId',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CollectionsError(
      'invalid_node_input',
      'node.moved payload must be a closed object',
    );
  }
  for (const key of expected) {
    const value = record[key];
    if (typeof value !== 'string' || value.length < 1) {
      throw new CollectionsError(
        'invalid_node_input',
        `node.moved payload.${key} must be a non-empty string`,
      );
    }
  }
}

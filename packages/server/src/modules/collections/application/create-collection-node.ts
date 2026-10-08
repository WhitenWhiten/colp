import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  CollectionAuthorizationError,
  CollectionsError,
  assertNonEmptyField,
  assertValidHttpUrlNoUserInfo,
  assertValidNodeDescription,
  assertValidNodeKind,
  assertValidNodeTags,
  assertValidNodeTitle,
  assertValidNodeVisibility,
  generateOpaqueId,
  strongEntityTag,
  type NodeKind,
  type NodeVisibility,
} from '../domain/index.js';
import type {
  ProductCollectionCanonicalPorts,
  LockedNodeRow,
} from './ports.js';
import type { EditableNodeView } from './get-editor-page.js';
import { projectBookmarkIconUrl } from './bookmark-icon-url.js';
import { enqueueFaviconRefreshForNewBookmark } from './favicon-job.js';
import {
  authorizeCollectionCapability,
  claimProductMutation,
  projectEditableNodeView,
} from './product-mutation-admission.js';

export function createCollectionNodeCommandScope(collectionId: string): string {
  return `collection:${collectionId}:node:create`;
}

export const CREATE_COLLECTION_NODE_COMMAND_SCOPE =
  'collection:{collectionId}:node:create';
export const CREATE_COLLECTION_NODE_CONTRACT_VERSION = '1.0.0';
export const CREATE_COLLECTION_NODE_OPERATION_TYPE = 'create_collection_node';
export const NODE_RESTORED_EVENT_TYPE = 'node.restored';
export const NODE_RESTORED_EVENT_VERSION = 1;
export const NODE_RESTORED_HANDLER_NAME = 'node_restored_projection';

export const NODE_CREATED_EVENT_TYPE = 'node.created';
export const NODE_CREATED_EVENT_VERSION = 1;
export const NODE_CREATED_HANDLER_NAME = 'node_created_projection';

export interface CreateCollectionNodeActor {
  readonly principalId: string;
  readonly principalType: 'account';
  readonly subjectId: string;
}

export interface CreateCollectionNodeCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  /** Defaults to a transport-neutral node-create intent for the collection. */
  readonly commandScope?: string;
}

export interface FolderCreateInput {
  readonly kind: 'folder';
  readonly title: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
}

export interface BookmarkCreateInput {
  readonly kind: 'bookmark';
  readonly title: string;
  readonly url: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
}

export type NodeCreateInput = FolderCreateInput | BookmarkCreateInput;

export interface CreateCollectionNodeInput {
  readonly actor: CreateCollectionNodeActor;
  readonly command: CreateCollectionNodeCommand;
  readonly collectionId: string;
  readonly parentId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly node: NodeCreateInput;
  /** Optional overrides for deterministic tests only. */
  readonly nodeId?: string;
  readonly operationId?: string;
}

export interface ParentStateSnapshot {
  readonly id: string;
  readonly childrenRevision: string;
  readonly childrenEtag: string;
}

export interface CollectionFenceSnapshot {
  readonly contentRevision: string;
  readonly contentEtag: string;
  readonly policyRevision: string;
  readonly policyEtag: string;
}

export type CreateCollectionNodeResult =
  | {
      readonly kind: 'created';
      readonly node: EditableNodeView;
      readonly parent: ParentStateSnapshot;
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
 * ADR-0002 / docs matrix: Node create in one Collection-locked transaction.
 * claim → lock collection → authorize create_node → validate parent/anchors
 * → allocate position (rebalance if needed) → insert node + revisions
 * → Operation/Audit/Outbox → complete product receipt (201 CreateNodeResult).
 */
export async function createCollectionNode(
  ports: ProductCollectionCanonicalPorts,
  input: CreateCollectionNodeInput,
): Promise<CreateCollectionNodeResult> {
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
    capability: 'create_node',
  }, locked);

  const parent = await ports.nodes.getNode(validated.collectionId, validated.parentId);
  assertValidParent(parent, validated.collectionId);

  const now = await ports.clock.now();
  const nodeId = validated.nodeId ?? generateOpaqueId();
  const operationId = validated.operationId ?? generateOpaqueId();
  const nodeUrl = validated.node.kind === 'bookmark' ? validated.node.url : null;
  const mutation = await ports.canonical.execute({
    operationId,
    collectionId: validated.collectionId,
    actor: {
      principalId: validated.actor.principalId,
      principalType: validated.actor.principalType,
    },
    mutation: {
      action: 'create',
      target: { collectionId: validated.collectionId, resourceId: nodeId, resourceKind: 'node' },
      parentId: validated.parentId,
      relativePosition: {
        ...(validated.afterId ? { afterId: validated.afterId } : {}),
        ...(validated.beforeId ? { beforeId: validated.beforeId } : {}),
      },
      fields: {
        kindFields: {
          kind: validated.node.kind,
          title: validated.node.title,
          url: nodeUrl,
          description: validated.node.description,
          tags: validated.node.tags,
          visibility: validated.node.visibility,
        },
        extensions: {},
      },
    },
  });
  const { allocation } = mutation;
  const resourceRevision = allocation.resourceRevision!;
  const childrenRevisionForNew = allocation.createdNodeChildrenRevision!;
  const parentChildrenRevision = allocation.childrenRevisions[validated.parentId]!;
  const contentRevision = allocation.contentRevision!;
  const policyRevision = allocation.policyRevision ?? locked.policyRevision;
  const positionToken = allocation.positionToken!;

  const iconUrl = validated.node.kind === 'bookmark'
    ? await projectBookmarkIconUrl(ports.bookmarkIcons, nodeId, ports.productOrigin)
    : null;
  // FO-07: `newDefault: online` must actually fetch for a bookmark created in
  // the Web app. The durable job is inserted in this same transaction (before
  // the receipt completes), so a crash cannot leave a created node without its
  // promised fetch and a retry can never double-enqueue.
  if (validated.node.kind === 'bookmark' && nodeUrl !== null && ports.faviconAutoRefresh !== undefined) {
    await enqueueFaviconRefreshForNewBookmark(ports.faviconAutoRefresh, {
      accountId: validated.actor.principalId,
      ownerSubjectId: validated.actor.subjectId,
      collectionId: validated.collectionId,
      nodeId,
      url: nodeUrl,
      nodeResourceRevision: resourceRevision,
      now,
    });
  }
  const nodeView = projectEditableNodeView({
    id: nodeId,
    collectionId: validated.collectionId,
    parentId: validated.parentId,
    kind: validated.node.kind,
    title: validated.node.title,
    url: nodeUrl,
    description: validated.node.description,
    tags: validated.node.tags,
    visibility: validated.node.visibility,
    position: positionToken,
    resourceRevision,
    childrenRevision: childrenRevisionForNew,
    createdAt: now,
    updatedAt: now,
    iconUrl,
  });

  const parentState: ParentStateSnapshot = {
    id: validated.parentId,
    childrenRevision: parentChildrenRevision,
    childrenEtag: strongEntityTag(parentChildrenRevision),
  };
  const fence: CollectionFenceSnapshot = {
    contentRevision,
    contentEtag: strongEntityTag(contentRevision),
    policyRevision,
    policyEtag: strongEntityTag(policyRevision),
  };

  const productResult = buildProductResult(nodeView, parentState, fence);
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult);

  return {
    kind: 'created',
    node: nodeView,
    parent: parentState,
    fence,
    operationId,
    commitOrdinal: allocation.commitOrdinal,
  };
}

// ---------------------------------------------------------------------------
// Validation / placement
// ---------------------------------------------------------------------------

interface ValidatedCreateCollectionNodeInput {
  readonly actor: CreateCollectionNodeActor;
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly collectionId: string;
  readonly parentId: string;
  readonly afterId: string | null;
  readonly beforeId: string | null;
  readonly node: NodeCreateInput;
  readonly nodeId?: string;
  readonly operationId?: string;
}

function validateInput(input: CreateCollectionNodeInput): ValidatedCreateCollectionNodeInput {
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
  const parentId = assertNonEmptyField(input.parentId, 'parentId');
  const commandScope = input.command.commandScope?.trim()
    ? input.command.commandScope
    : createCollectionNodeCommandScope(collectionId);
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

  const node = validateNodeCreate(input.node);

  return {
    actor: {
      principalId,
      principalType: 'account',
      subjectId,
    },
    command: { commandId, fingerprint, commandScope },
    collectionId,
    parentId,
    afterId: input.afterId,
    beforeId: input.beforeId,
    node,
    nodeId: input.nodeId,
    operationId: input.operationId,
  };
}

function validateNodeCreate(node: unknown): NodeCreateInput {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new CollectionsError('invalid_node_input', 'node is required');
  }
  const record = node as Record<string, unknown>;
  const kind = assertValidNodeKind(
    typeof record.kind === 'string' ? record.kind : '',
  );

  if (kind === 'folder') {
    const allowed = new Set(['kind', 'title', 'description', 'tags', 'visibility']);
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) {
        throw new CollectionsError(
          'invalid_node_input',
          `node property "${key}" is not allowed for folder`,
        );
      }
    }
    for (const required of ['kind', 'title', 'description', 'tags', 'visibility'] as const) {
      if (!Object.hasOwn(record, required)) {
        throw new CollectionsError('invalid_node_input', `node.${required} is required`);
      }
    }
    if (Object.hasOwn(record, 'url')) {
      throw new CollectionsError('invalid_node_input', 'folder cannot include url');
    }
    if (typeof record.title !== 'string') {
      throw new CollectionsError('invalid_node_title', 'title must be a string');
    }
    if (record.description !== null && typeof record.description !== 'string') {
      throw new CollectionsError('invalid_node_description', 'description must be a string or null');
    }
    if (!Array.isArray(record.tags)) {
      throw new CollectionsError('invalid_node_tags', 'tags must be an array');
    }
    if (typeof record.visibility !== 'string') {
      throw new CollectionsError('invalid_node_visibility', 'visibility must be a string');
    }
    return {
      kind: 'folder',
      title: assertValidNodeTitle(record.title),
      description: assertValidNodeDescription(record.description as string | null),
      tags: assertValidNodeTags(record.tags as readonly string[]),
      visibility: assertValidNodeVisibility(record.visibility),
    };
  }

  // bookmark
  const allowed = new Set(['kind', 'title', 'url', 'description', 'tags', 'visibility']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new CollectionsError(
        'invalid_node_input',
        `node property "${key}" is not allowed for bookmark`,
      );
    }
  }
  for (const required of ['kind', 'title', 'url', 'description', 'tags', 'visibility'] as const) {
    if (!Object.hasOwn(record, required)) {
      throw new CollectionsError('invalid_node_input', `node.${required} is required`);
    }
  }
  if (typeof record.title !== 'string') {
    throw new CollectionsError('invalid_node_title', 'title must be a string');
  }
  if (typeof record.url !== 'string') {
    throw new CollectionsError('invalid_node_url', 'url must be a string');
  }
  if (record.description !== null && typeof record.description !== 'string') {
    throw new CollectionsError('invalid_node_description', 'description must be a string or null');
  }
  if (!Array.isArray(record.tags)) {
    throw new CollectionsError('invalid_node_tags', 'tags must be an array');
  }
  if (typeof record.visibility !== 'string') {
    throw new CollectionsError('invalid_node_visibility', 'visibility must be a string');
  }
  return {
    kind: 'bookmark',
    title: assertValidNodeTitle(record.title),
    url: assertValidHttpUrlNoUserInfo(record.url),
    description: assertValidNodeDescription(record.description as string | null),
    tags: assertValidNodeTags(record.tags as readonly string[]),
    visibility: assertValidNodeVisibility(record.visibility),
  };
}

function assertValidParent(
  parent: LockedNodeRow | null,
  collectionId: string,
): asserts parent is LockedNodeRow {
  if (!parent || parent.collectionId !== collectionId) {
    throw new CollectionsError(
      'invalid_node_parent',
      'parent must be a live Root or Folder in the same collection',
    );
  }
  if (parent.deletedAt !== null) {
    throw new CollectionsError(
      'invalid_node_parent',
      'parent must not be deleted',
    );
  }
  if (parent.kind !== 'folder') {
    throw new CollectionsError(
      'invalid_node_parent',
      'parent must be a folder or root',
    );
  }
}

// ---------------------------------------------------------------------------
// Snapshots / product result
// ---------------------------------------------------------------------------

function buildProductResult(
  node: EditableNodeView,
  parent: ParentStateSnapshot,
  fence: CollectionFenceSnapshot,
): ProductCommandResult {
  const bodyObject = {
    node,
    parent: {
      id: parent.id,
      childrenRevision: parent.childrenRevision,
      childrenEtag: parent.childrenEtag,
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
    status: 201,
    body: new TextEncoder().encode(bodyText),
    stableHeaders: {
      location: `/api/v1/collections/${node.collectionId}/nodes/${node.id}`,
      etag: node.etag,
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: CREATE_COLLECTION_NODE_CONTRACT_VERSION,
    targetIdentity: node.id,
  };
}

/** Closed payload for node.created@1 — fail closed before outbox insert. */
export function assertNodeCreatedPayload(payload: unknown): asserts payload is {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly parentId: string;
  readonly kind: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly parentChildrenRevision: string;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CollectionsError('invalid_node_input', 'node.created payload must be an object');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'collectionId',
    'contentRevision',
    'kind',
    'nodeId',
    'parentChildrenRevision',
    'parentId',
    'policyRevision',
    'resourceRevision',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CollectionsError(
      'invalid_node_input',
      'node.created payload must be a closed object',
    );
  }
  for (const key of expected) {
    const value = record[key];
    if (typeof value !== 'string' || value.length < 1) {
      throw new CollectionsError(
        'invalid_node_input',
        `node.created payload.${key} must be a non-empty string`,
      );
    }
  }
}

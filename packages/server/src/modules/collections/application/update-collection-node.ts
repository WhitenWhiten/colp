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
  assertValidHttpUrlNoUserInfo,
  assertValidNodeDescription,
  assertValidNodeTags,
  assertValidNodeTitle,
  assertValidNodeVisibility,
  generateOpaqueId,
  isEquivalentBookmarkUrlRewrite,
  strongEntityTag,
  type NodeVisibility,
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
import { ifMatchSatisfied } from './update-collection-metadata.js';
import type { CollectionFenceSnapshot } from './create-collection-node.js';

export function updateCollectionNodeCommandScope(
  collectionId: string,
  nodeId: string,
): string {
  return `collection:${collectionId}:node:${nodeId}:update`;
}

export const UPDATE_COLLECTION_NODE_COMMAND_SCOPE =
  'collection:{collectionId}:node:{nodeId}:update';
export const UPDATE_COLLECTION_NODE_CONTRACT_VERSION = '1.0.0';
export const UPDATE_COLLECTION_NODE_OPERATION_TYPE = 'update_collection_node';
export const NODE_UPDATED_EVENT_TYPE = 'node.updated';
export const NODE_UPDATED_EVENT_VERSION = 1;
export const NODE_UPDATED_HANDLER_NAME = 'node_updated_projection';

export interface UpdateCollectionNodeActor {
  readonly principalId: string;
  readonly principalType: 'account';
  readonly subjectId: string;
}

export interface UpdateCollectionNodeCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  /** Defaults to a transport-neutral node-update intent. */
  readonly commandScope?: string;
}

/**
 * RFC 7396 merge patch — at least one property after validation.
 * null deletes optional description/tags/visibility override.
 */
export interface NodeMergePatch {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string | null;
  readonly tags?: readonly string[] | null;
  readonly visibility?: NodeVisibility | null;
}

export interface UpdateCollectionNodeInput {
  readonly actor: UpdateCollectionNodeActor;
  readonly command: UpdateCollectionNodeCommand;
  readonly collectionId: string;
  readonly nodeId: string;
  /**
   * Strong entity-tag (`"revision"`) or bare revision token from If-Match.
   * Missing If-Match is a transport concern (428); application only compares.
   */
  readonly ifMatch: string;
  readonly patch: NodeMergePatch;
  /** Optional overrides for deterministic tests only. */
  readonly operationId?: string;
}

export type UpdateCollectionNodeResult =
  | {
      readonly kind: 'updated';
      readonly node: EditableNodeView;
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
 * ADR-0002 / docs matrix: Node content update in one Collection-locked transaction.
 * claim → lock collection → authorize update_node → load node → If-Match
 * → merge patch → resource+content (+policy if visibility) → Operation/Audit/Outbox
 * → complete product receipt (200 UpdateNodeResult + ETag).
 */
export async function updateCollectionNode(
  ports: ProductCollectionCanonicalPorts,
  input: UpdateCollectionNodeInput,
): Promise<UpdateCollectionNodeResult> {
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
    capability: 'update_node',
  }, locked);

  const node = await ports.nodes.getNode(validated.collectionId, validated.nodeId);
  if (!node || node.deletedAt !== null) {
    // Conceal missing/deleted nodes the same way as missing collections.
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  if (node.isRoot) {
    throw new NodeConflictError('root_immutable');
  }

  if (!ifMatchSatisfied(validated.ifMatch, node.resourceRevision)) {
    throw new CollectionPreconditionError({
      currentEtag: strongEntityTag(node.resourceRevision),
    });
  }

  const merged = applyMergePatch(node, validated.patch);

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
      action: 'update',
      target: {
        collectionId: validated.collectionId,
        resourceId: validated.nodeId,
        resourceKind: 'node',
      },
      parentId: node.parentId,
      expectedResourceRevision: node.resourceRevision,
      fields: {
        kindFields: {
          kind: node.kind,
          title: merged.title,
          url: merged.url,
          description: merged.description,
          tags: merged.tags,
          visibility: merged.visibility,
        },
        extensions: {},
      },
    },
  });
  const resourceRevision = mutation.allocation.resourceRevision!;
  const contentRevision = mutation.allocation.contentRevision!;
  const policyRevision = mutation.allocation.policyRevision ?? locked.policyRevision;

  const iconUrl = node.kind === 'bookmark'
    ? await projectBookmarkIconUrl(ports.bookmarkIcons, validated.nodeId, ports.productOrigin)
    : null;
  const nodeView = projectEditableNodeView({
    id: node.id,
    collectionId: node.collectionId,
    parentId: node.parentId as string,
    kind: node.kind,
    title: merged.title,
    url: merged.url,
    description: merged.description,
    tags: merged.tags,
    visibility: merged.visibility,
    position: node.positionToken as string,
    resourceRevision,
    childrenRevision: node.childrenRevision,
    createdAt: node.createdAt,
    updatedAt: now,
    iconUrl,
  });

  const fence: CollectionFenceSnapshot = {
    contentRevision,
    contentEtag: strongEntityTag(contentRevision),
    policyRevision,
    policyEtag: strongEntityTag(policyRevision),
  };

  const productResult = buildProductResult(nodeView, fence);
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult);

  return {
    kind: 'updated',
    node: nodeView,
    fence,
    operationId,
    commitOrdinal: mutation.allocation.commitOrdinal,
  };
}

// ---------------------------------------------------------------------------
// Validation / merge
// ---------------------------------------------------------------------------

interface ValidatedUpdateCollectionNodeInput {
  readonly actor: UpdateCollectionNodeActor;
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly collectionId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
  readonly patch: NodeMergePatch;
  readonly operationId?: string;
}

function validateInput(input: UpdateCollectionNodeInput): ValidatedUpdateCollectionNodeInput {
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
  const commandScope = input.command.commandScope?.trim()
    ? input.command.commandScope
    : updateCollectionNodeCommandScope(collectionId, nodeId);
  assertNonEmptyField(commandScope, 'command.commandScope');

  const patch = validateMergePatch(input.patch);

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
    patch,
    operationId: input.operationId,
  };
}

function validateMergePatch(patch: unknown): NodeMergePatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new CollectionsError('invalid_node_patch', 'patch is required');
  }

  const record = patch as Record<string, unknown>;
  const allowed = new Set(['title', 'url', 'description', 'tags', 'visibility']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new CollectionsError(
        'invalid_node_patch',
        `patch property "${key}" is not allowed`,
      );
    }
  }

  const hasTitle = Object.hasOwn(record, 'title');
  const hasUrl = Object.hasOwn(record, 'url');
  const hasDescription = Object.hasOwn(record, 'description');
  const hasTags = Object.hasOwn(record, 'tags');
  const hasVisibility = Object.hasOwn(record, 'visibility');

  if (!hasTitle && !hasUrl && !hasDescription && !hasTags && !hasVisibility) {
    throw new CollectionsError(
      'invalid_node_patch',
      'patch must include at least one of title, url, description, tags, visibility',
    );
  }

  const result: {
    title?: string;
    url?: string;
    description?: string | null;
    tags?: readonly string[] | null;
    visibility?: NodeVisibility | null;
  } = {};

  if (hasTitle) {
    if (record.title === null || record.title === undefined) {
      throw new CollectionsError('invalid_node_title', 'title cannot be null');
    }
    if (typeof record.title !== 'string') {
      throw new CollectionsError('invalid_node_title', 'title must be a string');
    }
    result.title = assertValidNodeTitle(record.title);
  }

  if (hasUrl) {
    if (record.url === null || record.url === undefined) {
      throw new CollectionsError('invalid_node_url', 'url cannot be null');
    }
    if (typeof record.url !== 'string') {
      throw new CollectionsError('invalid_node_url', 'url must be a string');
    }
    result.url = assertValidHttpUrlNoUserInfo(record.url);
  }

  if (hasDescription) {
    if (record.description !== null && typeof record.description !== 'string') {
      throw new CollectionsError(
        'invalid_node_description',
        'description must be a string or null',
      );
    }
    result.description = assertValidNodeDescription(record.description as string | null);
  }

  if (hasTags) {
    if (record.tags === null) {
      result.tags = null;
    } else if (Array.isArray(record.tags)) {
      result.tags = assertValidNodeTags(record.tags as readonly string[]);
    } else {
      throw new CollectionsError('invalid_node_tags', 'tags must be an array or null');
    }
  }

  if (hasVisibility) {
    if (record.visibility === null) {
      result.visibility = null;
    } else if (typeof record.visibility === 'string') {
      result.visibility = assertValidNodeVisibility(record.visibility);
    } else {
      throw new CollectionsError(
        'invalid_node_visibility',
        'visibility must be a string or null',
      );
    }
  }

  return result;
}

interface MergedNodeContent {
  readonly title: string;
  readonly url: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly visibility: NodeVisibility;
  readonly visibilityChanged: boolean;
}

function applyMergePatch(node: LockedNodeRow, patch: NodeMergePatch): MergedNodeContent {
  if (node.kind === 'folder' && patch.url !== undefined) {
    throw new CollectionsError(
      'invalid_node_patch',
      'folder cannot set url',
    );
  }

  const title = patch.title !== undefined ? patch.title : node.title;
  const description = patch.description !== undefined ? patch.description : node.description;
  const tags = patch.tags !== undefined
    ? (patch.tags === null ? [] : patch.tags)
    : node.tags;

  let visibility: NodeVisibility;
  if (patch.visibility !== undefined) {
    // null deletes override → inherit
    visibility = patch.visibility === null ? 'inherit' : patch.visibility;
  } else {
    visibility = node.visibility;
  }

  let url: string | null;
  if (node.kind === 'bookmark') {
    url = patch.url !== undefined ? patch.url : node.url;
    if (typeof url !== 'string' || url.length < 1) {
      throw new CollectionsError('invalid_node_url', 'bookmark url is required');
    }
    // CS-01 generation fence: a normalization-equivalent rewrite is not a
    // content change — the stored string wins so the response, the
    // canonical write, and the generation fence all keep the original URL.
    if (typeof node.url === 'string' && isEquivalentBookmarkUrlRewrite(node.url, url)) {
      url = node.url;
    }
  } else {
    url = null;
  }

  return {
    title,
    url,
    description,
    tags,
    visibility,
    visibilityChanged: visibility !== node.visibility,
  };
}

// ---------------------------------------------------------------------------
// Snapshots / product result
// ---------------------------------------------------------------------------

function buildProductResult(
  node: EditableNodeView,
  fence: CollectionFenceSnapshot,
): ProductCommandResult {
  const bodyObject = {
    node,
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
    contractVersion: UPDATE_COLLECTION_NODE_CONTRACT_VERSION,
    targetIdentity: node.id,
  };
}

/** Closed payload for node.updated@1 — fail closed before outbox insert. */
export function assertNodeUpdatedPayload(payload: unknown): asserts payload is {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CollectionsError('invalid_node_input', 'node.updated payload must be an object');
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
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CollectionsError(
      'invalid_node_input',
      'node.updated payload must be a closed object',
    );
  }
  for (const key of expected) {
    const value = record[key];
    if (typeof value !== 'string' || value.length < 1) {
      throw new CollectionsError(
        'invalid_node_input',
        `node.updated payload.${key} must be a non-empty string`,
      );
    }
  }
}

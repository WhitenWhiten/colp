import {
  type AccessPolicyFactsPort,
} from '../../access-policy/index.js';
import {
  authorizeCollectionCapability,
} from './product-mutation-admission.js';
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
  formatUtcDateTime,
  generateOpaqueId,
  strongEntityTag,
} from '../domain/index.js';
import type {
  LockedCollectionRow,
  ProductCollectionCanonicalPorts,
} from './ports.js';
import {
  type CollectionFenceSnapshot,
  type ParentStateSnapshot,
} from './create-collection-node.js';
import { ifMatchSatisfied } from './update-collection-metadata.js';

/** Minimum tombstone / receipt purge retention (protocol-aligned 30 exact 24h days). */
export const NODE_DELETION_PURGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function deleteCollectionNodeCommandScope(
  collectionId: string,
  nodeId: string,
): string {
  return `collection:${collectionId}:node:${nodeId}:delete`;
}

export const DELETE_COLLECTION_NODE_COMMAND_SCOPE =
  'collection:{collectionId}:node:{nodeId}:delete';
export const DELETE_COLLECTION_NODE_CONTRACT_VERSION = '1.0.0';
export const DELETE_COLLECTION_NODE_OPERATION_TYPE = 'delete_collection_node';
export const NODE_DELETED_EVENT_TYPE = 'node.deleted';
export const NODE_DELETED_EVENT_VERSION = 1;
export const NODE_DELETED_HANDLER_NAME = 'node_deleted_projection';

export interface DeleteCollectionNodeActor {
  readonly principalId: string;
  readonly principalType: 'account';
  readonly subjectId: string;
}

export interface DeleteCollectionNodeCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  /** Defaults to a transport-neutral node-delete intent. */
  readonly commandScope?: string;
}

export interface DeleteCollectionNodeInput {
  readonly actor: DeleteCollectionNodeActor;
  readonly command: DeleteCollectionNodeCommand;
  readonly collectionId: string;
  readonly nodeId: string;
  /**
   * Strong entity-tag (`"revision"`) or bare revision token from If-Match.
   * Missing If-Match is a transport concern (428); application only compares.
   */
  readonly ifMatch: string;
  /**
   * When true, delete Folder subtree. Requires ifContentMatch.
   * Transport must reject invalid recursive query and wrong header combos.
   */
  readonly recursive: boolean;
  /**
   * Collection content ETag from If-Content-Match when recursive=true.
   * Must be null/undefined for non-recursive deletes (transport rejects otherwise).
   */
  readonly ifContentMatch?: string | null;
  /** Optional overrides for deterministic tests only. */
  readonly operationId?: string;
}

export type DeletionScope = 'single' | 'subtree';

export interface DeletionReceiptSnapshot {
  readonly resourceType: 'node';
  readonly targetId: string;
  readonly collectionId: string;
  readonly scope: DeletionScope;
  readonly deletedAt: string;
  /**
   * Tombstone revision of the deleted target (the request target; for
   * scope=subtree, the subtree root), not the collection content fence.
   * The collection fence is returned separately in the result `fence` field.
   */
  readonly deleteRevision: string;
  readonly operationId: string;
  readonly affectedCount: number;
  readonly purgeAfter: string;
}

export type DeleteCollectionNodeResult =
  | {
      readonly kind: 'deleted';
      readonly receipt: DeletionReceiptSnapshot;
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
 * ADR-0002 / docs matrix: Node or explicit subtree soft-delete in one Collection-locked TX.
 * claim → lock collection → authorize delete_node → load node (root_immutable)
 * → If-Match → recursive/content rules → canonical planner selects descendants → soft-delete
 * → advance parent children + content fence → Operation/Audit/Outbox node.deleted
 * → complete product receipt (200 DeleteNodeResult; no deleted-resource ETag).
 *
 * ID ledger is never released. One canonical operation writes every subtree tombstone.
 */
export async function deleteCollectionNode(
  ports: ProductCollectionCanonicalPorts,
  input: DeleteCollectionNodeInput,
): Promise<DeleteCollectionNodeResult> {
  const validated = validateInput(input);
  const binding: ProductCommandBinding = {
    principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope,
    commandId: validated.command.commandId,
  };

  const claim = await ports.receipts.claim(binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') {
    return mapNonClaimed(claim);
  }

  const locked = await ports.collections.lockForUpdate(validated.collectionId);
  if (!locked) {
    throw new CollectionAuthorizationError({
      outcome: 'conceal',
      reasonCategory: 'resource_missing',
    });
  }

  await authorizeDelete(ports.accessPolicy, validated, locked);

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
      precondition: 'resource',
    });
  }

  // Domain header combo / kind rules (transport also enforces common cases).
  if (validated.recursive) {
    if (node.kind === 'bookmark') {
      throw new CollectionsError(
        'invalid_node_delete',
        'recursive delete is only valid for Folder targets',
      );
    }
    const contentMatch = validated.ifContentMatch;
    if (contentMatch === null || contentMatch === undefined || contentMatch.length === 0) {
      // Transport should have returned 428; defense in depth as invalid_request path.
      throw new CollectionsError(
        'invalid_node_input',
        'If-Content-Match is required when recursive=true',
      );
    }
    if (!ifMatchSatisfied(contentMatch, locked.contentRevision)) {
      throw new CollectionPreconditionError({
        currentEtag: strongEntityTag(locked.contentRevision),
        precondition: 'content',
      });
    }
  } else if (
    validated.ifContentMatch !== null
    && validated.ifContentMatch !== undefined
    && validated.ifContentMatch.length > 0
  ) {
    throw new CollectionsError(
      'invalid_node_input',
      'If-Content-Match is not allowed on non-recursive delete',
    );
  }

  const parentId = node.parentId;
  if (!validated.recursive && node.kind === 'folder') {
    // Preserve the Product conflict response; the canonical planner repeats this check.
    const hasChildren = ports.nodes.hasLiveChildren === undefined
      ? (await ports.nodes.listLiveSiblingPositions(
        validated.collectionId,
        validated.nodeId,
      )).length > 0
      : await ports.nodes.hasLiveChildren(validated.collectionId, validated.nodeId);
    if (hasChildren) throw new NodeConflictError('folder_not_empty');
  }

  const now = await ports.clock.now();
  const operationId = validated.operationId ?? generateOpaqueId();
  const scope: DeletionScope = validated.recursive ? 'subtree' : 'single';
  const mutation = await ports.canonical.execute({
    operationId,
    collectionId: validated.collectionId,
    actor: {
      principalId: validated.actor.principalId,
      principalType: validated.actor.principalType,
    },
    mutation: {
      action: 'delete',
      target: {
        collectionId: validated.collectionId,
        resourceId: validated.nodeId,
        resourceKind: 'node',
      },
      parentId,
      expectedResourceRevision: node.resourceRevision,
      deleteIntent: {
        scope,
        ...(validated.ifContentMatch
          ? { expectedContentRevision: locked.contentRevision }
          : {}),
      },
    },
  });
  const contentRevision = mutation.allocation.contentRevision!;
  const deleteRevision = mutation.allocation.deletedResourceRevisions![validated.nodeId]!;
  const parentChildrenRevision = mutation.allocation.childrenRevisions[parentId]!;
  const policyRevision = mutation.allocation.policyRevision ?? locked.policyRevision;
  const commitOrdinal = mutation.allocation.commitOrdinal;
  const affectedCount = Object.keys(mutation.allocation.deletedResourceRevisions ?? {}).length;
  const purgeAfterDate = new Date(now.getTime() + NODE_DELETION_PURGE_RETENTION_MS);

  const receipt: DeletionReceiptSnapshot = {
    resourceType: 'node',
    targetId: validated.nodeId,
    collectionId: validated.collectionId,
    scope,
    deletedAt: formatUtcDateTime(now),
    deleteRevision,
    operationId,
    affectedCount,
    purgeAfter: formatUtcDateTime(purgeAfterDate),
  };

  const parentState: ParentStateSnapshot = {
    id: parentId,
    childrenRevision: parentChildrenRevision,
    childrenEtag: strongEntityTag(parentChildrenRevision),
  };
  const fence: CollectionFenceSnapshot = {
    contentRevision,
    contentEtag: strongEntityTag(contentRevision),
    policyRevision,
    policyEtag: strongEntityTag(policyRevision),
  };

  const productResult = buildProductResult(receipt, parentState, fence);
  await ports.receipts.complete(binding, validated.command.fingerprint, productResult);

  return {
    kind: 'deleted',
    receipt,
    parent: parentState,
    fence,
    operationId,
    commitOrdinal,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedDeleteCollectionNodeInput {
  readonly actor: DeleteCollectionNodeActor;
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly collectionId: string;
  readonly nodeId: string;
  readonly ifMatch: string;
  readonly recursive: boolean;
  readonly ifContentMatch: string | null;
  readonly operationId?: string;
}

function validateInput(input: DeleteCollectionNodeInput): ValidatedDeleteCollectionNodeInput {
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
  if (typeof input.recursive !== 'boolean') {
    throw new CollectionsError('invalid_node_input', 'recursive must be a boolean');
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
    : deleteCollectionNodeCommandScope(collectionId, nodeId);
  assertNonEmptyField(commandScope, 'command.commandScope');

  let ifContentMatch: string | null = null;
  if (input.ifContentMatch !== null && input.ifContentMatch !== undefined) {
    if (typeof input.ifContentMatch !== 'string') {
      throw new CollectionsError('invalid_node_input', 'ifContentMatch must be a string or null');
    }
    if (input.ifContentMatch.length > 0) {
      ifContentMatch = input.ifContentMatch;
    }
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
    recursive: input.recursive,
    ifContentMatch,
    operationId: input.operationId,
  };
}

async function authorizeDelete(
  accessPolicy: AccessPolicyFactsPort,
  validated: ValidatedDeleteCollectionNodeInput,
  locked: LockedCollectionRow,
): Promise<void> {
  await authorizeCollectionCapability(accessPolicy, {
    collectionId: validated.collectionId,
    actor: validated.actor,
    capability: 'delete_node',
  }, locked);
}

// ---------------------------------------------------------------------------
// Snapshots / product result
// ---------------------------------------------------------------------------

function buildProductResult(
  receipt: DeletionReceiptSnapshot,
  parent: ParentStateSnapshot,
  fence: CollectionFenceSnapshot,
): ProductCommandResult {
  const bodyObject = {
    receipt: {
      resourceType: receipt.resourceType,
      targetId: receipt.targetId,
      collectionId: receipt.collectionId,
      scope: receipt.scope,
      deletedAt: receipt.deletedAt,
      deleteRevision: receipt.deleteRevision,
      operationId: receipt.operationId,
      affectedCount: receipt.affectedCount,
      purgeAfter: receipt.purgeAfter,
    },
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
    status: 200,
    body: new TextEncoder().encode(bodyText),
    stableHeaders: {
      // Deleted resource has no ETag; Cache-Control only.
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: DELETE_COLLECTION_NODE_CONTRACT_VERSION,
    targetIdentity: receipt.targetId,
  };
}

function mapNonClaimed(
  claim: Exclude<
    Awaited<ReturnType<ProductCollectionCanonicalPorts['receipts']['claim']>>,
    { kind: 'claimed' }
  >,
): DeleteCollectionNodeResult {
  switch (claim.kind) {
    case 'replay':
      return {
        kind: 'replay',
        status: claim.result.status,
        body: claim.result.body,
        stableHeaders: claim.result.stableHeaders,
        mediaType: claim.result.mediaType,
        contractVersion: claim.result.contractVersion,
        targetIdentity: claim.result.targetIdentity,
      };
    case 'in_progress':
      return {
        kind: 'in_progress',
        retryAfterSeconds: claim.retryAfterSeconds,
      };
    case 'reused':
      return { kind: 'reused' };
    case 'expired':
      return { kind: 'expired', resultDigest: claim.resultDigest };
    default: {
      const _exhaustive: never = claim;
      return _exhaustive;
    }
  }
}

/** Closed payload for node.deleted@1 — fail closed before outbox insert. */
export function assertNodeDeletedPayload(payload: unknown): asserts payload is {
  readonly collectionId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly parentId: string;
  readonly scope: string;
  readonly affectedCount: number;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly parentChildrenRevision: string;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CollectionsError('invalid_node_input', 'node.deleted payload must be an object');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    'affectedCount',
    'collectionId',
    'contentRevision',
    'kind',
    'nodeId',
    'parentChildrenRevision',
    'parentId',
    'policyRevision',
    'scope',
  ];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CollectionsError(
      'invalid_node_input',
      'node.deleted payload must be a closed object',
    );
  }
  for (const key of [
    'collectionId',
    'nodeId',
    'kind',
    'parentId',
    'scope',
    'contentRevision',
    'policyRevision',
    'parentChildrenRevision',
  ] as const) {
    const value = record[key];
    if (typeof value !== 'string' || value.length < 1) {
      throw new CollectionsError(
        'invalid_node_input',
        `node.deleted payload.${key} must be a non-empty string`,
      );
    }
  }
  if (
    typeof record.affectedCount !== 'number'
    || !Number.isInteger(record.affectedCount)
    || record.affectedCount < 0
  ) {
    throw new CollectionsError(
      'invalid_node_input',
      'node.deleted payload.affectedCount must be a non-negative integer',
    );
  }
}

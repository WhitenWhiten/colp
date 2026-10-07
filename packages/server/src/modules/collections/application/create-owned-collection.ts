import {
  assertCanonicalCommandId,
  type ProductCommandBinding,
  type ProductCommandResult,
} from '../../commands/index.js';
import {
  CollectionsError,
  assertNonEmptyField,
  assertValidCollectionKind,
  assertValidCollectionSummary,
  assertValidCollectionTitle,
  formatUtcDateTime,
  generateOpaqueId,
  generateRevisionToken,
  strongEntityTag,
  type CollectionKind,
} from '../domain/index.js';
export {
  CREATE_OWNED_COLLECTION_OPERATION_TYPE,
  COLLECTION_CREATED_EVENT_TYPE,
  COLLECTION_CREATED_EVENT_VERSION,
  COLLECTION_CREATED_HANDLER_NAME,
  assertCollectionCreatedPayload,
} from './canonical-owned-collection-bootstrap.js';
import type {
  ProductCollectionCanonicalPorts,
} from './ports.js';

export const CREATE_OWNED_COLLECTION_COMMAND_SCOPE = 'collection:create';
export const CREATE_OWNED_COLLECTION_CONTRACT_VERSION = '1.0.0';

export interface CreateOwnedCollectionActor {
  readonly principalId: string;
  readonly principalType: 'account';
  readonly subjectId: string;
}

export interface CreateOwnedCollectionCommand {
  readonly commandId: string;
  readonly fingerprint: string;
  /** Defaults to the transport-neutral collection:create intent. */
  readonly commandScope?: string;
}

export interface CreateOwnedCollectionInput {
  readonly actor: CreateOwnedCollectionActor;
  readonly command: CreateOwnedCollectionCommand;
  readonly title: string;
  readonly summary: string | null;
  readonly kind: CollectionKind | string;
  /** Optional overrides for deterministic tests only. */
  readonly collectionId?: string;
  readonly rootNodeId?: string;
  readonly operationId?: string;
}

export interface CreatedCollectionSnapshot {
  readonly id: string;
  readonly kind: CollectionKind;
  readonly title: string;
  readonly summary: string | null;
  readonly visibility: 'private';
  readonly allowSearchIndexing: false;
  readonly rootNodeId: string;
  readonly revision: string;
  readonly etag: string;
  readonly contentRevision: string;
  readonly contentEtag: string;
  readonly policyRevision: string;
  readonly policyEtag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatedRootSnapshot {
  readonly id: string;
  readonly collectionId: string;
  readonly kind: 'folder';
  readonly folderRole: 'root';
  readonly parentId: null;
  readonly position: null;
  readonly title: string;
  readonly description: null;
  readonly tags: readonly [];
  readonly visibility: 'inherit';
  readonly revision: string;
  readonly etag: string;
  readonly readOnly: true;
  readonly readOnlyReason: 'root_immutable';
  readonly childrenRevision: string;
  readonly childrenEtag: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type CreateOwnedCollectionResult =
  | {
      readonly kind: 'created';
      readonly collection: CreatedCollectionSnapshot;
      readonly root: CreatedRootSnapshot;
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

/** Product task-17 path: receipt admission followed by one canonical bootstrap. */
export async function createOwnedCollectionCanonical(
  ports: ProductCollectionCanonicalPorts,
  input: CreateOwnedCollectionInput,
): Promise<CreateOwnedCollectionResult> {
  const validated = validateInput(input);
  const binding: ProductCommandBinding = {
    principalId: validated.actor.principalId,
    commandScope: validated.command.commandScope,
    commandId: validated.command.commandId,
  };
  const claim = await ports.receipts.claim(binding, validated.command.fingerprint);
  if (claim.kind !== 'claimed') return mapNonClaimed(claim);

  const collectionId = validated.collectionId ?? generateOpaqueId();
  const rootNodeId = validated.rootNodeId ?? generateOpaqueId();
  const operationId = validated.operationId ?? generateOpaqueId();
  const resourceRevision = generateRevisionToken();
  const contentRevision = generateRevisionToken();
  const policyRevision = generateRevisionToken();
  const rootResourceRevision = generateRevisionToken();
  const rootChildrenRevision = generateRevisionToken();
  const bootstrap = await ports.canonical.bootstrapOwnedCollection({
    actor: validated.actor,
    collectionId,
    rootNodeId,
    operationId,
    domainEventId: generateOpaqueId(),
    outboxId: generateOpaqueId(),
    title: validated.title,
    summary: validated.summary,
    kind: validated.kind,
    resourceRevision,
    contentRevision,
    policyRevision,
    rootResourceRevision,
    rootChildrenRevision,
  });
  const collection = buildCollectionSnapshot({
    id: collectionId,
    kind: validated.kind,
    title: validated.title,
    summary: validated.summary,
    rootNodeId,
    resourceRevision,
    contentRevision,
    policyRevision,
    createdAt: bootstrap.createdAt,
    updatedAt: bootstrap.updatedAt,
  });
  const root = buildRootSnapshot({
    id: rootNodeId,
    collectionId,
    title: validated.title,
    resourceRevision: rootResourceRevision,
    childrenRevision: rootChildrenRevision,
    createdAt: bootstrap.createdAt,
    updatedAt: bootstrap.updatedAt,
  });
  await ports.receipts.complete(
    binding,
    validated.command.fingerprint,
    buildProductResult(collection, root),
  );
  return { kind: 'created', collection, root, operationId, commitOrdinal: bootstrap.commitOrdinal };
}

interface ValidatedCreateOwnedCollectionInput {
  readonly actor: CreateOwnedCollectionActor;
  readonly command: {
    readonly commandId: string;
    readonly fingerprint: string;
    readonly commandScope: string;
  };
  readonly title: string;
  readonly summary: string | null;
  readonly kind: CollectionKind;
  readonly collectionId?: string;
  readonly rootNodeId?: string;
  readonly operationId?: string;
}

function validateInput(input: CreateOwnedCollectionInput): ValidatedCreateOwnedCollectionInput {
  if (!input || typeof input !== 'object') {
    throw new CollectionsError('invalid_collection_input', 'input is required');
  }
  if (!input.actor || typeof input.actor !== 'object') {
    throw new CollectionsError('invalid_collection_input', 'actor is required');
  }
  if (!input.command || typeof input.command !== 'object') {
    throw new CollectionsError('invalid_collection_input', 'command is required');
  }
  if (input.actor.principalType !== 'account') {
    throw new CollectionsError(
      'invalid_collection_input',
      'actor.principalType must be account',
    );
  }

  const principalId = assertNonEmptyField(input.actor.principalId, 'actor.principalId');
  const subjectId = assertNonEmptyField(input.actor.subjectId, 'actor.subjectId');
  const commandId = assertCanonicalCommandId(
    assertNonEmptyField(input.command.commandId, 'command.commandId'),
  );
  const fingerprint = assertNonEmptyField(input.command.fingerprint, 'command.fingerprint');
  const commandScope = input.command.commandScope?.trim()
    ? input.command.commandScope
    : CREATE_OWNED_COLLECTION_COMMAND_SCOPE;
  assertNonEmptyField(commandScope, 'command.commandScope');

  return {
    actor: {
      principalId,
      principalType: 'account',
      subjectId,
    },
    command: {
      commandId,
      fingerprint,
      commandScope,
    },
    title: assertValidCollectionTitle(input.title),
    summary: assertValidCollectionSummary(input.summary),
    kind: assertValidCollectionKind(input.kind),
    collectionId: input.collectionId,
    rootNodeId: input.rootNodeId,
    operationId: input.operationId,
  };
}

function mapNonClaimed(
  claim: Exclude<Awaited<ReturnType<ProductCollectionCanonicalPorts['receipts']['claim']>>, { kind: 'claimed' }>,
): CreateOwnedCollectionResult {
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

function buildCollectionSnapshot(input: {
  readonly id: string;
  readonly kind: CollectionKind;
  readonly title: string;
  readonly summary: string | null;
  readonly rootNodeId: string;
  readonly resourceRevision: string;
  readonly contentRevision: string;
  readonly policyRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): CreatedCollectionSnapshot {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    visibility: 'private',
    allowSearchIndexing: false,
    rootNodeId: input.rootNodeId,
    revision: input.resourceRevision,
    etag: strongEntityTag(input.resourceRevision),
    contentRevision: input.contentRevision,
    contentEtag: strongEntityTag(input.contentRevision),
    policyRevision: input.policyRevision,
    policyEtag: strongEntityTag(input.policyRevision),
    createdAt: formatUtcDateTime(input.createdAt),
    updatedAt: formatUtcDateTime(input.updatedAt),
  };
}

function buildRootSnapshot(input: {
  readonly id: string;
  readonly collectionId: string;
  readonly title: string;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): CreatedRootSnapshot {
  return {
    id: input.id,
    collectionId: input.collectionId,
    kind: 'folder',
    folderRole: 'root',
    parentId: null,
    position: null,
    title: input.title,
    description: null,
    tags: [],
    visibility: 'inherit',
    revision: input.resourceRevision,
    etag: strongEntityTag(input.resourceRevision),
    readOnly: true,
    readOnlyReason: 'root_immutable',
    childrenRevision: input.childrenRevision,
    childrenEtag: strongEntityTag(input.childrenRevision),
    createdAt: formatUtcDateTime(input.createdAt),
    updatedAt: formatUtcDateTime(input.updatedAt),
  };
}

function buildProductResult(
  collection: CreatedCollectionSnapshot,
  root: CreatedRootSnapshot,
): ProductCommandResult {
  const bodyObject = {
    collection: {
      id: collection.id,
      kind: collection.kind,
      title: collection.title,
      summary: collection.summary,
      visibility: collection.visibility,
      allowSearchIndexing: collection.allowSearchIndexing,
      rootNodeId: collection.rootNodeId,
      revision: collection.revision,
      etag: collection.etag,
      contentRevision: collection.contentRevision,
      contentEtag: collection.contentEtag,
      policyRevision: collection.policyRevision,
      policyEtag: collection.policyEtag,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    },
    root: {
      id: root.id,
      collectionId: root.collectionId,
      kind: root.kind,
      folderRole: root.folderRole,
      parentId: root.parentId,
      position: root.position,
      title: root.title,
      description: root.description,
      tags: [...root.tags],
      visibility: root.visibility,
      revision: root.revision,
      etag: root.etag,
      readOnly: root.readOnly,
      readOnlyReason: root.readOnlyReason,
      childrenRevision: root.childrenRevision,
      childrenEtag: root.childrenEtag,
      createdAt: root.createdAt,
      updatedAt: root.updatedAt,
    },
  };
  const bodyText = JSON.stringify(bodyObject);
  return {
    status: 201,
    body: new TextEncoder().encode(bodyText),
    stableHeaders: {
      location: `/api/v1/collections/${collection.id}`,
      etag: collection.etag,
      'cache-control': 'private, no-store',
      'content-type': 'application/json',
    },
    mediaType: 'application/json',
    contractVersion: CREATE_OWNED_COLLECTION_CONTRACT_VERSION,
    targetIdentity: collection.id,
  };
}

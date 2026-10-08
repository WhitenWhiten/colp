import {
  CollectionsError,
  assertNonEmptyField,
  assertValidCollectionKind,
  assertValidCollectionSummary,
  assertValidCollectionTitle,
  type JsonObject,
} from '../domain/index.js';
import type {
  CanonicalOwnedCollectionBootstrapInput,
  CanonicalOwnedCollectionBootstrapPorts,
  CanonicalOwnedCollectionBootstrapResult,
} from './ports.js';

const BOOTSTRAP_ORDINAL = 1n;

export const CREATE_OWNED_COLLECTION_OPERATION_TYPE = 'create_owned_collection';
export const COLLECTION_CREATED_EVENT_TYPE = 'collection.created';
export const COLLECTION_CREATED_EVENT_VERSION = 1;
export const COLLECTION_CREATED_HANDLER_NAME = 'collection_created_projection';

/** Closed payload for collection.created@1, validated before the outbox append. */
export function assertCollectionCreatedPayload(payload: unknown): asserts payload is {
  readonly collectionId: string;
  readonly ownerSubjectId: string;
  readonly kind: string;
  readonly rootNodeId: string;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new CollectionsError('invalid_collection_input', 'collection.created payload must be an object');
  }
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['collectionId', 'kind', 'ownerSubjectId', 'rootNodeId'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new CollectionsError('invalid_collection_input', 'collection.created payload must be a closed object');
  }
  for (const key of expected) {
    const value = record[key];
    if (typeof value !== 'string' || value.length < 1) {
      throw new CollectionsError('invalid_collection_input', `collection.created payload.${key} must be a non-empty string`);
    }
  }
}

/**
 * Canonical application capability for creating the initial Collection/Root aggregate.
 * It is admission-neutral: callers own transaction and command-receipt coordination.
 */
export async function bootstrapCanonicalOwnedCollection(
  ports: CanonicalOwnedCollectionBootstrapPorts,
  input: CanonicalOwnedCollectionBootstrapInput,
): Promise<CanonicalOwnedCollectionBootstrapResult> {
  const validated = validateBootstrapInput(input);
  const now = await ports.clock.now();

  await ports.idLedger.reserve([
    { resourceId: validated.collectionId, resourceType: 'collection' },
    { resourceId: validated.rootNodeId, resourceType: 'node' },
    { resourceId: validated.operationId, resourceType: 'operation' },
    { resourceId: validated.domainEventId, resourceType: 'domain-event' },
    { resourceId: validated.outboxId, resourceType: 'outbox' },
  ]);
  await ports.collections.insertBootstrap({
    id: validated.collectionId,
    ownerSubjectId: validated.actor.subjectId,
    title: validated.title,
    summary: validated.summary,
    kind: validated.kind,
    visibility: 'private',
    rootNodeId: validated.rootNodeId,
    resourceRevision: validated.resourceRevision,
    contentRevision: validated.contentRevision,
    policyRevision: validated.policyRevision,
    commitOrdinal: BOOTSTRAP_ORDINAL,
    createdAt: now,
    updatedAt: now,
  });
  await ports.nodes.insertRoot({
    id: validated.rootNodeId,
    collectionId: validated.collectionId,
    title: validated.title,
    resourceRevision: validated.rootResourceRevision,
    childrenRevision: validated.rootChildrenRevision,
    createdAt: now,
    updatedAt: now,
  });
  await ports.accessPolicy.insertMembership({
    collectionId: validated.collectionId,
    subjectId: validated.actor.subjectId,
    role: 'owner',
    grantedAt: now,
  });
  await ports.accessPolicy.upsertCollectionPolicy({
    collectionId: validated.collectionId,
    policyJson: {},
    updatedAt: now,
  });

  await ports.revisions.insertResourceRevision({ collectionId: validated.collectionId, resourceId: validated.collectionId, revision: validated.resourceRevision, ordinal: BOOTSTRAP_ORDINAL, createdAt: now });
  await ports.revisions.insertResourceRevision({ collectionId: validated.collectionId, resourceId: validated.rootNodeId, revision: validated.rootResourceRevision, ordinal: BOOTSTRAP_ORDINAL, createdAt: now });
  await ports.revisions.insertContentRevision({ collectionId: validated.collectionId, revision: validated.contentRevision, ordinal: BOOTSTRAP_ORDINAL, createdAt: now });
  await ports.revisions.insertPolicyRevision({ collectionId: validated.collectionId, revision: validated.policyRevision, ordinal: BOOTSTRAP_ORDINAL, createdAt: now });
  await ports.revisions.insertChildrenRevision({ collectionId: validated.collectionId, parentId: validated.rootNodeId, revision: validated.rootChildrenRevision, ordinal: BOOTSTRAP_ORDINAL });

  const operationPayload: JsonObject = {
    collectionId: validated.collectionId,
    rootNodeId: validated.rootNodeId,
    kind: validated.kind,
    ownerSubjectId: validated.actor.subjectId,
    title: validated.title,
    summary: validated.summary,
  };
  await ports.operations.append({
    operationId: validated.operationId,
    collectionId: validated.collectionId,
    commitOrdinal: BOOTSTRAP_ORDINAL,
    operationType: CREATE_OWNED_COLLECTION_OPERATION_TYPE,
    payload: operationPayload,
    actorPrincipalId: validated.actor.principalId,
    createdAt: now,
  });
  await ports.audit.append({
    operationId: validated.operationId,
    collectionId: validated.collectionId,
    principalId: validated.actor.principalId,
    eventType: COLLECTION_CREATED_EVENT_TYPE,
    details: {
      operationType: CREATE_OWNED_COLLECTION_OPERATION_TYPE,
      ownerSubjectId: validated.actor.subjectId,
      kind: validated.kind,
      rootNodeId: validated.rootNodeId,
      principalType: validated.actor.principalType,
    },
    createdAt: now,
  });

  const eventPayload = {
    collectionId: validated.collectionId,
    ownerSubjectId: validated.actor.subjectId,
    kind: validated.kind,
    rootNodeId: validated.rootNodeId,
  };
  assertCollectionCreatedPayload(eventPayload);
  await ports.outbox.append({
    outboxId: validated.outboxId,
    domainEventId: validated.domainEventId,
    eventType: COLLECTION_CREATED_EVENT_TYPE,
    eventVersion: COLLECTION_CREATED_EVENT_VERSION,
    handlerName: COLLECTION_CREATED_HANDLER_NAME,
    handlerMode: 'projection_latest_only',
    aggregateType: 'collection',
    aggregateId: validated.collectionId,
    aggregateScope: validated.collectionId,
    aggregateRevision: validated.resourceRevision,
    commitOrdinal: BOOTSTRAP_ORDINAL,
    payload: eventPayload,
    occurredAt: now,
  });

  return { createdAt: now, updatedAt: now, commitOrdinal: BOOTSTRAP_ORDINAL };
}

function validateBootstrapInput(
  input: CanonicalOwnedCollectionBootstrapInput,
): CanonicalOwnedCollectionBootstrapInput {
  if (!input || typeof input !== 'object' || input.actor?.principalType !== 'account') {
    throw new CollectionsError('invalid_collection_input', 'canonical bootstrap requires an account actor');
  }
  assertNonEmptyField(input.actor.principalId, 'actor.principalId');
  assertNonEmptyField(input.actor.subjectId, 'actor.subjectId');
  assertNonEmptyField(input.collectionId, 'collectionId');
  assertNonEmptyField(input.rootNodeId, 'rootNodeId');
  assertNonEmptyField(input.operationId, 'operationId');
  assertNonEmptyField(input.domainEventId, 'domainEventId');
  assertNonEmptyField(input.outboxId, 'outboxId');
  assertValidCollectionTitle(input.title);
  assertValidCollectionSummary(input.summary);
  assertValidCollectionKind(input.kind);
  assertNonEmptyField(input.resourceRevision, 'resourceRevision');
  assertNonEmptyField(input.contentRevision, 'contentRevision');
  assertNonEmptyField(input.policyRevision, 'policyRevision');
  assertNonEmptyField(input.rootResourceRevision, 'rootResourceRevision');
  assertNonEmptyField(input.rootChildrenRevision, 'rootChildrenRevision');
  return input;
}

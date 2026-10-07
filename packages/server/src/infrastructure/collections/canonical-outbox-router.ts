import {
  CanonicalMutationInvariantError,
  COLLECTION_UPDATED_EVENT_TYPE,
  COLLECTION_UPDATED_EVENT_VERSION,
  COLLECTION_UPDATED_HANDLER_NAME,
  NODE_RESTORED_EVENT_TYPE,
  NODE_RESTORED_EVENT_VERSION,
  NODE_RESTORED_HANDLER_NAME,
  NODE_CREATED_EVENT_TYPE,
  NODE_CREATED_EVENT_VERSION,
  NODE_CREATED_HANDLER_NAME,
  NODE_DELETED_EVENT_TYPE,
  NODE_DELETED_EVENT_VERSION,
  NODE_DELETED_HANDLER_NAME,
  NODE_MOVED_EVENT_TYPE,
  NODE_MOVED_EVENT_VERSION,
  NODE_MOVED_HANDLER_NAME,
  NODE_UPDATED_EVENT_TYPE,
  NODE_UPDATED_EVENT_VERSION,
  NODE_UPDATED_HANDLER_NAME,
  type JsonObject,
} from '../../modules/collections/index.js';
import {
  kyselyAffectedFactExecutor,
  persistNodeDeleteAffectedFacts,
} from './canonical-node-delete-affected-facts.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

interface RoutedCanonicalEvent {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly handlerName: string;
  readonly aggregateRevision: string;
  readonly payload: JsonObject;
  readonly publicationPurge: {
    readonly publicationSlug: string;
    readonly visibility: 'private' | 'protected' | 'public' | 'unlisted';
    readonly contentRevision: string;
    readonly policyRevision: string;
  } | null;
}

function invariant(message: string): never {
  throw new CanonicalMutationInvariantError('invalid_canonical_mutation', message);
}

async function revisionForParent(
  tx: DatabaseTransaction,
  collectionId: string,
  parentId: string,
  ordinal: bigint,
): Promise<string> {
  const row = await tx.selectFrom('children_revisions').select('revision')
    .where('collection_id', '=', collectionId).where('parent_id', '=', parentId)
    .where('ordinal', '=', ordinal).executeTakeFirst();
  if (!row) invariant(`children revision evidence is missing for parent ${parentId}`);
  return row.revision;
}

export async function routeCanonicalDomainEvent(
  tx: DatabaseTransaction,
  event: {
    readonly collectionId: string;
    readonly aggregateId: string;
    readonly commitOrdinal: bigint;
    readonly operationId: string;
    readonly payload: JsonObject;
  },
): Promise<RoutedCanonicalEvent> {
  const action = event.payload.action;
  const resourceKind = event.payload.resourceKind;
  const collection = await tx.selectFrom('collections').selectAll()
    .where('id', '=', event.collectionId).executeTakeFirst();
  if (!collection) invariant('collection disappeared before outbox append');
  const publicationPurge = collection.published_at !== null && collection.publication_slug !== null
    ? {
        publicationSlug: collection.publication_slug,
        visibility: collection.visibility,
        contentRevision: collection.content_revision,
        policyRevision: collection.policy_revision,
      }
    : null;

  if (resourceKind === 'collection' && action === 'update') {
    return {
      eventType: COLLECTION_UPDATED_EVENT_TYPE,
      eventVersion: COLLECTION_UPDATED_EVENT_VERSION,
      handlerName: COLLECTION_UPDATED_HANDLER_NAME,
      aggregateRevision: collection.resource_revision,
      publicationPurge,
      payload: {
        collectionId: collection.id,
        contentRevision: collection.content_revision,
        resourceRevision: collection.resource_revision,
        summary: collection.summary,
        title: collection.title,
      },
    };
  }

  if (resourceKind !== 'node' || !['create', 'update', 'move', 'delete', 'restore'].includes(String(action))) {
    invariant(`canonical outbox has no production route for ${String(resourceKind)}.${String(action)}`);
  }
  const node = await tx.selectFrom('nodes').selectAll()
    .where('collection_id', '=', event.collectionId).where('id', '=', event.aggregateId)
    .executeTakeFirst();
  if (!node) invariant('node disappeared before outbox append');
  const common = {
    collectionId: event.collectionId,
    contentRevision: collection.content_revision,
    kind: node.kind,
    nodeId: node.id,
    policyRevision: collection.policy_revision,
  };

  if (action === 'create' || action === 'restore') {
    if (!node.parent_id) invariant('created node has no authoritative parent');
    return {
      eventType: action === 'restore' ? NODE_RESTORED_EVENT_TYPE : NODE_CREATED_EVENT_TYPE,
      eventVersion: action === 'restore' ? NODE_RESTORED_EVENT_VERSION : NODE_CREATED_EVENT_VERSION,
      handlerName: action === 'restore' ? NODE_RESTORED_HANDLER_NAME : NODE_CREATED_HANDLER_NAME,
      aggregateRevision: node.resource_revision,
      publicationPurge,
      payload: {
        ...common,
        parentChildrenRevision: await revisionForParent(tx, event.collectionId, node.parent_id, event.commitOrdinal),
        parentId: node.parent_id,
        resourceRevision: node.resource_revision,
      },
    };
  }
  if (action === 'update') {
    return {
      eventType: NODE_UPDATED_EVENT_TYPE,
      eventVersion: NODE_UPDATED_EVENT_VERSION,
      handlerName: NODE_UPDATED_HANDLER_NAME,
      aggregateRevision: node.resource_revision,
      publicationPurge,
      payload: { ...common, resourceRevision: node.resource_revision },
    };
  }
  if (action === 'move') {
    if (!node.parent_id) invariant('moved node has no authoritative target parent');
    const affectedParents = (event.payload.revisionEffects as JsonObject).childrenOf;
    if (!Array.isArray(affectedParents) || affectedParents.some((id) => typeof id !== 'string')) {
      invariant('move children revision effects are invalid');
    }
    const sourceParentId = (affectedParents as string[]).find((id) => id !== node.parent_id) ?? node.parent_id;
    return {
      eventType: NODE_MOVED_EVENT_TYPE,
      eventVersion: NODE_MOVED_EVENT_VERSION,
      handlerName: NODE_MOVED_HANDLER_NAME,
      aggregateRevision: node.resource_revision,
      publicationPurge,
      payload: {
        ...common,
        resourceRevision: node.resource_revision,
        sourceChildrenRevision: await revisionForParent(tx, event.collectionId, sourceParentId, event.commitOrdinal),
        sourceParentId,
        targetChildrenRevision: await revisionForParent(tx, event.collectionId, node.parent_id, event.commitOrdinal),
        targetParentId: node.parent_id,
      },
    };
  }
  if (!node.parent_id) invariant('deleted node has no authoritative parent');
  const affectedResourceIds = event.payload.affectedResourceIds;
  const deleteIntent = event.payload.deleteIntent;
  if (
    !Array.isArray(affectedResourceIds)
    || affectedResourceIds.length === 0
    || affectedResourceIds.some((id) => typeof id !== 'string')
    || typeof deleteIntent !== 'object'
    || deleteIntent === null
    || Array.isArray(deleteIntent)
  ) invariant('delete plan metadata is invalid');
  const scope = (deleteIntent as JsonObject).scope;
  if (scope !== 'single' && scope !== 'subtree') invariant('delete scope is invalid');
  await persistNodeDeleteAffectedFacts(kyselyAffectedFactExecutor(tx), {
    collectionId: event.collectionId,
    commitOrdinal: event.commitOrdinal,
    rootNodeId: node.id,
    operationId: event.operationId,
    resourceIds: affectedResourceIds as readonly string[],
  });
  return {
    eventType: NODE_DELETED_EVENT_TYPE,
    eventVersion: NODE_DELETED_EVENT_VERSION,
    handlerName: NODE_DELETED_HANDLER_NAME,
    aggregateRevision: collection.content_revision,
    publicationPurge,
    payload: {
      affectedCount: affectedResourceIds.length,
      ...common,
      parentChildrenRevision: await revisionForParent(tx, event.collectionId, node.parent_id, event.commitOrdinal),
      parentId: node.parent_id,
      scope,
    },
  };
}

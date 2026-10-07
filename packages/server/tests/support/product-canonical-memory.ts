import {
  allocatePosition,
  CollectionsError,
  generateRevisionToken,
  NodeConflictError,
  planBoundedPositionRebalance,
  resolvePlacement,
  type CanonicalMutationInput,
  type CanonicalMutationResult,
  type CollectionsUnitOfWork,
  type CollectionsWritePorts,
  type JsonObject,
  type ProductCollectionMutationUnitOfWork,
} from '../../src/modules/collections/index.js';
import { DEFAULT_POSITION_REBALANCE_WINDOW } from '../../src/infrastructure/collections/canonical-mutation-postgres-ports.js';

/** Test-only adapter for transport suites; PostgreSQL integration tests exercise the real subject. */
export function createMemoryProductCollectionMutationUnitOfWork(
  legacy: CollectionsUnitOfWork,
  options: { readonly productOrigin?: string } = {},
): ProductCollectionMutationUnitOfWork {
  return {
    execute: (work) => legacy.execute((ports) => work({
      receipts: ports.receipts,
      clock: ports.clock,
      collections: { lockForUpdate: (id) => ports.collections.lockForUpdate(id) },
      nodes: {
        getNode: (collectionId, nodeId) => ports.nodes.getNode(collectionId, nodeId),
        listLiveSiblingPositions: (collectionId, parentId) =>
          ports.nodes.listLiveSiblingPositions(collectionId, parentId),
      },
      accessPolicy: ports.accessPolicyFacts,
      canonical: {
        execute: (input) => executeMemoryCanonicalForTests(ports, input),
        async bootstrapOwnedCollection() {
          throw new Error('canonical bootstrap is outside the node transport test scope');
        },
      },
      ...(options.productOrigin === undefined ? {} : { productOrigin: options.productOrigin }),
      ...(ports.bookmarkIcons === undefined ? {} : { bookmarkIcons: ports.bookmarkIcons }),
    })),
  };
}

export async function executeMemoryCanonicalForTests(
  ports: CollectionsWritePorts,
  input: CanonicalMutationInput,
): Promise<CanonicalMutationResult> {
  const locked = await ports.collections.lockForUpdate(input.collectionId);
  if (!locked) throw new Error('canonical test collection disappeared');
  const now = await ports.clock.now();
  const ordinal = locked.commitOrdinal + 1n;
  const resourceRevision = generateRevisionToken();
  const contentRevision = generateRevisionToken();
  const fields = input.mutation.fields?.kindFields ?? {};
  const policyChanged = input.mutation.action === 'create'
    ? fields.visibility !== 'inherit'
    : input.mutation.action === 'update'
      && fields.visibility !== (await ports.nodes.getNode(input.collectionId, input.mutation.target.resourceId))?.visibility;
  const policyRevision = policyChanged ? generateRevisionToken() : undefined;

  if (input.mutation.action === 'create') {
    const parentId = input.mutation.parentId!;
    const siblings = await ports.nodes.listLiveSiblingPositions(input.collectionId, parentId);
    const { beforeToken, afterToken } = resolvePlacement(
      siblings,
      input.mutation.relativePosition?.afterId,
      input.mutation.relativePosition?.beforeId,
    );
    const positionToken = allocatePosition(
      beforeToken,
      afterToken,
      siblings.map((row) => row.positionToken),
    );
    const createdNodeChildrenRevision = generateRevisionToken();
    const parentChildrenRevision = generateRevisionToken();
    await ports.nodes.insertNode({
      id: input.mutation.target.resourceId,
      collectionId: input.collectionId,
      parentId,
      kind: fields.kind as 'folder' | 'bookmark',
      title: fields.title as string,
      url: fields.url as string | null,
      description: fields.description as string | null,
      tags: fields.tags as readonly string[],
      visibility: fields.visibility as 'inherit' | 'protected' | 'private',
      positionToken,
      resourceRevision,
      childrenRevision: createdNodeChildrenRevision,
      createdAt: now,
      updatedAt: now,
    });
    await ports.nodes.advanceChildrenRevision(input.collectionId, parentId, parentChildrenRevision, now);
    await advanceCollection(ports, input.collectionId, contentRevision, policyRevision, ordinal, now);
    await ports.revisions.insertResourceRevision({ collectionId: input.collectionId, resourceId: input.mutation.target.resourceId, revision: resourceRevision, ordinal, createdAt: now });
    await ports.revisions.insertChildrenRevision({ collectionId: input.collectionId, parentId, revision: parentChildrenRevision, ordinal });
    if (fields.kind === 'folder') {
      await ports.revisions.insertChildrenRevision({ collectionId: input.collectionId, parentId: input.mutation.target.resourceId, revision: createdNodeChildrenRevision, ordinal });
    }
    await appendEvidence(ports, input, ordinal, resourceRevision, contentRevision, now, 'node.created');
    return {
      operationId: input.operationId,
      collectionId: input.collectionId,
      resourceId: input.mutation.target.resourceId,
      action: 'create',
      allocation: {
        commitOrdinal: ordinal,
        resourceRevision,
        createdNodeChildrenRevision,
        contentRevision,
        ...(policyRevision ? { policyRevision } : {}),
        childrenRevisions: { [parentId]: parentChildrenRevision },
        positionToken,
      },
    };
  }

  if (input.mutation.action === 'move') {
    const node = await ports.nodes.getNode(input.collectionId, input.mutation.target.resourceId);
    if (!node || !node.parentId || !input.mutation.parentId) throw new Error('canonical move target disappeared');
    const sourceParentId = node.parentId;
    const targetParentId = input.mutation.parentId;
    const siblings = (await ports.nodes.listLiveSiblingPositions(input.collectionId, targetParentId))
      .filter((row) => row.id !== node.id);
    const { beforeToken, afterToken } = resolvePlacement(
      siblings,
      input.mutation.relativePosition?.afterId,
      input.mutation.relativePosition?.beforeId,
    );
    let positionToken: string;
    let rebalancedCount = 0;
    try {
      positionToken = allocatePosition(beforeToken, afterToken, siblings.map((row) => row.positionToken));
    } catch (error: unknown) {
      if (!(error instanceof CollectionsError) || error.code !== 'invalid_node_anchor') throw error;
      const insertIndex = input.mutation.relativePosition?.beforeId
        ? siblings.findIndex((row) => row.id === input.mutation.relativePosition?.beforeId)
        : input.mutation.relativePosition?.afterId
          ? siblings.findIndex((row) => row.id === input.mutation.relativePosition?.afterId) + 1
          : siblings.length;
      const plan = planBoundedPositionRebalance({
        siblings,
        targetId: node.id,
        insertIndex,
        windowSize: DEFAULT_POSITION_REBALANCE_WINDOW,
      });
      positionToken = plan.targetPositionToken;
      for (const assignment of plan.siblingAssignments) {
        const id = assignment.resourceId;
        const revision = generateRevisionToken();
        await ports.nodes.updatePosition(input.collectionId, id, {
          positionToken: assignment.positionToken,
          resourceRevision: revision,
          updatedAt: now,
        });
        await ports.revisions.insertResourceRevision({ collectionId: input.collectionId, resourceId: id, revision, ordinal, createdAt: now });
        rebalancedCount += 1;
      }
    }
    const sourceChildrenRevision = generateRevisionToken();
    const targetChildrenRevision = sourceParentId === targetParentId
      ? sourceChildrenRevision
      : generateRevisionToken();
    await ports.nodes.updateParentAndPosition(input.collectionId, node.id, {
      parentId: targetParentId,
      positionToken,
      resourceRevision,
      updatedAt: now,
    });
    await ports.nodes.advanceChildrenRevision(input.collectionId, sourceParentId, sourceChildrenRevision, now);
    if (sourceParentId !== targetParentId) {
      await ports.nodes.advanceChildrenRevision(input.collectionId, targetParentId, targetChildrenRevision, now);
    }
    await advanceCollection(ports, input.collectionId, contentRevision, undefined, ordinal, now);
    await ports.revisions.insertResourceRevision({ collectionId: input.collectionId, resourceId: node.id, revision: resourceRevision, ordinal, createdAt: now });
    await ports.revisions.insertChildrenRevision({ collectionId: input.collectionId, parentId: sourceParentId, revision: sourceChildrenRevision, ordinal });
    if (sourceParentId !== targetParentId) {
      await ports.revisions.insertChildrenRevision({ collectionId: input.collectionId, parentId: targetParentId, revision: targetChildrenRevision, ordinal });
    }
    await appendEvidence(ports, input, ordinal, resourceRevision, contentRevision, now, 'node.moved', 1, undefined, rebalancedCount);
    return {
      operationId: input.operationId,
      collectionId: input.collectionId,
      resourceId: node.id,
      action: 'move',
      allocation: {
        commitOrdinal: ordinal,
        resourceRevision,
        contentRevision,
        childrenRevisions: {
          [sourceParentId]: sourceChildrenRevision,
          [targetParentId]: targetChildrenRevision,
        },
        positionToken,
      },
    };
  }

  if (input.mutation.action === 'delete') {
    const target = await ports.nodes.getNode(input.collectionId, input.mutation.target.resourceId);
    if (!target || !target.parentId) throw new Error('canonical delete target disappeared');
    let deleteIds: readonly string[] = [target.id];
    if (input.mutation.deleteIntent?.scope === 'subtree') {
      const first = await collectDescendants(ports, input.collectionId, target.id);
      const second = await collectDescendants(ports, input.collectionId, target.id);
      if (first.length !== second.length || first.some((id) => !second.includes(id))) {
        throw new NodeConflictError('revision_conflict', 'subtree membership changed during delete planning');
      }
      deleteIds = [...second, target.id];
    }
    const deletedResourceRevisions: Record<string, string> = {};
    for (const id of deleteIds) {
      const revision = id === target.id ? resourceRevision : generateRevisionToken();
      deletedResourceRevisions[id] = revision;
      await ports.nodes.markDeleted(input.collectionId, id, {
        deletedAt: now,
        deletedCommitOrdinal: ordinal,
        resourceRevision: revision,
        updatedAt: now,
      });
      await ports.revisions.insertResourceRevision({ collectionId: input.collectionId, resourceId: id, revision, ordinal, createdAt: now });
    }
    const parentChildrenRevision = generateRevisionToken();
    await ports.nodes.advanceChildrenRevision(input.collectionId, target.parentId, parentChildrenRevision, now);
    await advanceCollection(ports, input.collectionId, contentRevision, undefined, ordinal, now);
    await ports.revisions.insertChildrenRevision({ collectionId: input.collectionId, parentId: target.parentId, revision: parentChildrenRevision, ordinal });
    await appendEvidence(ports, input, ordinal, resourceRevision, contentRevision, now, 'node.deleted', deleteIds.length, deleteIds);
    return {
      operationId: input.operationId,
      collectionId: input.collectionId,
      resourceId: target.id,
      action: 'delete',
      allocation: {
        commitOrdinal: ordinal,
        resourceRevision,
        contentRevision,
        childrenRevisions: { [target.parentId]: parentChildrenRevision },
        deletedResourceRevisions,
      },
    };
  }

  if (input.mutation.action !== 'update') throw new Error('unsupported canonical node mutation');
  await ports.nodes.updateContent(input.collectionId, input.mutation.target.resourceId, {
    title: fields.title as string,
    url: fields.url as string | null,
    description: fields.description as string | null,
    tags: fields.tags as readonly string[],
    visibility: fields.visibility as 'inherit' | 'protected' | 'private',
    resourceRevision,
    updatedAt: now,
  });
  await advanceCollection(ports, input.collectionId, contentRevision, policyRevision, ordinal, now);
  await ports.revisions.insertResourceRevision({ collectionId: input.collectionId, resourceId: input.mutation.target.resourceId, revision: resourceRevision, ordinal, createdAt: now });
  await appendEvidence(ports, input, ordinal, resourceRevision, contentRevision, now, 'node.updated');
  return {
    operationId: input.operationId,
    collectionId: input.collectionId,
    resourceId: input.mutation.target.resourceId,
    action: 'update',
    allocation: {
      commitOrdinal: ordinal,
      resourceRevision,
      contentRevision,
      ...(policyRevision ? { policyRevision } : {}),
      childrenRevisions: {},
    },
  };
}

async function advanceCollection(
  ports: CollectionsWritePorts,
  collectionId: string,
  contentRevision: string,
  policyRevision: string | undefined,
  commitOrdinal: bigint,
  now: Date,
): Promise<void> {
  await ports.collections.advanceContentFence(collectionId, {
    contentRevision,
    commitOrdinal,
    updatedAt: now,
    ...(policyRevision ? { policyRevision } : {}),
  });
  await ports.revisions.insertContentRevision({ collectionId, revision: contentRevision, ordinal: commitOrdinal, createdAt: now });
  if (policyRevision) {
    await ports.revisions.insertPolicyRevision({ collectionId, revision: policyRevision, ordinal: commitOrdinal, createdAt: now });
  }
}

async function appendEvidence(
  ports: CollectionsWritePorts,
  input: CanonicalMutationInput,
  commitOrdinal: bigint,
  resourceRevision: string,
  contentRevision: string,
  now: Date,
  eventType: 'node.created' | 'node.updated' | 'node.moved' | 'node.deleted',
  affectedCount = 1,
  deletedNodeIds?: readonly string[],
  rebalancedCount = 0,
): Promise<void> {
  const payload: JsonObject = eventType === 'node.deleted'
    ? { collectionId: input.collectionId, nodeId: input.mutation.target.resourceId, resourceRevision, contentRevision, affectedCount, scope: input.mutation.deleteIntent?.scope ?? 'single', deletedNodeIds: [...(deletedNodeIds ?? [])] }
    : eventType === 'node.moved'
      ? { collectionId: input.collectionId, nodeId: input.mutation.target.resourceId, resourceRevision, contentRevision, rebalancedCount }
      : { collectionId: input.collectionId, nodeId: input.mutation.target.resourceId, resourceRevision, contentRevision };
  await ports.idLedger.reserve([
    { resourceId: input.operationId, resourceType: 'operation' },
    { resourceId: `test-${input.operationId}`, resourceType: 'outbox' },
  ]);
  const operationType = `resource.${input.mutation.action}`;
  await ports.operations.append({ operationId: input.operationId, collectionId: input.collectionId, commitOrdinal, operationType, payload, actorPrincipalId: input.actor.principalId, createdAt: now });
  await ports.audit.append({ operationId: input.operationId, collectionId: input.collectionId, principalId: input.actor.principalId, eventType: operationType, details: payload, createdAt: now });
  const handlerName = eventType.replace('.', '_') + '_projection';
  await ports.outbox.append({ outboxId: `test-${input.operationId}`, domainEventId: input.operationId, eventType, eventVersion: 1, handlerName, handlerMode: 'projection_latest_only', aggregateType: 'node', aggregateId: input.mutation.target.resourceId, aggregateScope: input.collectionId, aggregateRevision: eventType === 'node.deleted' ? contentRevision : resourceRevision, commitOrdinal, payload, occurredAt: now });
}

async function collectDescendants(
  ports: CollectionsWritePorts,
  collectionId: string,
  rootId: string,
): Promise<readonly string[]> {
  if (ports.nodes.listLiveDescendantIds) return ports.nodes.listLiveDescendantIds(collectionId, rootId);
  const result: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const child of await ports.nodes.listLiveSiblingPositions(collectionId, parentId)) {
      result.push(child.id);
      queue.push(child.id);
    }
  }
  return result.reverse();
}

import {
  createCollectionNode,
  deleteCollectionNode,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE,
  defineCollectionNodeCreateDeleteWriteContract,
} from '../../contracts/collection-node-create-delete-write.contract.js';
import {
  createMemoryPorts,
  createState,
  type MemoryState,
} from '../../support/memory-collections-write-ports.js';

function seedMemoryFixture(state: MemoryState): void {
  const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
  const createdAt = new Date(state.now);
  state.collections.set(fixture.collectionId, {
    id: fixture.collectionId,
    ownerSubjectId: fixture.ownerSubjectId,
    title: 'Collection node create/delete contract',
    summary: null,
    kind: 'bookmarks',
    visibility: 'private',
    rootNodeId: fixture.rootId,
    resourceRevision: fixture.collectionResourceRevision,
    contentRevision: fixture.contentRevision,
    policyRevision: fixture.policyRevision,
    commitOrdinal: 2n,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
  state.memberships.push({
    collectionId: fixture.collectionId,
    subjectId: fixture.ownerSubjectId,
    role: 'owner',
  });
  state.ledger.push(
    { resourceId: fixture.collectionId, resourceType: 'collection' },
    { resourceId: fixture.rootId, resourceType: 'node' },
    { resourceId: fixture.leafId, resourceType: 'node' },
    { resourceId: fixture.folderId, resourceType: 'node' },
    { resourceId: fixture.childId, resourceType: 'node' },
  );

  const common = {
    collectionId: fixture.collectionId,
    description: null,
    tags: [],
    visibility: 'inherit' as const,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    deletedCommitOrdinal: null,
  };
  state.nodes.set(fixture.rootId, {
    ...common,
    id: fixture.rootId,
    parentId: null,
    kind: 'folder',
    isRoot: true,
    title: 'Root',
    url: null,
    positionToken: null,
    resourceRevision: fixture.rootResourceRevision,
    childrenRevision: fixture.rootChildrenRevision,
  });
  state.nodes.set(fixture.leafId, {
    ...common,
    id: fixture.leafId,
    parentId: fixture.rootId,
    kind: 'bookmark',
    isRoot: false,
    title: 'Leaf',
    url: 'https://example.test/leaf',
    positionToken: 'a',
    resourceRevision: fixture.leafResourceRevision,
    childrenRevision: fixture.leafChildrenRevision,
  });
  state.nodes.set(fixture.folderId, {
    ...common,
    id: fixture.folderId,
    parentId: fixture.rootId,
    kind: 'folder',
    isRoot: false,
    title: 'Folder',
    url: null,
    positionToken: 'm',
    resourceRevision: fixture.folderResourceRevision,
    childrenRevision: fixture.folderChildrenRevision,
  });
  state.nodes.set(fixture.childId, {
    ...common,
    id: fixture.childId,
    parentId: fixture.folderId,
    kind: 'bookmark',
    isRoot: false,
    title: 'Child',
    url: 'https://example.test/child',
    positionToken: 'a',
    resourceRevision: fixture.childResourceRevision,
    childrenRevision: fixture.childChildrenRevision,
  });
}

function nodeSnapshot(state: MemoryState, nodeId: string) {
  const node = state.nodes.get(nodeId);
  return node
    ? {
        parentId: node.parentId,
        kind: node.kind,
        title: node.title,
        visibility: node.visibility,
        positionToken: node.positionToken,
        resourceRevision: node.resourceRevision,
        childrenRevision: node.childrenRevision,
        deleted: node.deletedAt !== null,
        deletedCommitOrdinal: node.deletedCommitOrdinal ?? null,
      }
    : null;
}

defineCollectionNodeCreateDeleteWriteContract({
  name: 'memory collection-node create/delete write adapter',
  createAdapter: () => {
    const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
    const state = createState();
    seedMemoryFixture(state);
    const ports = createMemoryPorts(state, {
      bookmarkIconsCollectionId: fixture.collectionId,
    });
    return {
      create: (input) => createCollectionNode(ports, input),
      delete: (input) => deleteCollectionNode(ports, input),
      snapshot: async () => {
        const collection = state.collections.get(fixture.collectionId)!;
        return {
          nodes: {
            [fixture.leafId]: nodeSnapshot(state, fixture.leafId),
            [fixture.folderId]: nodeSnapshot(state, fixture.folderId),
            [fixture.childId]: nodeSnapshot(state, fixture.childId),
            [fixture.newNodeId]: nodeSnapshot(state, fixture.newNodeId),
          },
          rootChildrenRevision: state.nodes.get(fixture.rootId)!.childrenRevision,
          collection: {
            contentRevision: collection.contentRevision,
            policyRevision: collection.policyRevision,
            commitOrdinal: collection.commitOrdinal,
          },
          reservedResourceIds: state.ledger.map((row) => row.resourceId).sort(),
          evidence: {
            receipts: state.receipts.size,
            resourceRevisions: state.resourceRevisions.length,
            contentRevisions: state.contentRevisions.length,
            policyRevisions: state.policyRevisions.length,
            childrenRevisions: state.childrenRevisions.length,
            operations: state.operations.length,
            audit: state.audit.length,
            outbox: state.outbox.length,
          },
          operationTypes: state.operations.map((row) => row.operationType),
          auditEventTypes: state.audit.map((row) => row.eventType),
          createdOutboxEventTypes: state.outbox
            .filter((row) => row.handlerName === 'node_created_projection')
            .map((row) => row.eventType),
          deletedOutboxEventTypes: state.outbox
            .filter((row) => row.handlerName === 'node_deleted_projection')
            .map((row) => row.eventType),
        };
      },
    };
  },
});

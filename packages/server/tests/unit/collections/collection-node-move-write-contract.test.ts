import { moveCollectionNode } from '../../../src/modules/collections/index.js';
import {
  COLLECTION_NODE_MOVE_CONTRACT_FIXTURE,
  defineCollectionNodeMoveWriteContract,
} from '../../contracts/collection-node-move-write.contract.js';
import {
  createMemoryPorts,
  createState,
  type MemoryState,
} from '../../support/move-collection-node-memory.js';

function seedMemoryFixture(state: MemoryState): void {
  const fixture = COLLECTION_NODE_MOVE_CONTRACT_FIXTURE;
  const createdAt = new Date(state.now);
  state.collections.set(fixture.collectionId, {
    id: fixture.collectionId,
    ownerSubjectId: fixture.ownerSubjectId,
    title: 'Collection node move contract',
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

  const common = {
    collectionId: fixture.collectionId,
    kind: 'folder' as const,
    url: null,
    description: null,
    tags: [],
    visibility: 'inherit' as const,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  state.nodes.set(fixture.rootId, {
    ...common,
    id: fixture.rootId,
    parentId: null,
    isRoot: true,
    title: 'Root',
    positionToken: null,
    resourceRevision: fixture.rootResourceRevision,
    childrenRevision: fixture.rootChildrenRevision,
  });
  state.nodes.set(fixture.folderId, {
    ...common,
    id: fixture.folderId,
    parentId: fixture.rootId,
    isRoot: false,
    title: 'Folder',
    positionToken: 'a',
    resourceRevision: fixture.folderResourceRevision,
    childrenRevision: fixture.folderChildrenRevision,
  });
  state.nodes.set(fixture.childId, {
    ...common,
    id: fixture.childId,
    parentId: fixture.folderId,
    isRoot: false,
    title: 'Child',
    positionToken: 'a',
    resourceRevision: fixture.childResourceRevision,
    childrenRevision: fixture.childChildrenRevision,
  });
  state.nodes.set(fixture.targetId, {
    ...common,
    id: fixture.targetId,
    parentId: fixture.rootId,
    isRoot: false,
    title: 'Move target',
    positionToken: 'm',
    resourceRevision: fixture.targetResourceRevision,
    childrenRevision: fixture.targetChildrenRevision,
  });
}

defineCollectionNodeMoveWriteContract({
  name: 'memory collection-node move write adapter',
  createAdapter: () => {
    const fixture = COLLECTION_NODE_MOVE_CONTRACT_FIXTURE;
    const state = createState();
    seedMemoryFixture(state);
    const ports = createMemoryPorts(state);
    return {
      execute: (input) => moveCollectionNode(ports, input),
      snapshot: async () => {
        const target = state.nodes.get(fixture.targetId)!;
        const folder = state.nodes.get(fixture.folderId)!;
        const sourceParent = state.nodes.get(fixture.rootId)!;
        const targetParent = state.nodes.get(fixture.folderId)!;
        const collection = state.collections.get(fixture.collectionId)!;
        return {
          target: {
            parentId: target.parentId,
            positionToken: target.positionToken,
            resourceRevision: target.resourceRevision,
          },
          folderParentId: folder.parentId,
          sourceParentChildrenRevision: sourceParent.childrenRevision,
          targetParentChildrenRevision: targetParent.childrenRevision,
          collection: {
            contentRevision: collection.contentRevision,
            policyRevision: collection.policyRevision,
            commitOrdinal: collection.commitOrdinal,
          },
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
          primaryOutboxEventTypes: state.outbox
            .filter((row) => row.handlerName === 'node_moved_projection')
            .map((row) => row.eventType),
        };
      },
    };
  },
});

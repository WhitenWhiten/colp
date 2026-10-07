import { updateCollectionNode } from '../../../src/modules/collections/index.js';
import {
  COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE,
  defineCollectionNodeUpdateWriteContract,
} from '../../contracts/collection-node-update-write.contract.js';
import {
  createMemoryPorts,
  createState,
} from '../../support/update-collection-node-memory.js';

defineCollectionNodeUpdateWriteContract({
  name: 'memory collection-node update write adapter',
  createAdapter: () => {
    const fixture = COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE;
    const state = createState();
    const createdAt = new Date(state.now);
    state.collections.set(fixture.collectionId, {
      id: fixture.collectionId,
      ownerSubjectId: fixture.ownerSubjectId,
      title: 'Collection node adapter contract',
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
    state.nodes.set(fixture.rootId, {
      id: fixture.rootId,
      collectionId: fixture.collectionId,
      parentId: null,
      kind: 'folder',
      isRoot: true,
      title: 'Root title',
      url: null,
      description: null,
      tags: [],
      visibility: 'inherit',
      positionToken: null,
      resourceRevision: fixture.rootResourceRevision,
      childrenRevision: fixture.rootChildrenRevision,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    });
    state.nodes.set(fixture.nodeId, {
      id: fixture.nodeId,
      collectionId: fixture.collectionId,
      parentId: fixture.rootId,
      kind: 'folder',
      isRoot: false,
      title: 'Folder title',
      url: null,
      description: 'contract description',
      tags: ['before'],
      visibility: 'inherit',
      positionToken: 'U',
      resourceRevision: fixture.nodeResourceRevision,
      childrenRevision: fixture.nodeChildrenRevision,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    });
    state.memberships.push(
      { collectionId: fixture.collectionId, subjectId: fixture.ownerSubjectId, role: 'owner' },
      { collectionId: fixture.collectionId, subjectId: fixture.editorSubjectId, role: 'editor' },
      { collectionId: fixture.collectionId, subjectId: fixture.viewerSubjectId, role: 'viewer' },
    );
    const ports = createMemoryPorts(state);

    return {
      execute: (input) => updateCollectionNode(ports, input),
      snapshot: async () => {
        const node = state.nodes.get(fixture.nodeId)!;
        const collection = state.collections.get(fixture.collectionId)!;
        return {
          node: {
            title: node.title,
            url: node.url,
            description: node.description,
            tags: [...node.tags],
            visibility: node.visibility,
            resourceRevision: node.resourceRevision,
            childrenRevision: node.childrenRevision,
          },
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
            .filter((row) => row.handlerName === 'node_updated_projection')
            .map((row) => row.eventType),
        };
      },
    };
  },
});

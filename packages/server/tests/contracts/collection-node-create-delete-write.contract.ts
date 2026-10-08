import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  NODE_CREATED_EVENT_TYPE,
  NODE_DELETED_EVENT_TYPE,
  createCollectionNodeCommandScope,
  deleteCollectionNodeCommandScope,
  strongEntityTag,
  type CreateCollectionNodeInput,
  type CreateCollectionNodeResult,
  type DeleteCollectionNodeInput,
  type DeleteCollectionNodeResult,
} from '../../src/modules/collections/index.js';
import type { CollectionNodeContractEvidenceCounts } from '../support/collection-node-contract-postgres.js';

export const COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE = Object.freeze({
  collectionId: 'EhISEhISEhISEhISEhISEg',
  rootId: 'ExMTExMTExMTExMTExMTEx',
  leafId: 'FBQUFBQUFBQUFBQUFBQUFA',
  folderId: 'FRUVFRUVFRUVFRUVFRUVFQ',
  childId: 'FhYWFhYWFhYWFhYWFhYWFg',
  newNodeId: 'FxcXFxcXFxcXFxcXFxcXFw',
  ownerPrincipalId: 'GBgYGBgYGBgYGBgYGBgYGA',
  ownerSubjectId: 'GRkZGRkZGRkZGRkZGRkZGQ',
  collectionResourceRevision: 'write-collection-resource-r1',
  contentRevision: 'write-content-r1',
  policyRevision: 'write-policy-r1',
  rootResourceRevision: 'write-root-resource-r1',
  rootChildrenRevision: 'write-root-children-r1',
  leafResourceRevision: 'write-leaf-resource-r1',
  leafChildrenRevision: 'write-leaf-children-r1',
  folderResourceRevision: 'write-folder-resource-r1',
  folderChildrenRevision: 'write-folder-children-r1',
  childResourceRevision: 'write-child-resource-r1',
  childChildrenRevision: 'write-child-children-r1',
  createCommandId: '81818181-8181-4181-8181-818181818181',
  createOperationId: '82828282-8282-4282-8282-828282828282',
  deleteCommandId: '83838383-8383-4383-8383-838383838383',
  deleteOperationId: '84848484-8484-4484-8484-848484848484',
  recursiveDeleteCommandId: '85858585-8585-4585-8585-858585858585',
  recursiveDeleteOperationId: '86868686-8686-4686-8686-868686868686',
  fingerprint: 'e'.repeat(64),
});

export interface CollectionNodeCreateDeleteNodeSnapshot {
  readonly parentId: string | null;
  readonly kind: string;
  readonly title: string;
  readonly visibility: string;
  readonly positionToken: string | null;
  readonly resourceRevision: string;
  readonly childrenRevision: string;
  readonly deleted: boolean;
  readonly deletedCommitOrdinal: bigint | null;
}

export interface CollectionNodeCreateDeleteContractSnapshot {
  readonly nodes: Readonly<Record<string, CollectionNodeCreateDeleteNodeSnapshot | null>>;
  readonly rootChildrenRevision: string;
  readonly collection: {
    readonly contentRevision: string;
    readonly policyRevision: string;
    readonly commitOrdinal: bigint;
  };
  readonly reservedResourceIds: readonly string[];
  readonly evidence: CollectionNodeContractEvidenceCounts;
  readonly operationTypes: readonly string[];
  readonly auditEventTypes: readonly string[];
  readonly createdOutboxEventTypes: readonly string[];
  readonly deletedOutboxEventTypes: readonly string[];
}

export interface CollectionNodeCreateDeleteContractAdapter {
  readonly create: (input: CreateCollectionNodeInput) => Promise<CreateCollectionNodeResult>;
  readonly delete: (input: DeleteCollectionNodeInput) => Promise<DeleteCollectionNodeResult>;
  readonly snapshot: () => Promise<CollectionNodeCreateDeleteContractSnapshot>;
}

export interface CollectionNodeCreateDeleteWriteContractOptions {
  readonly name: string;
  readonly createAdapter: () => CollectionNodeCreateDeleteContractAdapter
    | Promise<CollectionNodeCreateDeleteContractAdapter>;
}

function createInput(
  overrides: Partial<CreateCollectionNodeInput> = {},
): CreateCollectionNodeInput {
  const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
  const collectionId = overrides.collectionId ?? fixture.collectionId;
  return {
    actor: {
      principalId: fixture.ownerPrincipalId,
      principalType: 'account',
      subjectId: fixture.ownerSubjectId,
      ...overrides.actor,
    },
    command: {
      commandId: fixture.createCommandId,
      fingerprint: fixture.fingerprint,
      commandScope: createCollectionNodeCommandScope(collectionId),
      ...overrides.command,
    },
    collectionId,
    parentId: overrides.parentId ?? fixture.rootId,
    afterId: overrides.afterId === undefined ? fixture.folderId : overrides.afterId,
    beforeId: overrides.beforeId ?? null,
    node: overrides.node ?? {
      kind: 'folder',
      title: 'Contract-created folder',
      description: 'shared memory/PostgreSQL contract',
      tags: ['contract'],
      visibility: 'protected',
    },
    nodeId: overrides.nodeId ?? fixture.newNodeId,
    operationId: overrides.operationId ?? fixture.createOperationId,
  };
}

function deleteInput(
  overrides: Partial<DeleteCollectionNodeInput> = {},
): DeleteCollectionNodeInput {
  const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
  const collectionId = overrides.collectionId ?? fixture.collectionId;
  const nodeId = overrides.nodeId ?? fixture.leafId;
  const recursive = overrides.recursive ?? false;
  const resourceRevision = nodeId === fixture.folderId
    ? fixture.folderResourceRevision
    : fixture.leafResourceRevision;
  return {
    actor: {
      principalId: fixture.ownerPrincipalId,
      principalType: 'account',
      subjectId: fixture.ownerSubjectId,
      ...overrides.actor,
    },
    command: {
      commandId: recursive ? fixture.recursiveDeleteCommandId : fixture.deleteCommandId,
      fingerprint: fixture.fingerprint,
      commandScope: deleteCollectionNodeCommandScope(collectionId, nodeId),
      ...overrides.command,
    },
    collectionId,
    nodeId,
    ifMatch: overrides.ifMatch ?? strongEntityTag(resourceRevision),
    recursive,
    ifContentMatch: Object.hasOwn(overrides, 'ifContentMatch')
      ? overrides.ifContentMatch
      : recursive
        ? strongEntityTag(fixture.contentRevision)
        : null,
    operationId: overrides.operationId
      ?? (recursive ? fixture.recursiveDeleteOperationId : fixture.deleteOperationId),
  };
}

function assertCreated(
  result: CreateCollectionNodeResult,
): Extract<CreateCollectionNodeResult, { readonly kind: 'created' }> {
  assert.equal(result.kind, 'created');
  return result as Extract<CreateCollectionNodeResult, { readonly kind: 'created' }>;
}

function assertDeleted(
  result: DeleteCollectionNodeResult,
): Extract<DeleteCollectionNodeResult, { readonly kind: 'deleted' }> {
  assert.equal(result.kind, 'deleted');
  return result as Extract<DeleteCollectionNodeResult, { readonly kind: 'deleted' }>;
}

/** Runs identical create/delete persistence assertions against both adapters. */
export function defineCollectionNodeCreateDeleteWriteContract(
  options: CollectionNodeCreateDeleteWriteContractOptions,
): void {
  describe(options.name, () => {
    test('creates a folder with node, parent, policy, ledger, and evidence writes', async () => {
      const adapter = await options.createAdapter();
      const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
      const result = assertCreated(await adapter.create(createInput()));
      const snapshot = await adapter.snapshot();
      const created = snapshot.nodes[fixture.newNodeId];
      assert.ok(created);

      assert.equal(created.parentId, fixture.rootId);
      assert.equal(created.kind, 'folder');
      assert.equal(created.title, 'Contract-created folder');
      assert.equal(created.visibility, 'protected');
      assert.equal(created.positionToken, result.node.position);
      assert.equal(created.resourceRevision, result.node.revision);
      assert.equal(created.childrenRevision, result.node.childrenRevision);
      assert.equal(created.deleted, false);
      assert.notEqual(snapshot.rootChildrenRevision, fixture.rootChildrenRevision);
      assert.equal(snapshot.rootChildrenRevision, result.parent.childrenRevision);
      assert.equal(snapshot.collection.contentRevision, result.fence.contentRevision);
      assert.equal(snapshot.collection.policyRevision, result.fence.policyRevision);
      assert.notEqual(snapshot.collection.contentRevision, fixture.contentRevision);
      assert.notEqual(snapshot.collection.policyRevision, fixture.policyRevision);
      assert.equal(snapshot.collection.commitOrdinal, 3n);
      assert.equal(result.commitOrdinal, 3n);
      assert.ok(snapshot.reservedResourceIds.includes(fixture.newNodeId));
      assert.ok(snapshot.reservedResourceIds.includes(fixture.createOperationId));
      assert.deepEqual(snapshot.operationTypes, ['resource.create']);
      assert.deepEqual(snapshot.auditEventTypes, ['resource.create']);
      assert.deepEqual(snapshot.createdOutboxEventTypes, [NODE_CREATED_EVENT_TYPE]);
      assert.deepEqual(
        {
          receipts: snapshot.evidence.receipts,
          resourceRevisions: snapshot.evidence.resourceRevisions,
          contentRevisions: snapshot.evidence.contentRevisions,
          policyRevisions: snapshot.evidence.policyRevisions,
          childrenRevisions: snapshot.evidence.childrenRevisions,
          operations: snapshot.evidence.operations,
          audit: snapshot.evidence.audit,
        },
        {
          receipts: 1,
          resourceRevisions: 1,
          contentRevisions: 1,
          policyRevisions: 1,
          childrenRevisions: 2,
          operations: 1,
          audit: 1,
        },
      );
    });

    test('soft-deletes one leaf while retaining its global identity reservation', async () => {
      const adapter = await options.createAdapter();
      const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
      const result = assertDeleted(await adapter.delete(deleteInput()));
      const snapshot = await adapter.snapshot();
      const deleted = snapshot.nodes[fixture.leafId];
      assert.ok(deleted);

      assert.equal(deleted.deleted, true);
      assert.equal(deleted.deletedCommitOrdinal, 3n);
      assert.equal(deleted.resourceRevision, result.receipt.deleteRevision);
      assert.notEqual(snapshot.rootChildrenRevision, fixture.rootChildrenRevision);
      assert.equal(snapshot.collection.contentRevision, result.fence.contentRevision);
      assert.equal(snapshot.collection.policyRevision, fixture.policyRevision);
      assert.equal(snapshot.collection.commitOrdinal, 3n);
      assert.ok(snapshot.reservedResourceIds.includes(fixture.leafId));
      assert.ok(snapshot.reservedResourceIds.includes(fixture.deleteOperationId));
      assert.deepEqual(snapshot.operationTypes, ['resource.delete']);
      assert.deepEqual(snapshot.auditEventTypes, ['resource.delete']);
      assert.deepEqual(snapshot.deletedOutboxEventTypes, [NODE_DELETED_EVENT_TYPE]);
      assert.deepEqual(
        {
          receipts: snapshot.evidence.receipts,
          resourceRevisions: snapshot.evidence.resourceRevisions,
          contentRevisions: snapshot.evidence.contentRevisions,
          policyRevisions: snapshot.evidence.policyRevisions,
          childrenRevisions: snapshot.evidence.childrenRevisions,
          operations: snapshot.evidence.operations,
          audit: snapshot.evidence.audit,
        },
        {
          receipts: 1,
          resourceRevisions: 1,
          contentRevisions: 1,
          policyRevisions: 0,
          childrenRevisions: 1,
          operations: 1,
          audit: 1,
        },
      );
    });

    test('soft-deletes a recursive subtree at one ordinal with one summary event', async () => {
      const adapter = await options.createAdapter();
      const fixture = COLLECTION_NODE_CREATE_DELETE_CONTRACT_FIXTURE;
      const result = assertDeleted(await adapter.delete(deleteInput({
        nodeId: fixture.folderId,
        recursive: true,
      })));
      const snapshot = await adapter.snapshot();
      const folder = snapshot.nodes[fixture.folderId];
      const child = snapshot.nodes[fixture.childId];
      assert.ok(folder && child);

      assert.equal(folder.deleted, true);
      assert.equal(child.deleted, true);
      assert.equal(folder.deletedCommitOrdinal, 3n);
      assert.equal(child.deletedCommitOrdinal, 3n);
      assert.equal(snapshot.collection.commitOrdinal, 3n);
      assert.equal(result.receipt.scope, 'subtree');
      assert.equal(result.receipt.targetId, fixture.folderId);
      assert.equal(result.receipt.affectedCount, 2);
      assert.ok(snapshot.reservedResourceIds.includes(fixture.folderId));
      assert.ok(snapshot.reservedResourceIds.includes(fixture.childId));
      assert.deepEqual(snapshot.operationTypes, ['resource.delete']);
      assert.deepEqual(snapshot.auditEventTypes, ['resource.delete']);
      assert.deepEqual(snapshot.deletedOutboxEventTypes, [NODE_DELETED_EVENT_TYPE]);
      assert.equal(snapshot.evidence.resourceRevisions, 2);
      assert.equal(snapshot.evidence.contentRevisions, 1);
      assert.equal(snapshot.evidence.childrenRevisions, 1);
      assert.equal(snapshot.evidence.operations, 1);
      assert.equal(snapshot.evidence.audit, 1);
    });
  });
}

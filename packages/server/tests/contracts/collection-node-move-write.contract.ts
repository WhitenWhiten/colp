import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  NODE_MOVED_EVENT_TYPE,
  moveCollectionNodeCommandScope,
  strongEntityTag,
  type MoveCollectionNodeInput,
  type MoveCollectionNodeResult,
} from '../../src/modules/collections/index.js';
import type { CollectionNodeContractEvidenceCounts } from '../support/collection-node-contract-postgres.js';

export const COLLECTION_NODE_MOVE_CONTRACT_FIXTURE = Object.freeze({
  collectionId: 'CwsLCwsLCwsLCwsLCwsLCw',
  rootId: 'DAwMDAwMDAwMDAwMDAwMDA',
  folderId: 'DQ0NDQ0NDQ0NDQ0NDQ0NDQ',
  childId: 'Dg4ODg4ODg4ODg4ODg4ODg',
  targetId: 'Dw8PDw8PDw8PDw8PDw8PDw',
  ownerPrincipalId: 'EBAQEBAQEBAQEBAQEBAQEA',
  ownerSubjectId: 'EREREREREREREREREREREQ',
  collectionResourceRevision: 'move-collection-resource-r1',
  contentRevision: 'move-content-r1',
  policyRevision: 'move-policy-r1',
  rootResourceRevision: 'move-root-resource-r1',
  rootChildrenRevision: 'move-root-children-r1',
  folderResourceRevision: 'move-folder-resource-r1',
  folderChildrenRevision: 'move-folder-children-r1',
  childResourceRevision: 'move-child-resource-r1',
  childChildrenRevision: 'move-child-children-r1',
  targetResourceRevision: 'move-target-resource-r1',
  targetChildrenRevision: 'move-target-children-r1',
  commandId: '61616161-6161-4161-8161-616161616161',
  operationId: '62626262-6262-4262-8262-626262626262',
  fingerprint: 'c'.repeat(64),
});

export interface CollectionNodeMoveContractSnapshot {
  readonly target: {
    readonly parentId: string | null;
    readonly positionToken: string | null;
    readonly resourceRevision: string;
  };
  readonly folderParentId: string | null;
  readonly sourceParentChildrenRevision: string;
  readonly targetParentChildrenRevision: string;
  readonly collection: {
    readonly contentRevision: string;
    readonly policyRevision: string;
    readonly commitOrdinal: bigint;
  };
  readonly evidence: CollectionNodeContractEvidenceCounts;
  readonly operationTypes: readonly string[];
  readonly auditEventTypes: readonly string[];
  readonly primaryOutboxEventTypes: readonly string[];
}

export interface CollectionNodeMoveContractAdapter {
  readonly execute: (input: MoveCollectionNodeInput) => Promise<MoveCollectionNodeResult>;
  readonly snapshot: () => Promise<CollectionNodeMoveContractSnapshot>;
}

export interface CollectionNodeMoveWriteContractOptions {
  readonly name: string;
  readonly createAdapter: () => CollectionNodeMoveContractAdapter
    | Promise<CollectionNodeMoveContractAdapter>;
}

function input(overrides: Partial<MoveCollectionNodeInput> = {}): MoveCollectionNodeInput {
  const fixture = COLLECTION_NODE_MOVE_CONTRACT_FIXTURE;
  const collectionId = overrides.collectionId ?? fixture.collectionId;
  const nodeId = overrides.nodeId ?? fixture.targetId;
  return {
    actor: {
      principalId: fixture.ownerPrincipalId,
      principalType: 'account',
      subjectId: fixture.ownerSubjectId,
      ...overrides.actor,
    },
    command: {
      commandId: fixture.commandId,
      fingerprint: fixture.fingerprint,
      commandScope: moveCollectionNodeCommandScope(collectionId, nodeId),
      ...overrides.command,
    },
    collectionId,
    nodeId,
    ifMatch: overrides.ifMatch ?? strongEntityTag(fixture.targetResourceRevision),
    newParentId: overrides.newParentId ?? fixture.folderId,
    afterId: overrides.afterId === undefined ? fixture.childId : overrides.afterId,
    beforeId: overrides.beforeId ?? null,
    baseSourceParentRevision:
      overrides.baseSourceParentRevision ?? fixture.rootChildrenRevision,
    baseTargetParentRevision:
      overrides.baseTargetParentRevision ?? fixture.folderChildrenRevision,
    operationId: overrides.operationId ?? fixture.operationId,
  };
}

function assertMoved(
  result: MoveCollectionNodeResult,
): Extract<MoveCollectionNodeResult, { readonly kind: 'moved' }> {
  assert.equal(result.kind, 'moved');
  return result as Extract<MoveCollectionNodeResult, { readonly kind: 'moved' }>;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { readonly code: unknown }).code)
    : undefined;
}

/** Runs identical tree-move assertions against memory and PostgreSQL. */
export function defineCollectionNodeMoveWriteContract(
  options: CollectionNodeMoveWriteContractOptions,
): void {
  describe(options.name, () => {
    test('moves across parents and advances both children fences atomically', async () => {
      const adapter = await options.createAdapter();
      const fixture = COLLECTION_NODE_MOVE_CONTRACT_FIXTURE;
      const result = assertMoved(await adapter.execute(input()));
      const snapshot = await adapter.snapshot();

      assert.equal(snapshot.target.parentId, fixture.folderId);
      assert.equal(snapshot.target.positionToken, result.node.position);
      assert.equal(snapshot.target.resourceRevision, result.node.revision);
      assert.ok((snapshot.target.positionToken ?? '') > 'a');
      assert.notEqual(snapshot.sourceParentChildrenRevision, fixture.rootChildrenRevision);
      assert.notEqual(snapshot.targetParentChildrenRevision, fixture.folderChildrenRevision);
      assert.notEqual(
        snapshot.sourceParentChildrenRevision,
        snapshot.targetParentChildrenRevision,
      );
      assert.equal(snapshot.sourceParentChildrenRevision, result.sourceParent.childrenRevision);
      assert.equal(snapshot.targetParentChildrenRevision, result.targetParent.childrenRevision);
      assert.equal(snapshot.collection.contentRevision, result.fence.contentRevision);
      assert.notEqual(snapshot.collection.contentRevision, fixture.contentRevision);
      assert.equal(snapshot.collection.policyRevision, fixture.policyRevision);
      assert.equal(snapshot.collection.commitOrdinal, 3n);
      assert.equal(result.commitOrdinal, 3n);
      assert.deepEqual(snapshot.operationTypes, ['resource.move']);
      assert.deepEqual(snapshot.auditEventTypes, ['resource.move']);
      assert.deepEqual(snapshot.primaryOutboxEventTypes, [NODE_MOVED_EVENT_TYPE]);
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
          childrenRevisions: 2,
          operations: 1,
          audit: 1,
        },
      );
    });

    test('replays an identical move without another position or fence write', async () => {
      const adapter = await options.createAdapter();
      assertMoved(await adapter.execute(input()));
      const afterFirst = await adapter.snapshot();

      const replay = await adapter.execute(input());
      assert.equal(replay.kind, 'replay');
      assert.deepEqual(await adapter.snapshot(), afterFirst);
    });

    test('rejects moving a folder below its own descendant without tree evidence', async () => {
      const adapter = await options.createAdapter();
      const fixture = COLLECTION_NODE_MOVE_CONTRACT_FIXTURE;
      await assert.rejects(
        () => adapter.execute(input({
          nodeId: fixture.folderId,
          ifMatch: strongEntityTag(fixture.folderResourceRevision),
          newParentId: fixture.childId,
          afterId: null,
          baseTargetParentRevision: fixture.childChildrenRevision,
          command: {
            commandId: '63636363-6363-4363-8363-636363636363',
            fingerprint: 'd'.repeat(64),
          },
          operationId: '64646464-6464-4464-8464-646464646464',
        })),
        (error: unknown) => errorCode(error) === 'invalid_node_parent',
      );
      const snapshot = await adapter.snapshot();
      assert.equal(snapshot.folderParentId, fixture.rootId);
      assert.equal(snapshot.collection.commitOrdinal, 2n);
      assert.equal(snapshot.evidence.operations, 0);
      assert.equal(snapshot.evidence.audit, 0);
      assert.equal(snapshot.evidence.outbox, 0);
      assert.equal(snapshot.evidence.resourceRevisions, 0);
      assert.equal(snapshot.evidence.contentRevisions, 0);
      assert.equal(snapshot.evidence.childrenRevisions, 0);
    });
  });
}

import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  NODE_UPDATED_EVENT_TYPE,
  strongEntityTag,
  updateCollectionNodeCommandScope,
  type UpdateCollectionNodeInput,
  type UpdateCollectionNodeResult,
} from '../../src/modules/collections/index.js';
import type { CollectionNodeContractEvidenceCounts } from '../support/collection-node-contract-postgres.js';

export const COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE = Object.freeze({
  collectionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
  rootId: 'AgICAgICAgICAgICAgICAg',
  nodeId: 'AwMDAwMDAwMDAwMDAwMDAw',
  ownerPrincipalId: 'BAQEBAQEBAQEBAQEBAQEBA',
  ownerSubjectId: 'BQUFBQUFBQUFBQUFBQUFBQ',
  editorPrincipalId: 'BgYGBgYGBgYGBgYGBgYGBg',
  editorSubjectId: 'BwcHBwcHBwcHBwcHBwcHBw',
  viewerPrincipalId: 'CAgICAgICAgICAgICAgICA',
  viewerSubjectId: 'CQkJCQkJCQkJCQkJCQkJCQ',
  collectionResourceRevision: 'collection-resource-rev',
  contentRevision: 'collection-content-rev',
  policyRevision: 'collection-policy-rev',
  rootResourceRevision: 'root-resource-rev-1',
  rootChildrenRevision: 'root-children',
  nodeResourceRevision: 'folder-resource-rev-1',
  nodeChildrenRevision: 'folder-children',
  commandId: '5de3947e-6271-4fdf-a946-d22e58a99c2a',
  operationId: '79797979-7979-4979-8979-797979797979',
  fingerprint: 'a'.repeat(64),
});

export interface CollectionNodeUpdateContractSnapshot {
  readonly node: {
    readonly title: string;
    readonly url: string | null;
    readonly description: string | null;
    readonly tags: readonly string[];
    readonly visibility: string;
    readonly resourceRevision: string;
    readonly childrenRevision: string;
  };
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

export interface CollectionNodeUpdateContractAdapter {
  readonly execute: (input: UpdateCollectionNodeInput) => Promise<UpdateCollectionNodeResult>;
  readonly snapshot: () => Promise<CollectionNodeUpdateContractSnapshot>;
}

export interface CollectionNodeUpdateWriteContractOptions {
  readonly name: string;
  readonly createAdapter: () => CollectionNodeUpdateContractAdapter
    | Promise<CollectionNodeUpdateContractAdapter>;
}

function input(
  overrides: Partial<UpdateCollectionNodeInput> = {},
): UpdateCollectionNodeInput {
  const fixture = COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE;
  const collectionId = overrides.collectionId ?? fixture.collectionId;
  const nodeId = overrides.nodeId ?? fixture.nodeId;
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
      commandScope: updateCollectionNodeCommandScope(collectionId, nodeId),
      ...overrides.command,
    },
    collectionId,
    nodeId,
    ifMatch: overrides.ifMatch ?? strongEntityTag(fixture.nodeResourceRevision),
    patch: overrides.patch ?? { title: 'Updated folder' },
    operationId: overrides.operationId ?? fixture.operationId,
  };
}

function assertUpdated(
  result: UpdateCollectionNodeResult,
): Extract<UpdateCollectionNodeResult, { readonly kind: 'updated' }> {
  assert.equal(result.kind, 'updated');
  return result as Extract<UpdateCollectionNodeResult, { readonly kind: 'updated' }>;
}

/** Runs identical persisted-write assertions against memory and PostgreSQL. */
export function defineCollectionNodeUpdateWriteContract(
  options: CollectionNodeUpdateWriteContractOptions,
): void {
  describe(options.name, () => {
    test('persists a merged node, advances the right fences, and emits core evidence', async () => {
      const adapter = await options.createAdapter();
      const fixture = COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE;
      const result = assertUpdated(await adapter.execute(input({
        patch: {
          title: 'Contract updated',
          description: null,
          tags: ['contract', 'shared'],
          visibility: 'protected',
        },
      })));
      const snapshot = await adapter.snapshot();

      assert.deepEqual(snapshot.node, {
        title: 'Contract updated',
        url: null,
        description: null,
        tags: ['contract', 'shared'],
        visibility: 'protected',
        resourceRevision: result.node.revision,
        childrenRevision: fixture.nodeChildrenRevision,
      });
      assert.equal(snapshot.collection.contentRevision, result.fence.contentRevision);
      assert.equal(snapshot.collection.policyRevision, result.fence.policyRevision);
      assert.notEqual(snapshot.collection.contentRevision, fixture.contentRevision);
      assert.notEqual(snapshot.collection.policyRevision, fixture.policyRevision);
      assert.equal(snapshot.collection.commitOrdinal, 3n);
      assert.equal(result.commitOrdinal, 3n);
      assert.deepEqual(snapshot.operationTypes, ['resource.update']);
      assert.deepEqual(snapshot.auditEventTypes, ['resource.update']);
      assert.deepEqual(snapshot.primaryOutboxEventTypes, [NODE_UPDATED_EVENT_TYPE]);
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
          childrenRevisions: 0,
          operations: 1,
          audit: 1,
        },
      );
    });

    test('replays the same command and rejects fingerprint reuse without another write', async () => {
      const adapter = await options.createAdapter();
      const first = assertUpdated(await adapter.execute(input()));
      const afterFirst = await adapter.snapshot();

      const replay = await adapter.execute(input());
      assert.equal(replay.kind, 'replay');
      if (replay.kind === 'replay') {
        assert.equal(replay.status, 200);
        assert.equal(replay.targetIdentity, COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE.nodeId);
      }
      assert.deepEqual(await adapter.snapshot(), afterFirst);

      const reused = await adapter.execute(input({
        ifMatch: strongEntityTag(first.node.revision),
        patch: { title: 'Different intent' },
        command: {
          commandId: COLLECTION_NODE_UPDATE_CONTRACT_FIXTURE.commandId,
          fingerprint: 'b'.repeat(64),
        },
      }));
      assert.equal(reused.kind, 'reused');
      assert.deepEqual(await adapter.snapshot(), afterFirst);
    });
  });
}

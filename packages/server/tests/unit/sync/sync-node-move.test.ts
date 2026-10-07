import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Operation } from '@know-n/colp/types';
import {
  evaluateSyncNodeMove,
  SyncNodeMoveError,
  type TrustedSyncMoveNode,
  type TrustedSyncMoveParent,
} from '../../../src/modules/sync/sync-node-move.js';
import { syncNodeMovePushRequest } from '../../fixtures/phase3/sync-node-move.js';

function operation(input: Parameters<typeof syncNodeMovePushRequest>[0] = {}): Operation {
  return syncNodeMovePushRequest(input).operations[0]!;
}

function node(input: Partial<TrustedSyncMoveNode> = {}): TrustedSyncMoveNode {
  return {
    id: 'move-node-1', collectionId: 'move-collection-1', parentId: 'move-source-parent-1',
    revision: 'move-node-r1', kind: 'bookmark', isRoot: false, deleted: false,
    ...input,
  };
}

function parent(input: Partial<TrustedSyncMoveParent> = {}): TrustedSyncMoveParent {
  return {
    id: 'move-target-parent-1', collectionId: 'move-collection-1', kind: 'folder',
    childrenRevision: 'target-children-r1', isRoot: false, deleted: false,
    ...input,
  };
}

function expectCode(action: () => unknown, code: SyncNodeMoveError['code']): void {
  assert.throws(action, (error: unknown) => error instanceof SyncNodeMoveError && error.code === code);
}

describe('P3-14 canonical Node move evaluator', () => {
  test('maps same-parent and cross-parent relative positions without treating move as content update', () => {
    const source = parent({ id: 'move-source-parent-1', childrenRevision: 'source-children-r1' });
    const crossParent = evaluateSyncNodeMove(operation({ afterId: 'anchor-a', beforeId: 'anchor-b' }), {
      node: node(), sourceParent: source, targetParent: parent(), targetAncestorIds: ['move-target-parent-1'],
    });
    assert.deepEqual(crossParent, {
      targetId: 'move-node-1', expectedCurrentRevision: 'move-node-r1',
      sourceParentId: 'move-source-parent-1', newParentId: 'move-target-parent-1',
      relativePosition: { afterId: 'anchor-a', beforeId: 'anchor-b' },
    });
    assert.equal('fields' in crossParent, false);

    const same = evaluateSyncNodeMove(operation({
      newParentId: source.id, baseTargetParentRevision: source.childrenRevision,
      afterId: null, beforeId: 'first-child',
    }), { node: node(), sourceParent: source, targetParent: source, targetAncestorIds: [source.id] });
    assert.deepEqual(same.relativePosition, { beforeId: 'first-child' });
  });

  test('rejects stale resource and source/target Children Revision fences', () => {
    const facts = {
      node: node(),
      sourceParent: parent({ id: 'move-source-parent-1', childrenRevision: 'source-children-r1' }),
      targetParent: parent(), targetAncestorIds: ['move-target-parent-1'],
    } as const;
    expectCode(() => evaluateSyncNodeMove(operation({ baseRevision: 'stale-node' }), facts), 'revision_conflict');
    expectCode(() => evaluateSyncNodeMove(operation({ baseSourceParentRevision: 'stale-source' }), facts),
      'position_context_stale');
    expectCode(() => evaluateSyncNodeMove(operation({ baseTargetParentRevision: 'stale-target' }), facts),
      'position_context_stale');
  });

  test('rejects Root, self/descendant cycles, deleted/non-folder parents, and cross-Collection facts', () => {
    const source = parent({ id: 'move-source-parent-1', childrenRevision: 'source-children-r1' });
    const facts = { node: node(), sourceParent: source, targetParent: parent(),
      targetAncestorIds: ['move-target-parent-1'] } as const;
    expectCode(() => evaluateSyncNodeMove(operation(), { ...facts, node: node({ isRoot: true }) }), 'invalid_document');
    expectCode(() => evaluateSyncNodeMove(operation({ newParentId: 'move-node-1' }), {
      ...facts, targetParent: parent({ id: 'move-node-1' }), targetAncestorIds: ['move-node-1'],
    }), 'invalid_document');
    expectCode(() => evaluateSyncNodeMove(operation(), {
      ...facts, node: node({ kind: 'folder' }), targetAncestorIds: ['move-target-parent-1', 'move-node-1'],
    }), 'invalid_document');
    expectCode(() => evaluateSyncNodeMove(operation(), {
      ...facts, targetParent: parent({ kind: 'bookmark' }),
    }), 'invalid_document');
    expectCode(() => evaluateSyncNodeMove(operation(), {
      ...facts, targetParent: parent({ deleted: true }),
    }), 'invalid_document');
    expectCode(() => evaluateSyncNodeMove(operation(), {
      ...facts, targetParent: parent({ collectionId: 'other-collection' }),
    }), 'resource_not_found');
  });

  test('fails closed for malformed payloads, anchors, and non-move operation kinds', () => {
    const source = parent({ id: 'move-source-parent-1', childrenRevision: 'source-children-r1' });
    const facts = { node: node(), sourceParent: source, targetParent: parent(),
      targetAncestorIds: ['move-target-parent-1'] } as const;
    expectCode(() => evaluateSyncNodeMove({ ...operation(), type: 'delete_node' } as Operation, facts),
      'unsupported_operation');
    expectCode(() => evaluateSyncNodeMove({ ...operation(), payload: { ...operation().payload, extra: true } } as Operation,
      facts), 'invalid_document');
    expectCode(() => evaluateSyncNodeMove(operation({ afterId: 'same', beforeId: 'same' }), facts),
      'position_context_stale');
    expectCode(() => evaluateSyncNodeMove({ ...operation(), targetId: undefined } as unknown as Operation, facts),
      'invalid_document');
  });
});

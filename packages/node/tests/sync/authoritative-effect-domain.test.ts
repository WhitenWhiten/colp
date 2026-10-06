import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthoritativePullEffect, Operation, StrictBookmarkNode, SyncPullEventV02 } from '../../src/types/index.js';
import { canonicalAuthoritativeEffectDigest, canonicalAuthoritativeMemberDigest, canonicalOperationDigest, validateAuthoritativePullEvent } from '../../src/sync/index.js';

const time = '2026-09-25T00:00:00Z';
const digest = 'sha-256=:' + 'A'.repeat(43) + '=:';
const hash = (url: string) => 'sha-256=:' + createHash('sha256').update(url).digest('base64') + ':';
type Event = Extract<SyncPullEventV02, { kind: 'operation' }>;
type NodeEffect = Extract<AuthoritativePullEffect, { node: unknown }>;
type NodeOperationType = 'create_node' | 'update_node_content' | 'move_node' | 'restore_node';

function nodeEvent(type: NodeOperationType): { operation: Operation; effect: NodeEffect & { node: StrictBookmarkNode } } {
  const operation = { opId: 'op-1', replicaId: 'replica-1', sequence: 1, collectionId: 'collection-1', occurredAt: time };
  const authority = { opId: operation.opId, replicaId: operation.replicaId, sequence: operation.sequence, collectionId: operation.collectionId, effectId: 'effect-1', status: 'rebased' as const, operationDigest: digest, effectDigest: digest };
  const node = { id: 'node-1', collectionId: 'collection-1', kind: 'bookmark' as const, parentId: 'parent-1', position: 'a', title: 'Server title', url: 'https://example.com/', createdAt: time, updatedAt: time, revision: 'r2' };
  const placement = { parentId: 'parent-1', afterId: null, beforeId: null, position: 'a' };
  const parentRevision = { parentId: 'parent-1', childrenRevision: 'cr2' };
  switch (type) {
    case 'create_node': return {
      operation: { ...operation, type, baseRevision: null, payload: { parentId: 'parent-1', node: { kind: 'bookmark', title: 'Incoming title', url: node.url } } },
      effect: { ...authority, kind: 'node_created', node, placement, parentRevision, nodeChildrenRevision: null },
    };
    case 'update_node_content': return {
      operation: { ...operation, type, targetId: node.id, baseRevision: 'r1', payload: { base: { title: 'Old' }, value: { title: 'Incoming title' } } },
      effect: { ...authority, kind: 'node_content_updated', node },
    };
    case 'move_node': return {
      operation: { ...operation, type, targetId: node.id, baseRevision: 'r1', payload: { newParentId: 'parent-1', afterId: null, beforeId: null, baseSourceParentRevision: 'cr1', baseTargetParentRevision: 'cr1' } },
      effect: { ...authority, kind: 'node_moved', node, placement, parentRevisions: [parentRevision] },
    };
    case 'restore_node': return {
      operation: { ...operation, type, targetId: node.id, baseRevision: 'deleted-r1', payload: { reason: 'restore' } },
      effect: { ...authority, kind: 'node_restored', node, placement, parentRevision, consumedTombstone: tombstone('old-delete') },
    };
  }
}

function tombstone(operationId = 'op-1') {
  return { resourceType: 'node' as const, targetId: 'node-1', collectionId: 'collection-1', scope: 'single' as const, deletedAt: time, deleteRevision: 'deleted-r1', operationId, deleteCursor: 'cursor-1', affectedCount: 1, purgeAfter: '2026-10-25T00:00:00Z' };
}
function seal({ operation, effect }: { operation: Operation; effect: AuthoritativePullEffect }): Event {
  const bound = { ...effect, operationDigest: canonicalOperationDigest(operation) };
  return { cursor: 'cursor-1', kind: 'operation', operation, effect: { ...bound, effectDigest: canonicalAuthoritativeEffectDigest(bound) } } as Event;
}

describe('rehashed authoritative domain constraints [C02]', () => {
  it.each<NodeOperationType>(['create_node', 'update_node_content', 'move_node', 'restore_node'])('%s validates URL hash and rejects self-parent Nodes', type => {
    const fixture = nodeEvent(type);
    if (fixture.effect.node.kind !== 'bookmark') throw new Error('bookmark fixture');
    const bookmark = fixture.effect.node;
    fixture.effect.node = { ...bookmark, urlHash: hash('https://example.com/') };
    expect(() => validateAuthoritativePullEvent(seal(fixture), '0.2')).not.toThrow();
    fixture.effect.node = { ...bookmark, urlHash: hash('https://different.example/') };
    expect(() => validateAuthoritativePullEvent(seal(fixture), '0.2')).toThrow(/urlHash does not match/);
    fixture.effect.node = { ...bookmark, urlHash: hash('https://example.com/'), parentId: fixture.effect.node.id };
    expect(() => validateAuthoritativePullEvent(seal(fixture), '0.2')).toThrow(/own parent/);
  });

  it('binds final create kind without forbidding legitimate rebased content', () => {
    const fixture = nodeEvent('create_node');
    expect(() => validateAuthoritativePullEvent(seal(fixture), '0.2')).not.toThrow();
    if (fixture.operation.type !== 'create_node') throw new Error('create fixture');
    fixture.operation = { ...fixture.operation, payload: { ...fixture.operation.payload, node: { kind: 'folder' as const, title: 'Incoming title' } } };
    expect(() => validateAuthoritativePullEvent(seal(fixture), '0.2')).toThrow(/kind does not match/);
  });

  it.each(['deletion', 'tombstone'] as const)('binds delete_node %s resource type', field => {
    const source = nodeEvent('create_node');
    const operation: Operation = { ...source.operation, type: 'delete_node', targetId: 'node-1', baseRevision: 'r1', payload: { reason: 'delete' } };
    const effect: Extract<AuthoritativePullEffect, { kind: 'node_deleted' }> = {
      ...source.effect, kind: 'node_deleted', deletion: tombstone(), tombstone: tombstone(), parentRevision: { parentId: 'parent-1', childrenRevision: 'cr2' },
    };
    // Only fields belonging to this effect are serialized.
    const { effectId, status, opId, replicaId, sequence, collectionId, operationDigest, effectDigest, kind, deletion, tombstone: retained, parentRevision } = effect;
    const exact = { effectId, status, opId, replicaId, sequence, collectionId, operationDigest, effectDigest, kind, deletion, tombstone: retained, parentRevision };
    expect(() => validateAuthoritativePullEvent(seal({ operation, effect: exact }), '0.2')).not.toThrow();
    exact[field] = { ...exact[field], resourceType: 'annotation' };
    expect(() => validateAuthoritativePullEvent(seal({ operation, effect: exact }), '0.2')).toThrow(/not bound/);
  });

  it('binds restore consumed tombstone type', () => {
    const fixture = nodeEvent('restore_node');
    if (fixture.effect.kind !== 'node_restored') throw new Error('restore fixture');
    fixture.effect.consumedTombstone.resourceType = 'annotation';
    expect(() => validateAuthoritativePullEvent(seal(fixture), '0.2')).toThrow(/not bound/);
  });

  it('binds subtree root tombstone type', () => {
    const source = nodeEvent('create_node');
    const operation: Operation = { ...source.operation, type: 'delete_subtree', targetId: 'node-1', baseRevision: 'r1', payload: { reason: 'delete' } };
    const effect: AuthoritativePullEffect = {
      effectId: 'effect-1', status: 'applied', opId: operation.opId, replicaId: operation.replicaId, sequence: operation.sequence, collectionId: 'collection-1', operationDigest: digest, effectDigest: digest,
      kind: 'subtree_deleted', rootTombstone: { ...tombstone(), scope: 'subtree' },
      members: ['node-1'], memberCount: 1, memberDigest: canonicalAuthoritativeMemberDigest(['node-1']), parentRevision: { parentId: 'parent-1', childrenRevision: 'cr2' },
    };
    expect(() => validateAuthoritativePullEvent(seal({ operation, effect }), '0.2')).not.toThrow();
    effect.rootTombstone.resourceType = 'annotation';
    expect(() => validateAuthoritativePullEvent(seal({ operation, effect }), '0.2')).toThrow(/not bound/);
  });
});

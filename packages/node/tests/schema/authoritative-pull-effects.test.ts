import { describe, expect, it } from 'vitest';

import { createValidatorRegistry } from '../../src/schema/index.js';
import manifestFixture from '../../fixtures/protocol/examples/public-manifest.json' with { type: 'json' };
import sessionResultFixture from '../../fixtures/protocol/examples/sync-session-result.json' with { type: 'json' };

const registry = createValidatorRegistry();
const digestA = `sha-256=:${'A'.repeat(43)}=:`;
const digestB = `sha-256=:${'B'.repeat(43)}=:`;
const timestamp = '2026-07-27T00:00:00Z';

const node = {
  id: 'node-server-1', collectionId: 'collection-1', kind: 'bookmark', parentId: 'folder-2',
  position: 'server-order-1', title: 'Merged title', url: 'https://example.com/',
  createdAt: timestamp, updatedAt: timestamp, revision: 'node-revision-9',
};

function operation(type: string) {
  const common = {
    opId: `op-${type}`, replicaId: 'replica-source', sequence: 7,
    collectionId: 'collection-1', type,
    baseRevision: type === 'create_node' ? null : 'node-revision-8', occurredAt: timestamp,
    payload: type === 'create_node'
      ? { parentId: 'folder-2', afterId: null, beforeId: 'sibling-2', node: { kind: 'bookmark', title: 'Merged title', url: 'https://example.com/' } }
      : type === 'update_node_content'
        ? { base: { title: 'Old' }, value: { title: 'Merged title' } }
        : type === 'move_node'
          ? { newParentId: 'folder-2', afterId: null, beforeId: 'sibling-2', baseSourceParentRevision: 'children-7', baseTargetParentRevision: 'children-11' }
          : type === 'restore_node'
            ? { reason: 'restore' }
          : { reason: 'removed' },
  };
  return type === 'create_node' ? common : { ...common, targetId: 'node-server-1' };
}

const binding = {
  opId: 'op-create_node', replicaId: 'replica-source', sequence: 7,
  collectionId: 'collection-1', operationDigest: digestA,
};

function event(operationValue: ReturnType<typeof operation>, effect: object) {
  return { cursor: 'receiver-bound-cursor', kind: 'operation', operation: operationValue, effect };
}

describe('SYNC-0027 COLP 0.2 authoritative Pull effect schema', () => {
  it('keeps 0.1 exact and negotiates a separate 0.2 Session/Pull contract', () => {
    const effect = { effectId: 'effect-1', status: 'applied', effectDigest: digestB, ...binding,
      kind: 'node_created', node, placement: { parentId: 'folder-2', afterId: null, beforeId: 'sibling-2', position: 'server-order-1' },
      parentRevision: { parentId: 'folder-2', childrenRevision: 'children-12' },
      nodeChildrenRevision: null };
    expect(registry.validate('syncPullEvent', event(operation('create_node'), effect)).valid).toBe(false);
    expect(registry.validate('syncPullEventV02', event(operation('create_node'), effect)).valid).toBe(true);
    expect(registry.validate('syncPullEventV02', { cursor: 'c', kind: 'operation', operation: operation('create_node') }).valid).toBe(false);
    expect(registry.validate('syncSessionRequest', { protocolVersion: '0.2' }).valid).toBe(false);
    expect(registry.validate('syncSessionRequestV02', {
      protocolVersion: '0.2', replica: { replicaId: 'r', name: 'r', kind: 'server', adapter: { profile: 'p', version: '1' }, capabilities: { read: true, write: true, events: true, separator: true, alias: true, annotations: 'native', maxBatchOperations: 1 } },
      scope: 'collection', collection: { collectionId: 'collection-1', lastCursor: null, lastRevision: null, bootstrapMode: 'download' }, clientTime: timestamp,
    }).valid).toBe(true);
  });

  it('keeps the 0.1 Manifest closed and versions the effect-page endpoint separately', () => {
    const manifest = structuredClone(manifestFixture);
    manifest.protocolVersions = ['0.1', '0.2'];
    (manifest.mounts[0]!.endpoints as unknown as Record<string, string>).syncEffectPages =
      'https://alice.example/collections/-/sync/effects/{effectId}/pages/{pageNumber}';
    expect(registry.validate('manifest', manifest).valid).toBe(false);
    delete (manifest.mounts[0]!.endpoints as unknown as Record<string, string>).syncEffectPages;
    const manifestV02 = {
      ...manifest,
      protocol: 'https://know-n.com/colp/spec/0.2',
      syncEffectPages: 'https://alice.example/collections/-/sync/effects/{effectId}/pages/{pageNumber}',
    };
    expect(registry.validate('manifestV02', manifestV02).valid).toBe(true);
    expect(registry.validate('manifest', manifestV02).valid).toBe(false);
  });

  it('binds acceptedProtocolVersion to the selected Session schema', () => {
    const result = { ...structuredClone(sessionResultFixture), acceptedProtocolVersion: '0.2' };
    expect(registry.validate('syncSessionResult', result).valid).toBe(false);
    expect(registry.validate('syncSessionResultV02', result).valid).toBe(true);
  });

  it.each([
    ['create_node', 'node_created', { node, placement: { parentId: 'folder-2', afterId: null, beforeId: 'sibling-2', position: 'server-order-1' }, parentRevision: { parentId: 'folder-2', childrenRevision: 'children-12' }, nodeChildrenRevision: null }],
    ['update_node_content', 'node_content_updated', { node }],
    ['move_node', 'node_moved', { node, placement: { parentId: 'folder-2', afterId: null, beforeId: 'sibling-2', position: 'server-order-1' }, parentRevisions: [{ parentId: 'folder-1', childrenRevision: 'children-8' }, { parentId: 'folder-2', childrenRevision: 'children-12' }] }],
    ['delete_node', 'node_deleted', { deletion: { resourceType: 'node', targetId: 'node-server-1', collectionId: 'collection-1', scope: 'single', deletedAt: timestamp, deleteRevision: 'delete-9', operationId: 'op-delete_node', affectedCount: 1, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'receiver-bound-cursor' }, tombstone: { resourceType: 'node', targetId: 'node-server-1', collectionId: 'collection-1', scope: 'single', deletedAt: timestamp, deleteRevision: 'delete-9', operationId: 'op-delete_node', affectedCount: 1, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'receiver-bound-cursor' }, parentRevision: { parentId: 'folder-2', childrenRevision: 'children-13' } }],
    ['delete_subtree', 'subtree_deleted', { rootTombstone: { resourceType: 'node', targetId: 'node-server-1', collectionId: 'collection-1', scope: 'subtree', deletedAt: timestamp, deleteRevision: 'delete-10', operationId: 'op-delete_subtree', affectedCount: 2, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'receiver-bound-cursor' }, members: ['child-1', 'node-server-1'], memberCount: 2, memberDigest: digestA, parentRevision: { parentId: 'folder-2', childrenRevision: 'children-13' } }],
    ['restore_node', 'node_restored', { node: { ...node, revision: 'node-revision-10' }, placement: { parentId: 'folder-2', afterId: null, beforeId: 'sibling-2', position: 'server-order-1' }, parentRevision: { parentId: 'folder-2', childrenRevision: 'children-14' }, consumedTombstone: { resourceType: 'node', targetId: 'node-server-1', collectionId: 'collection-1', scope: 'single', deletedAt: timestamp, deleteRevision: 'delete-9', operationId: 'op-delete_node', affectedCount: 1, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'tombstone-cursor-9' } }],
  ] as const)('accepts a closed %s -> %s authoritative effect', (operationType, kind, payload) => {
    const op = operation(operationType);
    const effect = { effectId: `effect-${kind}`, status: 'applied', effectDigest: digestB,
      opId: op.opId, replicaId: op.replicaId, sequence: op.sequence, collectionId: op.collectionId,
      operationDigest: digestA, kind, ...payload };
    expect(registry.validate('syncPullEventV02', event(op, effect)).valid).toBe(true);
  });

  it.each(['noop', 'conflicted', 'rejected', 'deferred'])('rejects %s from the mutation stream', (status) => {
    const effect = { effectId: 'effect-1', status, effectDigest: digestB, ...binding,
      kind: 'node_created', node, placement: { parentId: 'folder-2', afterId: null, beforeId: null, position: 'a' }, parentRevision: { parentId: 'folder-2', childrenRevision: 'children-12' }, nodeChildrenRevision: null };
    expect(registry.validate('syncPullEventV02', event(operation('create_node'), effect)).valid).toBe(false);
  });

  it('accepts a bounded immutable paged subtree reference and rejects endpoint overrides', () => {
    const op = operation('delete_subtree');
    const base = { effectId: 'effect-pages', status: 'applied', effectDigest: digestB,
      opId: op.opId, replicaId: op.replicaId, sequence: op.sequence, collectionId: op.collectionId,
      operationDigest: digestA, kind: 'subtree_deleted',
      rootTombstone: { resourceType: 'node', targetId: 'node-server-1', collectionId: 'collection-1', scope: 'subtree', deletedAt: timestamp, deleteRevision: 'delete-10', operationId: op.opId, affectedCount: 500, purgeAfter: '2026-08-27T00:00:00Z', deleteCursor: 'receiver-bound-cursor' },
      effectRef: { pageCount: 2, memberCount: 500, memberDigest: digestA, firstPageDigest: digestB },
      memberCount: 500, memberDigest: digestA, parentRevision: { parentId: 'folder-2', childrenRevision: 'children-13' } };
    expect(registry.validate('syncPullEventV02', event(op, base)).valid).toBe(true);
    expect(registry.validate('syncPullEventV02', event(op, { ...base,
      effectRef: { ...base.effectRef, url: 'https://sync.example/pages' } })).valid).toBe(false);
  });
});

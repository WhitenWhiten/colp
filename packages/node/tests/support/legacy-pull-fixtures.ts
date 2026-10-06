import type { Operation, Conflict } from '../../src/types/index.js';

export function legacyPullOperation(
  opId: string,
  replicaId: string,
): Extract<Operation, { readonly type: 'delete_node' }> {
  return { opId, replicaId, sequence: 1, collectionId: 'collection-1', type: 'delete_node',
    targetId: 'node-1', baseRevision: 'revision-1', occurredAt: '2026-07-27T00:00:00Z', payload: {} };
}
export function legacyPullConflict(id: string): Conflict {
  return { id, collectionId: 'collection-1', targetId: 'node-1', type: 'field_value',
    createdAt: '2026-07-27T00:00:00Z', status: 'open', allowedResolutions: ['server', 'incoming'], revision: 'conflict-r1' };
}

import { createHash } from 'node:crypto';
import type { Operation } from '@know-n/colp/types';

/** Server-origin operation identity, independent of every browser/device replica.
 * The effect store supports non-device origins, as used by Product trash restore. */
export function serverMoveOperation(input: {
  operationId: string; collectionId: string; nodeId: string; revision: string;
  parentId: string; sourceChildrenRevision: string; targetChildrenRevision: string;
  occurredAt: Date;
}): Extract<Operation, { type: 'move_node' }> {
  return {
    opId: input.operationId,
    replicaId: `server-${createHash('sha256').update(input.operationId).digest('hex').slice(0, 32)}`,
    sequence: 1, type: 'move_node', collectionId: input.collectionId, targetId: input.nodeId,
    baseRevision: input.revision, occurredAt: input.occurredAt.toISOString(), dependencies: [],
    payload: { newParentId: input.parentId, baseSourceParentRevision: input.sourceChildrenRevision,
      baseTargetParentRevision: input.targetChildrenRevision },
  };
}

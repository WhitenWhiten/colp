import type { SyncPush } from '@know-n/colp/types';

export function syncNodeDeletePushRequest(input: {
  readonly sessionId?: string;
  readonly replicaId?: string;
  readonly collectionId?: string;
  readonly sequence?: number;
  readonly opId?: string;
  readonly batchId?: string;
  readonly targetId?: string;
  readonly baseRevision?: string;
  readonly subtree?: boolean;
  readonly reason?: string;
  readonly source?: import('@know-n/colp/types').Operation['source'];
} = {}): SyncPush {
  return {
    sessionId: input.sessionId ?? 'delete-session-1',
    batchId: input.batchId ?? `${input.sessionId ?? 'delete-session-1'}.client-batch`,
    atomic: false,
    operations: [{
      opId: input.opId ?? 'delete-operation-1',
      replicaId: input.replicaId ?? 'delete-replica-1',
      sequence: input.sequence ?? 1,
      collectionId: input.collectionId ?? 'delete-collection-1',
      type: input.subtree ? 'delete_subtree' : 'delete_node',
      targetId: input.targetId ?? 'delete-node-1',
      baseRevision: input.baseRevision ?? 'delete-node-r1',
      occurredAt: '2026-07-26T04:00:00Z',
      dependencies: [],
      payload: input.reason === undefined ? {} : { reason: input.reason },
      ...(input.source ? { source: input.source } : {}),
    }],
  } as SyncPush;
}

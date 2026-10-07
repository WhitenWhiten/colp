import type { SyncPush } from '@know-n/colp/types';

export function syncNodeRestorePushRequest(input: {
  readonly sessionId?: string;
  readonly replicaId?: string;
  readonly collectionId?: string;
  readonly sequence?: number;
  readonly opId?: string;
  readonly batchId?: string;
  readonly targetId?: string;
  readonly baseRevision?: string;
  readonly reason?: string;
} = {}): SyncPush {
  return {
    sessionId: input.sessionId ?? 'restore-session-1',
    batchId: input.batchId ?? `${input.sessionId ?? 'restore-session-1'}.client-batch`,
    atomic: false,
    operations: [{
      opId: input.opId ?? 'restore-operation-1',
      replicaId: input.replicaId ?? 'restore-replica-1',
      sequence: input.sequence ?? 1,
      collectionId: input.collectionId ?? 'restore-collection-1',
      type: 'restore_node',
      targetId: input.targetId ?? 'restore-node-1',
      baseRevision: input.baseRevision ?? 'delete-rev-1',
      occurredAt: '2026-07-27T02:00:00Z',
      dependencies: [],
      payload: input.reason === undefined ? {} : { reason: input.reason },
    }],
  } as SyncPush;
}

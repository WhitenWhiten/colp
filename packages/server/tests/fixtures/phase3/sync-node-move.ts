import type { SyncPush } from '@know-n/colp/types';

export function syncNodeMovePushRequest(input: {
  readonly sessionId?: string;
  readonly replicaId?: string;
  readonly collectionId?: string;
  readonly sequence?: number;
  readonly opId?: string;
  readonly batchId?: string;
  readonly targetId?: string;
  readonly baseRevision?: string;
  readonly newParentId?: string;
  readonly afterId?: string | null;
  readonly beforeId?: string | null;
  readonly baseSourceParentRevision?: string;
  readonly baseTargetParentRevision?: string;
} = {}): SyncPush {
  return {
    sessionId: input.sessionId ?? 'move-session-1',
    batchId: input.batchId ?? `${input.sessionId ?? 'move-session-1'}.client-batch`,
    atomic: false,
    operations: [{
      opId: input.opId ?? 'move-operation-1',
      replicaId: input.replicaId ?? 'move-replica-1',
      sequence: input.sequence ?? 1,
      collectionId: input.collectionId ?? 'move-collection-1',
      type: 'move_node',
      targetId: input.targetId ?? 'move-node-1',
      baseRevision: input.baseRevision ?? 'move-node-r1',
      occurredAt: '2026-07-26T03:00:00Z',
      dependencies: [],
      payload: {
        newParentId: input.newParentId ?? 'move-target-parent-1',
        ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
        ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
        baseSourceParentRevision: input.baseSourceParentRevision ?? 'source-children-r1',
        baseTargetParentRevision: input.baseTargetParentRevision ?? 'target-children-r1',
      },
    }],
  } as SyncPush;
}

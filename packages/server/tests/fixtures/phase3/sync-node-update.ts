import type { NodeMergePatch, SyncPush } from '@know-n/colp/types';

export function syncNodeUpdatePushRequest(input: {
  readonly sessionId?: string;
  readonly replicaId?: string;
  readonly collectionId?: string;
  readonly sequence?: number;
  readonly opId?: string;
  readonly batchId?: string;
  readonly targetId?: string;
  readonly baseRevision?: string;
  readonly base?: NodeMergePatch;
  readonly value?: NodeMergePatch;
} = {}): SyncPush {
  return {
    sessionId: input.sessionId ?? 'update-session-1',
    batchId: input.batchId ?? `${input.sessionId ?? 'update-session-1'}.client-batch`,
    atomic: false,
    operations: [{
      opId: input.opId ?? 'update-operation-1',
      replicaId: input.replicaId ?? 'update-replica-1',
      sequence: input.sequence ?? 1,
      collectionId: input.collectionId ?? 'update-collection-1',
      type: 'update_node_content',
      targetId: input.targetId ?? 'update-node-1',
      baseRevision: input.baseRevision ?? 'update-node-r1',
      occurredAt: '2026-07-26T02:00:00Z',
      dependencies: [],
      payload: {
        base: input.base ?? { title: 'Before' },
        value: input.value ?? { title: 'After' },
      },
    }],
  } as SyncPush;
}

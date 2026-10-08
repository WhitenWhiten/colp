import type { NodeCreate, SyncPush } from '@know-n/colp/types';

export function syncPushAdmissionRequest(input: {
  readonly sessionId?: string;
  readonly replicaId?: string;
  readonly collectionId?: string;
  readonly sequence?: number;
  readonly opId?: string;
  readonly batchId?: string;
  readonly type?: 'update_node_content' | 'update_collection_metadata' | 'delete_node';
} = {}): SyncPush {
  const type = input.type ?? 'update_node_content';
  return {
    sessionId: input.sessionId ?? 'push-session-1',
    // Session-bound contract (F021): the client batchId is never authority, but
    // it must still satisfy `sessionId` or `sessionId.<opaque>` on the wire.
    batchId: input.batchId ?? `${input.sessionId ?? 'push-session-1'}.client-batch`,
    atomic: false,
    operations: [{
      opId: input.opId ?? 'push-operation-1',
      replicaId: input.replicaId ?? 'push-replica-1',
      sequence: input.sequence ?? 1,
      collectionId: input.collectionId ?? 'push-collection-1',
      type,
      targetId: 'push-node-1',
      baseRevision: 'push-node-r1',
      occurredAt: '2026-07-26T00:00:00Z',
      dependencies: [],
      payload: type === 'delete_node'
        ? { reason: 'unsupported admission proof' }
        : { base: { title: 'Before' }, value: { title: 'After' } },
    }],
  } as SyncPush;
}

export function syncNodeCreatePushRequest(input: {
  readonly sessionId?: string;
  readonly replicaId?: string;
  readonly collectionId?: string;
  readonly sequence?: number;
  readonly opId?: string;
  readonly batchId?: string;
  readonly parentId?: string;
  readonly afterId?: string | null;
  readonly beforeId?: string | null;
  readonly node?: NodeCreate;
} = {}): SyncPush {
  return {
    sessionId: input.sessionId ?? 'push-session-1',
    batchId: input.batchId ?? `${input.sessionId ?? 'push-session-1'}.client-batch`,
    atomic: false,
    operations: [{
      opId: input.opId ?? 'push-create-operation-1',
      replicaId: input.replicaId ?? 'push-replica-1',
      sequence: input.sequence ?? 1,
      collectionId: input.collectionId ?? 'push-collection-1',
      type: 'create_node',
      baseRevision: null,
      occurredAt: '2026-07-26T00:00:00Z',
      dependencies: [],
      payload: {
        parentId: input.parentId ?? 'push-root-1',
        ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
        ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
        node: input.node ?? {
          kind: 'bookmark',
          title: 'Canonical create',
          url: 'https://example.test/canonical-create',
          description: 'created by the P3-12 fixture',
          tags: ['phase3'],
          visibility: 'inherit',
          extensions: { 'https://extensions.example/nested': { preserved: [1, { ok: true }] } },
        },
      },
    }],
  } as SyncPush;
}

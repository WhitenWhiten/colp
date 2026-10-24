import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createBootstrapCoordinator, type ConfirmInput } from '../src/bootstrap/coordinator.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';

export async function setupBootstrapRace() {
  const context = await fixture(new IDBFactory());
  const mount = (await context.store.getMappingByNativeId(scope, 'root-selected'))!;
  const input: ConfirmInput = {
    confirmationId: 'live-create', treeDigest: 'sha256:tree', confirmationVersion: '1',
    localFacts: [], mounts: [{ nativeRootId: mount.nativeId, customSourceKey: 'selected', remoteMountNodeId: mount.colpId }],
    rootNodeId: 'collection-root', remoteFacts: [
      { nodeId: 'collection-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r1' },
      { nodeId: mount.colpId, parentId: 'collection-root', kind: 'folder', title: 'Selected root', revision: 'r1' },
    ], pauseAfter: 'matching',
  };
  const coordinator = createBootstrapCoordinator({ store: context.store, scope });
  await coordinator.confirm(input);
  const node = bookmark('new-native', 'root-selected', 0, 'Added during sync', 'https://example.test/during-sync');
  context.api.put(node);
  const resumed: ConfirmInput = { ...input, pauseAfter: undefined, localFacts: [{
    nativeId: node.id, parentNativeId: node.parentId, mountNativeRootId: 'root-selected',
    kind: 'bookmark', title: node.title, url: node.url,
  }] };
  return { ...context, coordinator, resumed, node };
}

export type BootstrapRace = Awaited<ReturnType<typeof setupBootstrapRace>>;

export async function settleNext(context: BootstrapRace, revision: string, status: 'applied' | 'rebased' = 'applied',
  createdTargetId = 'remote-new') {
  const { store, node } = context;
  const lease = await store.acquireLease(scope, 'race-worker', 1, 30_000);
  const row = await store.claimNextQueue(scope, 'race-worker', lease.fence, 1);
  if (!row) throw new Error('expected_queued_operation');
  const targetId = row.payload.type === 'create_node' ? createdTargetId : String(row.payload.targetId);
  await store.settleClaimedPush(scope, row.sequence, 'race-worker', lease.fence, {
    outcome: 'terminal', receipt: { opId: row.opId, operationDigest: row.digest, kind: 'terminal',
      receiptId: `receipt-${row.opId}`, resultDigest: 'sha256:receipt',
      result: { results: [{ opId: row.opId, sequence: row.sequence, status, targetId, revision }] } },
    ...(row.payload.type === 'create_node'
      ? { authoritativeCreate: { nativeId: node.id, targetId, revision } }
      : row.payload.type === 'update_node_content' || row.payload.type === 'move_node'
        ? { authoritativeProjection: { targetId, revision } } : {}),
  });
  return row;
}

export async function allocateWithMutation(context: BootstrapRace, mutate: () => Promise<void>) {
  let captured = false;
  const coordinator = createBootstrapCoordinator({ scope, store: { ...context.store,
    allocateSequenceAndEnqueue: async (...args) => {
      if (!captured) { captured = true; await mutate(); }
      return context.store.allocateSequenceAndEnqueue(...args);
    },
  } });
  return coordinator.resume(context.resumed);
}

export const updateValue = (payload: JsonObject) => (payload.payload as JsonObject).value;

import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { validateOperation } from '../src/bookmark-event-codec.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { repairOwnCreateFromNative } from '../src/bookmark-own-create-repair.js';
import { createSyncStateStore, type MappingInput, type SyncScope, type JsonObject } from '../src/sync-state-store.js';
import { honestChrome } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

const scope: SyncScope = { environment: 'production', serverId: 'server-pull', serverOrigin: 'https://known.example',
  accountId: 'account-pull', browserProfileId: 'profile-pull', collectionId: 'collection-pull',
  replicaId: 'replica-receiver', generation: 1 };

async function setup(firstRun: 'running' | 'completed', queued = true) {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', firstRun,
    lease: { leaseId: 'lease', expiresAt: Date.parse('2099-01-01T00:00:00Z') },
    checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' }, selectedRoots: ['root-colp'], rootStatus: 'ready' });
  const parent: MappingInput = { nativeId: 'native-root', colpId: 'root-colp', rootNativeId: 'native-root', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:root', content: { title: 'Root' } } };
  await store.putMapping(scope, parent);
  await store.putMountBinding(scope, { mountId: 'mount', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: true, status: 'active', customSourceKey: 'root' });
  const api = honestChrome(); api.seed({ id: 'native-root', index: 0, title: 'Root' });
  const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1, collectionId: scope.collectionId,
    parentId: 'root-colp', replicaId: scope.replicaId, opId: 'normal-create' });
  assert.ok(event.kind === 'operation' && event.operation.type === 'create_node' && event.effect.kind === 'node_created');
  const remote = event.effect.node; assert.ok(remote.kind === 'bookmark' && typeof remote.url === 'string');
  const node = { id: 'native-original', parentId: 'native-root', index: 0,
    title: remote.title, url: remote.url };
  api.seed(node);
  const original: MappingInput = { nativeId: node.id, colpId: 'pending-normal-create', rootNativeId: 'native-root',
    parentNativeId: 'native-root', nodeKind: 'bookmark', projection: { revision: 'local-normal-create',
      digest: 'sha256:original', content: { title: node.title, url: node.url } } };
  if (queued) {
    await store.stageBookmarkEvent(scope, { eventId: 'create-callback', nativeId: node.id, kind: 'create',
      occurredAt: event.operation.occurredAt, dedupeKey: 'create-callback', details: {} });
    await store.commitBookmarkEvent(scope, 'create-callback', { operation: event.operation as unknown as JsonObject,
      baseRevision: null, operationRevision: 'local-normal-create', mapping: original,
      allocateOperationId: () => 'normal-create', validateOperation,
      digestOperation: () => event.effect.operationDigest });
  }
  await store.putMapping(scope, original);
  const queue = createBookmarkEventQueue({ scope, store, autoFlush: false, api: {
    get: async id => (await api.get(id)).map(node => ({ ...node, title: node.title ?? '' })),
    getChildren: async id => (await api.getChildren(id)).map(node => ({ ...node, title: node.title ?? '' })),
  } });
  let repairs = 0;
  const options = { scope, store, api, session: { acceptedProtocolVersion: '0.2' as const, sessionId: 'session-pull',
    collectionId: scope.collectionId, conversionPolicy: { separator: 'preserve_remote' as const } },
    effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}', effectPageAuthority: 'https://known.example',
    repairOwnCreate: async (mapping: MappingInput, parent: MappingInput) => {
      repairs++; await repairOwnCreateFromNative(queue, id => api.get(id), mapping, parent);
    } };
  const page = pullFixtures.page({ events: [event], nextCursor: 'cursor-next', collectionRevision: 'revision-next' });
  return { store, api, queue, options, page, remote, node, original, parent, repairs: () => repairs };
}

for (const firstRun of ['running', 'completed'] as const) test.each(['change', 'move', 'remove'] as const)(
  `own-create replay recovers a lost %s callback with firstRun=${firstRun}`, async kind => {
    const f = await setup(firstRun);
    try {
      await createPullApplier(f.options).stage(f.page);
      if (kind === 'change') await f.api.update(f.node.id, { title: 'Edited while stopped' });
      else if (kind === 'move') {
        await f.store.putMapping(scope, { ...f.parent, nativeId: 'native-target', colpId: 'target-colp',
          parentNativeId: 'native-root' });
        f.api.seed({ id: 'native-target', parentId: 'native-root', title: 'Destination', index: 1 });
        await f.api.move(f.node.id, { parentId: 'native-target', index: 0 });
      } else await f.api.remove(f.node.id);
      // Resume with a new applier and no callback journal, as after worker eviction.
      await createPullApplier(f.options).resume();
      assert.ok(f.repairs() > 0);
      assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
      assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
      await f.queue.flush();
      assert.equal((await f.store.listQueue(scope)).length, 1, 'repair waits for the exact create receipt');
      const lease = await f.store.acquireLease(scope, 'receipt-worker', 1, 30_000);
      const create = (await f.store.claimNextQueue(scope, 'receipt-worker', lease.fence, 1))!;
      await f.store.settleClaimedPush(scope, create.sequence, 'receipt-worker', lease.fence, {
        outcome: 'terminal', receipt: { opId: create.opId, operationDigest: create.digest, kind: 'terminal',
          receiptId: 'create-receipt', resultDigest: 'sha256:receipt', result: { results: [{ opId: create.opId,
            sequence: create.sequence, status: 'applied', targetId: f.remote.id,
            revision: f.remote.revision }] } },
        authoritativeCreate: { nativeId: f.node.id, targetId: f.remote.id, revision: f.remote.revision },
      });
      await f.queue.flush();
      const successor = (await f.store.listQueue(scope))[1]!;
      assert.equal(successor.payload.type, kind === 'change' ? 'update_node_content' : kind === 'move' ? 'move_node' : 'delete_node');
      assert.equal(successor.payload.targetId, f.remote.id);
      assert.equal(successor.baseRevision, f.remote.revision);
      assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
    } finally { f.store.close(); }
  });

test('replay proves the combined state of multiple unmapped edits without manufacturing another callback', async () => {
  const f = await setup('running');
  try {
    await f.store.putBootstrapRun(scope, { runId: 'bootstrap', confirmationId: 'bootstrap', phase: 'matching',
      bootstrapMode: 'merge', updatedAt: 1 });
    await f.store.deleteMapping(scope, f.node.id);
    await f.api.update(f.node.id, { title: 'Edited title' });
    await f.queue.changed(f.node.id, { title: 'Edited title' }, 'callback');
    await f.api.update(f.node.id, { url: 'https://example.test/edited' });
    await f.queue.changed(f.node.id, { url: 'https://example.test/edited' }, 'callback');
    await f.store.putMapping(scope, f.original);
    const applier = createPullApplier(f.options);
    await applier.stage(f.page); await applier.resume();
    assert.equal(f.repairs(), 0);
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 2);
  } finally { f.store.close(); }
});

test('a provisional mapping alone cannot authorize recovery of an unproven create', async () => {
  const f = await setup('completed', false);
  try {
    await f.api.update(f.node.id, { title: 'Unproven edit' });
    const applier = createPullApplier(f.options);
    await assert.rejects(async () => { await applier.stage(f.page); await applier.resume(); }, /recovery_required/);
    assert.equal(f.repairs(), 0);
    assert.equal((await f.store.getEngineState(scope))?.lastError, 'create_ambiguous');
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});

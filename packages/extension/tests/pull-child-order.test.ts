import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, test } from 'vitest';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import { parentRevisionMappingFor, pullChildOrder } from '../src/pull-child-order.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();
const stores: Array<Awaited<ReturnType<typeof setup>>['store']> = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function fixture() {
  const f = await setup(); stores.push(f.store);
  const original = await f.store.getMappingByNativeId(scope, 'native-root');
  assert.ok(original);
  const { scopeKey: _key, ...input } = original;
  await f.store.putMapping(scope, { ...input,
    projection: { ...original.projection, childrenOrder: ['native-node', 'native-child'] } });
  const parent = await f.store.getMappingByNativeId(scope, 'native-root');
  assert.ok(parent);
  return { ...f, parent };
}
function operation(event: SyncPullEventV02) {
  assert.equal(event.kind, 'operation');
  if (event.kind !== 'operation') throw new Error('operation required');
  return event;
}

test('parent revision and effect-derived order travel together without leaking the storage scope key', async () => {
  const f = await fixture();
  const event = operation(pullFixtures.createEvent({ kind: 'Bookmark', sequence: 8,
    collectionId: scope.collectionId, parentId: 'root-colp', afterId: 'node-1', beforeId: 'node-child' }));
  const mapped = await parentRevisionMappingFor(f.options)(
    { parentId: 'root-colp', childrenRevision: 'children-next' }, event, 'new-native');
  assert.equal(Object.hasOwn(mapped, 'scopeKey'), false);
  assert.deepEqual(mapped.projection.childrenOrder, ['native-node', 'new-native', 'native-child']);
  assert.equal(mapped.projection.childrenRevision, 'children-next');
  assert.equal((await f.store.getMappingByNativeId(scope, 'native-root'))?.projection.childrenRevision, 'children-old');
  await f.store.putMapping(scope, mapped);
  const stored = await f.store.getMappingByNativeId(scope, 'native-root');
  assert.deepEqual(stored?.projection, mapped.projection);
  const revisionOnly = await parentRevisionMappingFor(f.options)({ parentId: 'root-colp', childrenRevision: 'children-later' });
  assert.deepEqual(revisionOnly.projection.childrenOrder, mapped.projection.childrenOrder);
  assert.equal(revisionOnly.projection.childrenRevision, 'children-later');
});

test.each(['delete', 'subtree', 'move-out'] as const)('%s removes only its target from the recorded sibling order', async kind => {
  const f = await fixture();
  const event = operation(kind === 'subtree'
    ? pullFixtures.subtreeEvent({ sequence: 8, collectionId: scope.collectionId,
      targetId: 'node-1', members: ['node-1'], paged: false })
    : pullFixtures.mutationEvent({ kind: kind === 'delete' ? 'delete' : 'move', sequence: 8,
      collectionId: scope.collectionId, targetId: 'node-1', parentId: kind === 'move-out' ? 'other-parent' : 'root-colp' }));
  assert.deepEqual(await pullChildOrder(f.options, f.parent, event), ['native-child']);
  assert.deepEqual(f.parent.projection.childrenOrder, ['native-node', 'native-child']);
  assert.deepEqual(f.api.calls, [], 'order derives from the remote effect without reading a later native tree');
});

test('content-only updates preserve the recorded sibling order', async () => {
  const f = await fixture();
  const event = operation(f.mutationEvent('update'));
  assert.deepEqual(await pullChildOrder(f.options, f.parent, event), ['native-node', 'native-child']);
});

test.each(['before', 'after', 'front'] as const)('remote creation derives the %s placement from mapped anchors', async anchor => {
  const f = await fixture();
  const event = operation(pullFixtures.createEvent({ kind: 'Bookmark', sequence: 8,
    collectionId: scope.collectionId, parentId: 'root-colp',
    ...(anchor === 'before' ? { beforeId: 'node-child' } : anchor === 'after' ? { afterId: 'node-child' } : {}) }));
  const result = await pullChildOrder(f.options, f.parent, event, 'created-native');
  assert.deepEqual(result, anchor === 'before' ? ['native-node', 'created-native', 'native-child']
    : anchor === 'after' ? ['native-node', 'native-child', 'created-native']
      : ['created-native', 'native-node', 'native-child']);
});

test('an own queued event keeps the latest local order instead of replaying its historical placement', async () => {
  const f = await fixture();
  const event = operation(pullFixtures.createEvent({ kind: 'Bookmark', sequence: 1,
    collectionId: scope.collectionId, parentId: 'root-colp', replicaId: scope.replicaId }));
  await f.store.allocateSequenceAndEnqueue(scope, { opId: event.operation.opId, batchId: 'own-order',
    idempotencyKey: 'own-order', digest: event.effect.operationDigest, endpointIdentity: 'syncPush',
    mediaType: 'application/json', baseRevision: null, operationRevision: 'local-order', status: 'pending',
    retry: { attempt: 0, notBefore: 0 }, payload: JSON.parse(JSON.stringify(event.operation)) as JsonObject },
  { allowUnstamped: true });
  assert.deepEqual(await pullChildOrder(f.options, f.parent, event, 'created-native'), ['native-node', 'native-child']);
});

test.each(['missing', 'sidecar'] as const)('%s native identity cannot be inserted into Chrome sibling order', async kind => {
  const f = await fixture();
  const event = operation(f.createEvent('Bookmark'));
  assert.deepEqual(await pullChildOrder(f.options, f.parent, event,
    kind === 'sidecar' ? 'sidecar:separator' : undefined), ['native-node', 'native-child']);
});

test('detached mounts and absent order baselines remain unchanged', async () => {
  const f = await fixture();
  const event = operation(f.mutationEvent('delete'));
  const noBaseline = { ...f.parent, projection: { revision: 'legacy', digest: 'sha256:legacy' } };
  assert.equal(await pullChildOrder(f.options, noBaseline, event), undefined);
  await f.store.putMountBinding(scope, { mountId: 'detached-mount', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'detached', rootRole: 'bookmarks-bar' });
  assert.deepEqual(await pullChildOrder(f.options, f.parent, event), ['native-node', 'native-child']);
});

test('a missing parent rejects revision advancement instead of inventing a mapping', async () => {
  const f = await fixture();
  await assert.rejects(parentRevisionMappingFor(f.options)({ parentId: 'missing-parent', childrenRevision: 'next' }),
    /parent_revision_mapping_missing/);
  assert.equal(await f.store.getMappingByColpId(scope, 'missing-parent'), null);
});

import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { repairOwnCreateFromNative } from '../src/bookmark-own-create-repair.js';
import { scope, setup as setupReplay } from './own-create-replay-harness.js';

const fixtures: Awaited<ReturnType<typeof setupReplay>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.store.close(); });
async function setup() { const f = await setupReplay('completed'); fixtures.push(f); return f; }

test('an unreadable native tree cannot be interpreted as a lost delete callback', async () => {
  const f = await setup(), before = await f.store.exportScope(scope);
  await assert.rejects(repairOwnCreateFromNative(f.queue, async () => { throw new Error('permission_revoked'); },
    f.original, f.parent), /permission_revoked/);
  assert.deepEqual(await f.store.exportScope(scope), before);
  assert.deepEqual(f.api.calls, []);
});

test('a lost deletion of a legacy sparse projection uses the proven parent and stages one deletion', async () => {
  const f = await setup(); await f.api.remove(f.node.id);
  const sparse = { ...f.original, parentNativeId: undefined, nodeKind: undefined,
    projection: { ...f.original.projection, content: undefined } };
  await repairOwnCreateFromNative(f.queue, id => f.api.get(id), sparse, f.parent);
  const events = await f.store.listBookmarkEventsByStatus(scope, 'pending');
  assert.equal(events.length, 1); assert.equal(events[0]!.kind, 'remove');
  assert.match(JSON.stringify(events[0]!.details), /pending-normal-create/);
  assert.equal((await f.store.listQueue(scope)).length, 1, 'the original operation remains until its real receipt');
});

test('a sparse native read cannot invent a title, URL, parent move or sibling reorder', async () => {
  const f = await setup(), before = await f.store.exportScope(scope);
  await repairOwnCreateFromNative(f.queue, async () => [{ id: f.node.id }], f.original, f.parent);
  assert.deepEqual(await f.store.exportScope(scope), before);
  assert.deepEqual(f.api.calls, []);
});

test('a moved native without an index still stages the actual destination through the real queue', async () => {
  const f = await setup();
  await f.store.putMapping(scope, { ...f.parent, nativeId: 'destination', colpId: 'destination-colp', parentNativeId: 'native-root' });
  f.api.seed({ id: 'destination', parentId: 'native-root', title: 'Destination', index: 1 });
  await f.api.move(f.node.id, { parentId: 'destination', index: 0 });
  await repairOwnCreateFromNative(f.queue, async () => [{ id: f.node.id, parentId: 'destination', url: f.node.url }],
    f.original, f.parent);
  const events = await f.store.listBookmarkEventsByStatus(scope, 'pending');
  assert.equal(events.length, 1); assert.equal(events[0]!.kind, 'move');
  assert.deepEqual(events[0]!.details.context, { sourceParentNativeId: 'native-root', targetParentNativeId: 'destination' });
  assert.equal((await f.store.listQueue(scope)).length, 1);
});

import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { rejectedOrderFixture, rejectQueueRow } from './rejoin-rejected-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { applyRejoinOrder, planRejoinOrders } from '../src/scope-rejoin-order.js';
import { renewChangedRejoinOrder, renewRejectedRejoin } from '../src/scope-rejoin-rejection.js';

installKns05IndexedDb();
type Fixture = Awaited<ReturnType<typeof rejectedOrderFixture>>;
async function planned(f: Fixture) {
  const input = { ...f.input(), mount: (await f.getStore().getMountBinding(scope, 'mount-bar'))! };
  const [plan] = await planRejoinOrders(input, await f.getStore().listMappings(scope), []);
  assert.ok(plan); return { input, plan };
}

test.each(['children', 'move'] as const)('a missing native %s API cannot partially apply a confirmed order', async missing => {
  const f = await rejectedOrderFixture();
  try {
    const { input, plan } = await planned(f); const calls = [...f.api.calls]; const native = f.api.all();
    await assert.rejects(applyRejoinOrder({ ...input, ...(missing === 'children' ? { getChildren: undefined }
      : { moveNative: undefined }) }, plan, plan.remote), /rejoin_order_api_unavailable/);
    assert.deepEqual(f.api.calls, calls); assert.deepEqual(f.api.all(), native);
    assert.deepEqual(await f.getStore().listQueue(scope), []);
  } finally { f.getStore().close(); }
});

test('a newly read cloud order must match the reviewed authority before the first native mutation', async () => {
  const f = await rejectedOrderFixture();
  try {
    const { input, plan } = await planned(f); const calls = [...f.api.calls];
    f.setRemote(['a', 'd', 'b', 'c']);
    await assert.rejects(applyRejoinOrder(input, plan, plan.remote), /preview_stale/);
    assert.deepEqual(f.api.calls, calls); assert.deepEqual(await f.getStore().listQueue(scope), []);
  } finally { f.getStore().close(); }
});

test.each(['mapping', 'native'] as const)('a lost child %s between order reads is preserved as a conflict without moving another child', async lost => {
  const f = await rejectedOrderFixture();
  try {
    const { input, plan } = await planned(f); let reads = 0; let automaticMoves = 0;
    await assert.rejects(applyRejoinOrder({ ...input, getChildren: async id => {
      const children = await f.api.getChildren(id);
      if (++reads === 2) {
        if (lost === 'mapping') await f.getStore().deleteMapping(scope, plan.remote[0]!);
        else await f.api.remove(plan.remote[0]!);
      }
      return children;
    }, moveNative: async (id, value) => { automaticMoves++; await f.api.move(id, value); } }, plan, plan.remote), /rejoin_order_changed/);
    assert.equal(automaticMoves, 0);
    if (lost === 'mapping') assert.equal(await f.getStore().getMappingByNativeId(scope, plan.remote[0]!), null);
    else assert.equal(f.api.getNode(plan.remote[0]!), undefined);
    assert.deepEqual(await f.getStore().listQueue(scope), []);
  } finally { f.getStore().close(); }
});

test('a user reorder immediately after a native move stops the remaining automatic moves', async () => {
  const f = await rejectedOrderFixture();
  try {
    const { input, plan } = await planned(f); let automaticMoves = 0;
    await assert.rejects(applyRejoinOrder({ ...input, moveNative: async (id, value) => {
      automaticMoves++; await f.api.move(id, value); await f.api.move('native-a', { parentId: 'native-root', index: 0 });
    } }, plan, plan.remote), /rejoin_order_changed/);
    assert.equal(automaticMoves, 1);
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), ['native-a', 'native-c', 'native-d', 'native-b']);
    assert.deepEqual(await f.getStore().listQueue(scope), []);
  } finally { f.getStore().close(); }
});

test('mapping loss at the final order read cannot be undone by writing the completed projection', async () => {
  const f = await rejectedOrderFixture();
  try {
    const { input, plan } = await planned(f); let automaticMoves = 0; let finalReads = 0;
    await assert.rejects(applyRejoinOrder({ ...input,
      moveNative: async (id, value) => { await f.api.move(id, value); automaticMoves++; },
      getChildren: async id => {
        const children = await f.api.getChildren(id);
        if (automaticMoves === 2 && ++finalReads === 2) await f.getStore().deleteMapping(scope, 'native-root');
        return children;
      },
    }, plan, plan.remote), /rejoin_order_changed/);
    assert.equal(await f.getStore().getMappingByNativeId(scope, 'native-root'), null);
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), plan.remote);
    assert.deepEqual(await f.getStore().listQueue(scope), []);
  } finally { f.getStore().close(); }
});

test('a rejection whose native parent disappeared does not invent a replacement order or resolve its receipt', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); const decision = await f.resolve('keep_local_order');
    const queued = await f.getStore().listQueue(scope);
    for (const row of queued) await rejectQueueRow(f.getStore(), row);
    const rows = await f.getStore().listQueue(scope); const before = await f.getStore().exportScope(scope);
    const record = (await f.getStore().getScopeCommandPlan(scope, decision.commandId))!;
    await f.api.removeTree('native-root');
    const input = { ...f.input(), mount: (await f.getStore().getMountBinding(scope, 'mount-bar'))! };
    assert.equal(await renewChangedRejoinOrder(input, record), false);
    assert.equal(await renewRejectedRejoin(input, record, rows), false);
    assert.deepEqual(await f.getStore().listQueue(scope), rows);
    const after = await f.getStore().exportScope(scope);
    assert.deepEqual(after.receipts, before.receipts); assert.deepEqual(after.scopeCommandPlans, before.scopeCommandPlans);
    assert.deepEqual(after.mappings, before.mappings); assert.deepEqual(f.api.all(), []);
  } finally { f.getStore().close(); }
});

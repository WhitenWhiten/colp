import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { rejectedOrderFixture } from './rejoin-rejected-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test.each(['after_rejoin_intent', 'after_rejoin_order_native'])(
  'a frozen cloud order resumes exactly once after %s and preserves its durable callback receipts', async boundary => {
    const f = await rejectedOrderFixture();
    try {
      await f.compare(); const before = f.api.calls.filter(row => row.kind === 'move').length;
      let fired = false;
      await assert.rejects(f.resolve('keep_remote_order', { crash: at => {
        if (!fired && at === boundary) { fired = true; throw new Error('worker_crash'); }
      } }), /worker_crash/);
      f.reopen(); await f.refresh(); await f.refresh();
      assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), ['native-c', 'native-d', 'native-a', 'native-b']);
      assert.equal(f.api.calls.filter(row => row.kind === 'move').length - before, 2);
      assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
      assert.ok((await f.getStore().listApplyIntents(scope)).filter(row => row.liveWorkKind === 'rejoin')
        .every(row => row.state === 'page_complete'));
      await f.queue().recover(); assert.equal((await f.getStore().listQueue(scope)).length, 0);
    } finally { f.getStore().close(); }
  });

test.each(['after_rejoin_confirmation', 'after_rejoin_intent', 'after_rejoin_order_native'])(
  'a user reorder after %s remains untouched until a new visible decision is confirmed', async boundary => {
    const f = await rejectedOrderFixture();
    try {
      await f.compare(); const [old] = await f.list(); assert.ok(old);
      let fired = false;
      await assert.rejects(f.resolve('keep_remote_order', { crash: at => {
        if (!fired && at === boundary) { fired = true; throw new Error('worker_crash'); }
      } }), /worker_crash/);
      const userOrder = ['native-b', 'native-a', 'native-d', 'native-c'];
      for (const [index, id] of userOrder.entries()) await f.api.move(id, { parentId: 'native-root', index });
      const calls = f.api.calls.length;
      f.reopen(); await f.refresh(); await f.refresh();
      assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), userOrder);
      assert.equal(f.api.calls.length, calls);
      const [fresh] = await f.list(); assert.ok(fresh); assert.notEqual(fresh.commandId, old.commandId);
      assert.equal(fresh.state, 'pending'); assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'detached');
      assert.equal((await f.getStore().getScopeCommandPlan(scope, old.commandId))?.phase, 'failed');
      await f.resolve('keep_remote_order');
      assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), ['native-c', 'native-d', 'native-a', 'native-b']);
      assert.equal((await f.list()).length, 0); assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
    } finally { f.getStore().close(); }
  });

test('a cloud order changed after confirmation creates a fresh choice before any browser move', async () => {
  const f = await rejectedOrderFixture();
  try {
    await f.compare(); const [old] = await f.list();
    await assert.rejects(f.resolve('keep_remote_order', { crash: at => {
      if (at === 'after_rejoin_confirmation') throw new Error('worker_crash');
    } }), /worker_crash/);
    f.setRemote(['a', 'd', 'b', 'c']); const calls = f.api.calls.length;
    f.reopen(); await f.refresh();
    assert.equal(f.api.calls.length, calls);
    const [fresh] = await f.list(); assert.ok(fresh); assert.notEqual(fresh.commandId, old?.commandId);
    assert.equal(fresh.state, 'pending');
    await f.resolve('keep_remote_order');
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), ['native-a', 'native-d', 'native-b', 'native-c']);
  } finally { f.getStore().close(); }
});

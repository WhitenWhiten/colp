import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { rejectedOrderFixture } from './rejoin-rejected-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test('independent review: a user reorder after durable move intent must survive without another automatic move', async () => {
  const f = await rejectedOrderFixture();
  const userOrder = ['native-b', 'native-a', 'native-d', 'native-c'];
  let injected = false;
  let injectOnNextRead = false;
  let automaticMoves = 0;
  try {
    await f.compare();
    await f.resolve('keep_remote_order', {
      crash: at => { if (!injected && at === 'after_rejoin_intent') injectOnNextRead = true; },
      getNative: async id => {
        if (injectOnNextRead && !injected) {
          injected = true;
          for (const [index, child] of userOrder.entries()) await f.api.move(child, { parentId: 'native-root', index });
        }
        return f.native.getNative(id);
      },
      moveNative: async (id, value) => { automaticMoves++; return f.api.move(id, value); },
    });
    assert.equal(injected, true);
    assert.equal(automaticMoves, 0, 'the old confirmed order lost its CAS authority before Chrome');
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), userOrder);
    assert.equal((await f.list())[0]?.state, 'pending');
  } finally { f.getStore().close(); }
});

test.each(['mount', 'native_parent'])('the final order CAS rejects changed %s authority after intent persistence', async changed => {
  const f = await rejectedOrderFixture();
  let injected = false;
  let injectOnNextRead = false;
  let automaticMoves = 0;
  try {
    const { scopeKey: _key, rootRole: _rootRole, ...mount } = (await f.getStore().getMountBinding(scope, 'mount-bar'))!;
    // A user-selected custom root can move within the local tree.
    await f.getStore().putMountBinding(scope, { ...mount, customSourceKey: 'custom-root' });
    f.api.seed({ id: 'native-destination', title: 'Destination' });
    await f.compare();
    const original = (await f.api.getChildren('native-root')).map(row => row.id);
    await f.resolve('keep_remote_order', {
      crash: at => { if (!injected && at === 'after_rejoin_intent') injectOnNextRead = true; },
      getNative: async id => {
        if (injectOnNextRead && !injected) {
          injected = true;
          if (changed === 'mount') {
            const { scopeKey: _scopeKey, ...current } = (await f.getStore().getMountBinding(scope, 'mount-bar'))!;
            await f.getStore().putMountBinding(scope, { ...current, boundaryVersion: 'changed' });
          } else await f.api.move('native-root', { parentId: 'native-destination', index: 0 });
        }
        return f.native.getNative(id);
      },
      moveNative: async (id, value) => { automaticMoves++; return f.api.move(id, value); },
    });
    assert.equal(injected, true);
    assert.equal(automaticMoves, 0);
    assert.deepEqual((await f.api.getChildren('native-root')).map(row => row.id), original);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.getStore().close(); }
});


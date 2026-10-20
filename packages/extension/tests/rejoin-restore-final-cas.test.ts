import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { refreshRejoinDecisions } from '../src/scope-rejoin-decisions.js';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test('independent review: mapping loss during a prepared restore must stop native creation', async () => {
  const f = await deletionFixture();
  let deleted = false;
  try {
    await f.compare();
    await f.resolve('keep_remote', { createNative: undefined });
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    await refreshRejoinDecisions({ ...f.input(), getChildren: async id => {
      if (!deleted && id === 'native-root') {
        deleted = true;
        await f.getStore().deleteMapping(scope, 'unmounted:restore-folder');
      }
      return f.api.getChildren(id);
    } });
    assert.equal(deleted, true);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0,
      'a disappeared expected mapping must invalidate the plan before a browser write');
    assert.equal(await f.getStore().getMappingByColpId(scope, 'restore-folder'), null);
  } finally { f.getStore().close(); }
});

test.each(['missing', 'newer'])('a %s mapping after native success is never overwritten by the returned identity', async change => {
  const f = await deletionFixture();
  let changed = false;
  try {
    await f.compare();
    const decision = await f.resolve('keep_remote', { createNative: async value => {
      const created = await f.api.create(value);
      if (!changed) {
        changed = true;
        if (change === 'missing') await f.getStore().deleteMapping(scope, 'unmounted:restore-folder');
        else {
          const { scopeKey: _key, ...mapping } = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
          await f.getStore().putMapping(scope, { ...mapping, projection: { ...mapping.projection,
            revision: 'later-edit', resourceRevision: 'later-edit', content: { title: 'Later local edit' } } });
        }
      }
      return created;
    } });
    assert.equal(changed, true);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 1);
    const mapping = await f.getStore().getMappingByColpId(scope, 'restore-folder');
    if (change === 'missing') assert.equal(mapping, null);
    else {
      assert.equal(mapping?.nativeId, 'unmounted:restore-folder');
      assert.equal(mapping.projection.revision, 'later-edit');
      assert.equal(mapping.projection.content?.title, 'Later local edit');
    }
    assert.equal((await f.getStore().getScopeCommandPlan(scope, decision.commandId))?.phase, 'failed');
    f.reopen(); await f.refresh();
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 1);
    assert.equal((await f.getStore().listQueue(scope)).length, 0);
  } finally { f.getStore().close(); }
});

test.each(['mount', 'native_parent'])('restore preflight stops a changed %s even while the selected root remains present', async change => {
  const f = await deletionFixture();
  let changed = false;
  try {
    const { scopeKey: _key, rootRole: _role, ...mount } = (await f.getStore().getMountBinding(scope, 'mount-bar'))!;
    await f.getStore().putMountBinding(scope, { ...mount, customSourceKey: 'custom-root' });
    f.api.seed({ id: 'native-destination', title: 'Destination' });
    await f.compare();
    await f.resolve('keep_remote', { createNative: undefined });
    await refreshRejoinDecisions({ ...f.input(), getChildren: async id => {
      if (!changed && id === 'native-root') {
        changed = true;
        if (change === 'mount') {
          const { scopeKey: _scopeKey, ...current } = (await f.getStore().getMountBinding(scope, 'mount-bar'))!;
          await f.getStore().putMountBinding(scope, { ...current, boundaryVersion: 'changed' });
        } else await f.api.move('native-root', { parentId: 'native-destination', index: 0 });
      }
      return f.api.getChildren(id);
    } });
    assert.equal(changed, true);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'detached');
  } finally { f.getStore().close(); }
});

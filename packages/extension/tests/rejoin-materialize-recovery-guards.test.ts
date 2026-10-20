import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { materializeUnmountedRejoinMembers } from '../src/scope-rejoin-materialize.js';
import { observationPauseBinding } from '../src/sync-state/remote-observation.js';
import { rejoinFixture } from './rejoin-recovery-harness.js';
import { detachScopeMount } from '../src/scope-commands.js';

installKns05IndexedDb();

test('a restored remote separator binds only a sidecar and never creates a browser bookmark', async () => {
  const f = await deletionFixture(0);
  try {
    f.setFacts([...f.snapshot().remoteFacts, { nodeId: 'remote-separator', parentId: 'restore-folder', kind: 'separator',
      title: '', revision: 'separator-r1', position: 'a' }]);
    await f.compare(); await f.resolve('keep_remote');
    const separator = (await f.getStore().getMappingByColpId(scope, 'remote-separator'))!;
    assert.equal(separator.nativeId, 'sidecar:remote-separator');
    const folder = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    assert.equal(separator.parentNativeId, folder.nativeId);
    assert.deepEqual(await f.api.getChildren(folder.nativeId), []);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 1);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))!.status, 'active');
  } finally { f.getStore().close(); }
});

test('a current-pause tombstone retires an unmaterialized member without any native create or delete', async () => {
  const f = await rejoinFixture();
  try {
    await detachScopeMount(f.store, scope, 'mount-bar');
    const mount = (await f.store.getMountBinding(scope, 'mount-bar'))!;
    await f.store.putMapping(scope, { nativeId: 'unmounted:remote-new', colpId: 'remote-new', nodeKind: 'bookmark',
      parentColpId: 'root-colp', parentNativeId: 'native-root', rootNativeId: 'native-root', mountId: mount.mountId,
      projection: { revision: 'remote-r1', digest: 'remote-digest', content: { title: 'Remote', url: 'https://example.test/new' } } });
    await f.store.putRemoteObservation(scope, { colpId: 'remote-new', remoteRevision: 'deleted-r2', cursor: 'deleted-cursor',
      kind: 'tombstone', payload: { deleted: true }, sourceDigest: 'deleted-evidence', observedAt: 2,
      ...observationPauseBinding(mount.pauseBaseline) });
    const native = f.api.all(); const calls = [...f.api.calls];
    const result = await materializeUnmountedRejoinMembers({ ...f.native, store: f.store, scope, mount }, await f.store.listMappings(scope));
    assert.deepEqual(result, { applied: 1, unknown: 0 });
    assert.equal(await f.store.getMappingByColpId(scope, 'remote-new'), null);
    assert.deepEqual(f.api.all(), native); assert.deepEqual(f.api.calls, calls);
  } finally { f.store.close(); }
});

test('a native create with no return evidence stays unknown across restart and never adopts a same-title folder', async () => {
  const f = await deletionFixture(0);
  try {
    await f.compare();
    await assert.rejects(f.resolve('keep_remote', { crash: at => {
      if (at === 'after_create_before_evidence') throw new Error('worker_crash');
    } }), /worker_crash/);
    f.api.seed({ id: 'user-twin', parentId: 'native-root', title: 'Cloud folder' });
    const before = f.api.all(); const createCount = f.api.calls.filter(row => row.kind === 'create').length;
    f.reopen(); await f.refresh(); await f.refresh();
    assert.equal(createCount, 1); assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 1);
    assert.equal((await f.getStore().getMappingByColpId(scope, 'restore-folder'))!.nativeId, 'unmounted:restore-folder');
    assert.equal(await f.getStore().getMappingByNativeId(scope, 'user-twin'), null);
    assert.deepEqual(f.api.all(), before);
    const [intent] = (await f.getStore().listApplyIntents(scope)).filter(row => row.liveWorkKind === 'rejoin');
    assert.equal(intent?.nativeResult, 'result_unknown');
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))!.status, 'detached');
  } finally { f.getStore().close(); }
});

test('a user deletion immediately after a successful native return does not cause a second create', async () => {
  const f = await deletionFixture(0);
  try {
    await f.compare();
    await f.resolve('keep_remote', { createNative: async details => {
      const created = await f.api.create(details); await f.api.remove(created.id); return created;
    } });
    const before = f.api.all();
    f.reopen(); await f.refresh(); await f.refresh();
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 1);
    assert.deepEqual(f.api.all(), before);
    assert.equal((await f.getStore().getMappingByColpId(scope, 'restore-folder'))!.nativeId, 'unmounted:restore-folder');
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))!.status, 'detached');
  } finally { f.getStore().close(); }
});

test.each(['member', 'parent'] as const)('a user move of the %s after native creation cannot be rebound to the old placement', async moved => {
  const f = await deletionFixture(0);
  try {
    f.api.seed({ id: 'user-destination', title: 'Local destination' });
    await f.compare();
    const decision = await f.resolve('keep_remote', { createNative: async details => {
      const created = await f.api.create(details);
      await f.api.move(moved === 'member' ? created.id : 'native-root', { parentId: 'user-destination', index: 0 });
      return created;
    } });
    const before = f.api.all();
    assert.equal((await f.getStore().getScopeCommandPlan(scope, decision.commandId))!.phase, 'failed');
    assert.equal((await f.getStore().getMappingByColpId(scope, 'restore-folder'))!.nativeId, 'unmounted:restore-folder');
    f.reopen(); await f.refresh();
    assert.deepEqual(f.api.all(), before);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 1);
  } finally { f.getStore().close(); }
});

test.each(['mapping', 'native'] as const)('loss of the destination %s during materialization preflight cannot restore stale authority', async lost => {
  const f = await deletionFixture(0);
  try {
    await f.compare(); await f.resolve('keep_remote', { createNative: undefined });
    const store = f.getStore(); const mount = (await store.getMountBinding(scope, 'mount-bar'))!;
    const mappings = await store.listMappings(scope); let rootReads = 0;
    await assert.rejects(materializeUnmountedRejoinMembers({ ...f.input(), mount, getNative: async id => {
      if (id === 'native-root') {
        rootReads++;
        if (lost === 'mapping' && rootReads === 1) await store.deleteMapping(scope, id);
        if (lost === 'native' && rootReads === 2) await f.api.remove(id);
      }
      return f.native.getNative(id);
    } }, mappings), lost === 'mapping' ? /rejoin_boundary_changed/ : /rejoin_parent_missing/);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    assert.equal((await store.getMappingByColpId(scope, 'restore-folder'))!.nativeId, 'unmounted:restore-folder');
    if (lost === 'mapping') assert.equal(await store.getMappingByColpId(scope, 'root-colp'), null);
    else assert.equal(f.api.getNode('native-root'), undefined);
  } finally { f.getStore().close(); }
});

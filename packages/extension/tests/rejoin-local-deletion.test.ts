import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { refreshRejoinDecisions } from '../src/scope-rejoin-decisions.js';

installKns05IndexedDb();

test('pause, local folder deletion, new cloud children: Keep cloud restores all children in cloud order once', async () => {
  const f = await deletionFixture();
  try {
    assert.equal((await f.compare()).mount.status, 'detached');
    const [choice] = await f.list();
    assert.equal(choice?.kind, 'local_delete'); assert.equal(choice?.affectedCount, 3);
    await f.resolve('keep_remote');
    const folder = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    assert.equal((await f.api.get(folder.nativeId))[0]?.title, 'Cloud folder');
    const mapped = await f.getStore().listMappings(scope);
    const byNative = new Map(mapped.map(row => [row.nativeId, row.colpId]));
    assert.deepEqual((await f.api.getChildren(folder.nativeId)).map(row => byNative.get(row.id)), f.children.map(row => row.nodeId));
    assert.deepEqual((await f.getStore().getMappingByColpId(scope, 'restore-folder'))?.projection.childrenOrder,
      (await f.api.getChildren(folder.nativeId)).map(row => row.id));
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
    assert.deepEqual(await f.list(), []);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 3);
    f.reopen(); await f.refresh(); await f.compare();
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 3);
    await f.queue().recover(); assert.equal((await f.getStore().listQueue(scope)).length, 0);
  } finally { f.getStore().close(); }
});

test.each(['after_rejoin_confirmation', 'after_rejoin_restore_preparation'])('GET resumes accepted Keep cloud after %s', async boundary => {
  const f = await deletionFixture();
  try {
    await f.compare();
    await assert.rejects(f.resolve('keep_remote', { crash: at => { if (at === boundary) throw new Error('worker_crash'); } }), /worker_crash/);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    f.reopen(); await f.refresh();
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 3);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
  } finally { f.getStore().close(); }
});

test('read errors during replay leave native bookmarks and durable mappings intact', async () => {
  const f = await deletionFixture();
  try {
    await f.compare();
    await assert.rejects(f.resolve('keep_remote', { crash: at => {
      if (at === 'after_rejoin_restore_preparation') throw new Error('worker_crash');
    } }), /worker_crash/);
    const before = await f.getStore().listMappings(scope);
    f.reopen();
    await assert.rejects(refreshRejoinDecisions({ ...f.input(), getNative: async () => { throw new Error('browser_read_failed'); } }), /browser_read_failed/);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
    assert.deepEqual(await f.getStore().listMappings(scope), before);
  } finally { f.getStore().close(); }
});

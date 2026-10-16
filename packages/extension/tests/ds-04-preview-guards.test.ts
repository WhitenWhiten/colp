import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { executeRemoteDelete, frozenRemoteDeleteCommand, mintRemoteDeleteConfirmation } from '../src/scope-commands.js';
import { previewRangeChange } from '../src/scope-range.js';
import { setupT03, seedMappedNode, t03Scope as scope } from './srg-t03-delete-harness.js';

async function fixture() {
  const f = await setupT03();
  const mount = (await f.store.getMountBinding(scope, 'mount-native-root')) ?? (await f.store.listMountBindings(scope))[0];
  if (mount) await f.store.putMountBinding(scope, { ...mount, rootRole: undefined, customSourceKey: 'folder:ordinary' });
  await seedMappedNode(f, { nativeId: 'child', colpId: 'child-colp', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'bookmark', url: 'https://example.test/' });
  const { preview } = await previewRangeChange(f.store, scope, { selectedNativeIds: [], roots: [{
    nativeId: 'native-root', title: 'Root', kind: 'folder', rootKind: 'bookmarks_bar', managed: false, children: [],
  }] });
  return { ...f, preview, command: frozenRemoteDeleteCommand(preview, 'native-root')! };
}

test('deletion rejects legacy confirmation without an observed subtree and mismatched counts', async () => {
  const f = await fixture();
  const { previewId: _preview, ...legacy } = f.command;
  assert.deepEqual(await executeRemoteDelete(f.store, scope, legacy), { ok: false, error: 'preview_stale' });
  const changedCount = { ...legacy, affectedCount: 0, confirmationToken: mintRemoteDeleteConfirmation({
    mountId: legacy.mountId, affectedCount: 0, boundaryVersion: '1' }) };
  assert.deepEqual(await executeRemoteDelete(f.store, scope, changedCount), { ok: false, error: 'confirmation_mismatch' });
  assert.deepEqual(await executeRemoteDelete(f.store, scope, { ...f.command, affectedCount: 2 }),
    { ok: false, error: 'confirmation_mismatch' });
  assert.equal((await f.store.listQueue(scope)).length, 0);
});

test('same-count content changes invalidate the frozen deletion before any detach or enqueue', async () => {
  const f = await fixture();
  const child = (await f.store.getMappingByNativeId(scope, 'child'))!;
  const { scopeKey: _scopeKey, ...row } = child;
  await f.store.putMapping(scope, { ...row, projection: { ...row.projection, revision: 'r-new', resourceRevision: 'r-new' } });
  assert.deepEqual(await executeRemoteDelete(f.store, scope, f.command), { ok: false, error: 'preview_stale' });
  assert.equal((await f.store.getMountBinding(scope, f.command.mountId))?.status, 'active');
  assert.equal((await f.store.listQueue(scope)).length, 0);
});

test('lost descendant authority is stale, while unexpected database errors remain failures', async () => {
  const f = await fixture();
  await f.store.deleteMapping(scope, 'child');
  assert.deepEqual(await executeRemoteDelete(f.store, scope, f.command), { ok: false, error: 'preview_stale' });
  const broken = new Proxy({ ...f.store }, { get(target, property, receiver) {
    if (property === 'listMappings') return async () => { throw new Error('database_unavailable'); };
    return Reflect.get(target, property, receiver);
  } });
  await assert.rejects(executeRemoteDelete(broken, scope, f.command), error => error instanceof Error && error.message === 'database_unavailable');
});

test('failure to recheck the observation after counting never authorizes deletion', async () => {
  const f = await fixture(); let reads = 0;
  const interrupted = new Proxy({ ...f.store }, { get(target, property, receiver) {
    if (property === 'getRecoveryHeader') return async () => {
      if (++reads === 2) throw new Error('database_unavailable');
      return target.getRecoveryHeader(scope);
    };
    return Reflect.get(target, property, receiver);
  } });
  assert.deepEqual(await executeRemoteDelete(interrupted, scope, f.command), { ok: false, error: 'preview_stale' });
  assert.equal((await f.store.listQueue(scope)).length, 0);
});

test('loss of the counted subtree authority fails closed before authoring a delete', async () => {
  const f = await fixture();
  const interrupted = new Proxy({ ...f.store }, { get(target, property, receiver) {
    if (property === 'getRecoveryHeader') return async () => { throw new Error('remote_subtree_unknown'); };
    return Reflect.get(target, property, receiver);
  } });
  assert.deepEqual(await executeRemoteDelete(interrupted, scope, f.command), { ok: false, error: 'preview_stale' });
  assert.equal((await f.store.listQueue(scope)).length, 0);
});

import { executeRemoteDelete } from './remote-delete-preview-harness.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { countMountAffected, mintRemoteDeleteConfirmation } from '../src/scope-commands.js';

// Independent acceptance: assertions describe required behavior, not the observed defects.
installKns05IndexedDb();

async function fixture(crash?: string, source: 'active' | 'detached' = 'active', dest: 'active' | 'detached' | 'pending' = 'active') {
  const f = await setup(crash);
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: source, customSourceKey: 'folder:ordinary' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
    boundaryVersion: '1', materialized: false, status: dest, rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other', content: { title: 'Other' } } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.deleteMapping(scope, 'native-child'); await f.api.remove('native-child'); f.api.calls.length = 0;
  return f;
}

test('IA-08: remote-delete crash before enqueue leaves an empty queue', async () => {
  const f = await fixture();
  const count = await countMountAffected(f.store, scope, 'mount-bar');
  const command = { mountId: 'mount-bar', affectedCount: count,
    confirmationToken: mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: count, boundaryVersion: '1' }) };
  const fault = new Proxy({ ...f.store }, { get(target, property, receiver) {
    if (property === 'planRemoteDelete') return async () => { throw new Error('worker_crash_before_enqueue'); };
    return Reflect.get(target, property, receiver);
  } });
  await assert.rejects(() => executeRemoteDelete(fault, scope, command), /worker_crash_before_enqueue/);
  assert.equal((await f.store.listQueue(scope)).length, 0);
  await executeRemoteDelete(f.store, scope, command);
  const queued = await f.store.listQueue(scope);
  assert.equal(queued.length, 1);
});

test('IA-08: remote-delete crash after enqueue reuses the reserved Operation ID', async () => {
  const f = await fixture(); const count = await countMountAffected(f.store, scope, 'mount-bar');
  const command = { mountId: 'mount-bar', affectedCount: count,
    confirmationToken: mintRemoteDeleteConfirmation({ mountId: 'mount-bar', affectedCount: count, boundaryVersion: '1' }) };
  const fault = new Proxy({ ...f.store }, { get(target, property, receiver) {
    if (property === 'allocateSequenceAndEnqueue') return async (...args: Parameters<typeof f.store.allocateSequenceAndEnqueue>) => {
      await target.allocateSequenceAndEnqueue(...args); throw new Error('worker_crash');
    };
    return Reflect.get(target, property, receiver);
  } });
  assert.equal((await executeRemoteDelete(fault, scope, command)).ok, false);
  const original = (await f.store.listQueue(scope))[0]!;
  assert.equal((await f.store.getMountBinding(scope, 'mount-bar'))?.pendingRemoteDelete?.opId, original.opId);
  await executeRemoteDelete(f.store, scope, command);
  assert.equal((await f.store.listQueue(scope)).length, 1);
  assert.equal((await f.store.listQueue(scope))[0]?.opId, original.opId);
});

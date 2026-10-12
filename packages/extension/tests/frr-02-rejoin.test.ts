import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test('FRR-02-A: rejoin after a detached remote rename applies remote and does not roll back', async () => {
  const f = await setup();
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.setFirstRun(scope, 'completed');
  await detachScopeMount(f.store, scope, 'mount-bar');
  await f.store.deleteMapping(scope, 'native-child');
  await f.api.remove('native-child'); f.api.calls.length = 0;
  await f.applier.stage(f.page([f.mutationEvent('update')])); await f.applier.resume();
  assert.equal((await f.api.get('native-node'))[0]?.title, 'node-1');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.projection.content?.title, 'node-1');
  assert.equal((await f.store.getRemoteObservation(scope, 'node-1'))?.payload.title, 'Remote update');
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    getNative: async (id) => (await f.api.get(id))[0],
    updateNative: async (id, changes) => { await f.api.update(id, changes); },
  });
  assert.equal((await f.api.get('native-node'))[0]?.title, 'Remote update');
  const queue = createBookmarkEventQueue({ scope, store: f.store, api: f.api as unknown as BookmarkEventApi,
    autoFlush: false, uuid: (() => { let n = 0; return () => `frr2-${++n}`; })() });
  await queue.recover(); await queue.flush();
  const rollback = (await f.store.listQueue(scope)).find((row) => row.payload.type === 'update_node_content');
  assert.equal(rollback, undefined);
});

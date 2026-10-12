import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, nativeOrUndefined, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { detachScopeMount, rejoinScopeMount } from '../src/scope-commands.js';
import { virtualNativeId } from '../src/projection-native-occupancy.js';
import type { RejoinChrome } from '../src/scope-rejoin-mutation.js';

installKns05IndexedDb();

async function detachedBar(omitNodeMappings = true) {
  const f = await setup(undefined, omitNodeMappings);
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: true, status: 'active', rootRole: 'bookmarks-bar' });
  await detachScopeMount(f.store, scope, 'mount-bar');
  return f;
}

function rejoinChrome(f: Awaited<ReturnType<typeof setup>>, create = true): RejoinChrome {
  return {
    getNative: async (id) => nativeOrUndefined(f.api, id),
    getChildren: (id) => f.api.getChildren(id),
    updateNative: async (id, changes) => { await f.api.update(id, changes); },
    ...(create ? { createNative: async (input: { parentId: string; index?: number; title?: string; url?: string }) =>
      f.api.create(input) } : {}),
  };
}

test('R5: rejoin must materialize remote nodes created while detached', async () => {
  const f = await detachedBar();
  await f.applier.stage(f.page([f.createEvent('Bookmark', 91)]));
  await f.applier.resume();
  assert.equal((await f.store.getMappingByColpId(scope, 'node-created-91'))?.nativeId, 'unmounted:node-created-91');
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root']), [], rejoinChrome(f));
  assert.equal(result.mount.status, 'active');
  const mapping = await f.store.getMappingByColpId(scope, 'node-created-91');
  assert.equal(mapping && !virtualNativeId(mapping.nativeId), true);
  assert.equal((await f.api.get(mapping!.nativeId)).length, 1);
});

test('nested folder then child created while detached materialize parent-first', async () => {
  const f = await detachedBar();
  const folder = f.createEvent('Folder', 90);
  const child = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 91, collectionId: scope.collectionId,
    parentId: 'node-created-90' });
  await f.applier.stage(f.page([folder, child]));
  await f.applier.resume();
  assert.equal((await f.store.getMappingByColpId(scope, 'node-created-90'))?.nativeId, 'unmounted:node-created-90');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-created-91'))?.nativeId, 'unmounted:node-created-91');
  const creates: string[] = [];
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root']), [], {
    ...rejoinChrome(f),
    createNative: async (input) => {
      creates.push(input.parentId);
      return f.api.create(input);
    },
  });
  assert.equal(result.mount.status, 'active');
  const folderMapping = await f.store.getMappingByColpId(scope, 'node-created-90');
  const childMapping = await f.store.getMappingByColpId(scope, 'node-created-91');
  assert.equal(folderMapping && !virtualNativeId(folderMapping.nativeId), true);
  assert.equal(childMapping && !virtualNativeId(childMapping.nativeId), true);
  assert.equal((await f.api.get(childMapping!.nativeId))[0]?.parentId, folderMapping!.nativeId);
  assert.deepEqual(creates, ['native-root', folderMapping!.nativeId]);
});

test('rejoin does not claim an occupied sibling by title or URL', async () => {
  const f = await detachedBar();
  f.api.seed({ id: 'local-twin', parentId: 'native-root', title: 'Remote', url: 'https://example.test/' });
  // A synced sibling: a local-* revision would mark it as an unsynced edit, which holds the rejoin (e95c71f34).
  await f.store.putMapping(scope, { nativeId: 'local-twin', colpId: 'local-twin-colp', rootNativeId: 'native-root',
    parentNativeId: 'native-root', parentColpId: 'root-colp', nodeKind: 'bookmark',
    projection: { revision: 'twin-r1', digest: 'd-twin', content: { title: 'Remote', url: 'https://example.test/' } } });
  await f.applier.stage(f.page([f.createEvent('Bookmark', 91)]));
  await f.applier.resume();
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'local-twin']), [],
    rejoinChrome(f));
  assert.equal(result.mount.status, 'active');
  const mapping = await f.store.getMappingByColpId(scope, 'node-created-91');
  assert.equal(mapping && !virtualNativeId(mapping.nativeId), true);
  assert.notEqual(mapping?.nativeId, 'local-twin');
  assert.equal((await f.store.getMappingByNativeId(scope, 'local-twin'))?.colpId, 'local-twin-colp');
});

test('rejoin stays pending when the parent cannot be materialized', async () => {
  const f = await detachedBar();
  await f.applier.stage(f.page([f.createEvent('Bookmark', 91)]));
  await f.applier.resume();
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root']), [], rejoinChrome(f, false));
  assert.notEqual(result.mount.status, 'active');
  assert.equal((await f.store.getMappingByColpId(scope, 'node-created-91'))?.nativeId, 'unmounted:node-created-91');
});

test('rejoin does not guess bookmarks-bar when the mount native is missing', async () => {
  const f = await detachedBar();
  await f.api.remove('native-root');
  await f.applier.stage(f.page([f.createEvent('Bookmark', 91)]));
  await f.applier.resume();
  const creates: string[] = [];
  const result = await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(), [], {
    getNative: async (id) => nativeOrUndefined(f.api, id),
    createNative: async (input) => {
      creates.push(input.parentId);
      return f.api.create(input);
    },
  });
  assert.notEqual(result.mount.status, 'active');
  assert.deepEqual(creates, []);
  assert.equal((await f.store.getMappingByColpId(scope, 'node-created-91'))?.nativeId, 'unmounted:node-created-91');
});

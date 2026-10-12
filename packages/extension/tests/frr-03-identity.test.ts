import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { virtualNativeId } from '../src/projection-native-occupancy.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

test('FRR-03-A: a distinct remote Node with identical content maps independently', async () => {
  const f = await setup();
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'Remote', url: 'https://example.test/' });
  await f.applier.stage(f.page([f.createEvent('Bookmark', 72)]));
  await f.applier.resume();
  assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
  assert.ok(await f.store.getMappingByColpId(scope, 'node-created-72'));
  assert.equal((await f.api.getChildren('native-root'))
    .filter((node) => node.title === 'Remote' && node.url === 'https://example.test/').length, 2);
});

test('FRR-03-B: two local candidates do not block an unrelated remote node', async () => {
  const f = await setup(undefined, true);
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  f.api.seed({ id: 'dup-1', parentId: 'native-root', title: 'Remote', url: 'https://example.test/' });
  f.api.seed({ id: 'dup-2', parentId: 'native-root', title: 'Remote', url: 'https://example.test/' });
  const staged = [
    { nativeId: 'recovery:collection-root', colpId: 'collection-root', rootNativeId: 'recovery:collection-root',
      nodeKind: 'folder' as const, projection: { revision: 'r', digest: 'd-root', content: { folderRole: 'root', title: '' } } },
    { nativeId: 'recovery:root-colp', colpId: 'root-colp', parentColpId: 'collection-root', rootNativeId: 'recovery:collection-root',
      nodeKind: 'folder' as const, rootRole: 'bookmarks-bar' as const,
      projection: { revision: 'r', digest: 'd-mount', content: { folderRole: 'bookmarks-bar', title: 'Bar' } } },
    ...['duplicate', 'unrelated'].map((id) => ({ nativeId: `recovery:${id}`, colpId: id, parentColpId: 'root-colp',
      rootNativeId: 'recovery:collection-root', nodeKind: 'bookmark' as const,
      projection: { revision: 'r', digest: `d-${id}`, content: { title: id === 'duplicate' ? 'Remote' : 'Unrelated',
        url: id === 'duplicate' ? 'https://example.test/' : 'https://unrelated.example.test/' } } })),
  ];
  await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api, staged, freezeUnprovenIdentity: true });
  assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
  assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen ?? false, false);
  const unrelated = await f.store.getMappingByColpId(scope, 'unrelated');
  assert.ok(unrelated && !virtualNativeId(unrelated.nativeId));
  const unrelatedIntent = (await f.store.listProjectionIntents(scope))
    .find((intent) => intent.colpId === 'unrelated');
  assert.equal(unrelatedIntent?.state, 'terminal');
  assert.equal((await f.api.get(unrelated.nativeId))[0]?.title, 'Unrelated');
  const duplicateNatives = (await f.api.getChildren('native-root'))
    .filter((node) => node.title === 'Remote' && node.url === 'https://example.test/');
  assert.equal(duplicateNatives.some((node) => node.id === 'dup-1'), true);
  assert.equal(duplicateNatives.some((node) => node.id === 'dup-2'), true);
  const duplicate = await f.store.getMappingByColpId(scope, 'duplicate');
  const duplicateIntent = (await f.store.listProjectionIntents(scope))
    .find((intent) => intent.colpId === 'duplicate');
  const projected = Boolean(duplicate && !virtualNativeId(duplicate.nativeId)
    && duplicate.nativeId !== 'dup-1' && duplicate.nativeId !== 'dup-2');
  const candidate = duplicateIntent?.state === 'ambiguous';
  assert.ok(projected || candidate);
});

test('FRR-03: restore does not claim a unique equal-content sibling', async () => {
  const f = await setup();
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  f.api.seed({ id: 'native-sibling', parentId: 'native-root', index: 1, title: 'Remote',
    url: 'https://example.test/' });
  const restore = pullFixtures.restoreEvent({ sequence: 73, collectionId: scope.collectionId,
    targetId: 'restored-independent', parentId: 'root-colp' });
  await f.applier.stage(f.page([restore]));
  await f.applier.resume();
  const mapping = await f.store.getMappingByColpId(scope, 'restored-independent');
  assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
  assert.notEqual(mapping?.nativeId, 'native-sibling');
  assert.equal((await f.store.getMappingByNativeId(scope, 'native-sibling'))?.colpId, undefined);
  assert.equal((await f.api.getChildren('native-root'))
    .filter((node) => node.title === 'Remote' && node.url === 'https://example.test/').length, 2);
});

test('FRR-03: crash replay does not bind a unique equal-content sibling that is not evidence', async () => {
  const f = await setup('after_browser_call');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  f.api.seed({ id: 'native-prior', parentId: 'native-root', index: 0, title: 'Remote',
    url: 'https://example.test/' });
  await f.applier.stage(f.page([f.createEvent('Bookmark', 76)]));
  await assert.rejects(() => f.applier.resume(), /worker_crash/);
  const created = (await f.api.getChildren('native-root')).find((node) => node.id.startsWith('created-'));
  const evidenceId = (await f.store.exportScope(scope)).intents
    .map((intent) => intent.apiResultEvidence?.nativeId).find((id) => typeof id === 'string');
  assert.equal(evidenceId, created?.id);
  f.api.seed({ id: 'native-sibling', parentId: 'native-root', index: 2, title: 'Remote',
    url: 'https://example.test/' });
  f.disableCrash();
  await f.applier.resume();
  const mapping = await f.store.getMappingByColpId(scope, 'node-created-76');
  assert.equal(mapping?.nativeId, evidenceId);
  assert.notEqual(mapping?.nativeId, 'native-sibling');
  assert.equal((await f.store.getMappingByNativeId(scope, 'native-sibling'))?.colpId, undefined);
});

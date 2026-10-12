import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { rejoinScopeMount } from '../src/scope-commands.js';
import { applyConfirmedRange, previewRangeChange } from '../src/scope-range.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';

// Independent acceptance: assertions describe required behavior, not the observed defects.
installKns05IndexedDb();

async function fixture(crash?: string, source: 'active' | 'detached' = 'active', dest: 'active' | 'detached' | 'pending' = 'active') {
  const f = await setup(crash);
  await f.store.setFirstRun(scope, 'completed');
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
    boundaryVersion: '1', materialized: false, status: source, rootRole: 'bookmarks-bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other', remoteMountNodeId: 'other-colp',
    boundaryVersion: '1', materialized: false, status: dest, rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other', nodeKind: 'folder',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other', content: { title: 'Other' } } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.deleteMapping(scope, 'native-child'); await f.api.remove('native-child'); f.api.calls.length = 0;
  return f;
}

test('IA-05: a rejoin with unknown baseline stays inactive', async () => {
  const f = await fixture(undefined, 'detached');
  await rejoinScopeMount(f.store, scope, 'mount-bar', new Set(['native-root', 'native-node']), [], {
    getNative: async id => (await f.api.get(id))[0], updateNative: async (id, changes) => f.api.update(id, changes),
  });
  assert.notEqual((await f.store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
});

test('IA-06: settings range detach records the same pause baseline as scope.detach', async () => {
  const f = await fixture();
  const roots: NormalizedBookmarkRoot[] = [
    { nativeId: 'native-root', title: 'Bar', kind: 'folder', managed: false, rootKind: 'bookmarks_bar', children: [] },
    { nativeId: 'native-other', title: 'Other', kind: 'folder', managed: false, rootKind: 'other', children: [] },
  ];
  const { preview } = await previewRangeChange(f.store, scope, { roots, selectedNativeIds: ['native-other'] });
  await applyConfirmedRange(f.store, scope, { preview, keepNativeIds: [], unmountNativeIds: [] });
  const mount = await f.store.getMountBinding(scope, 'mount-bar');
  assert.equal(mount?.status, 'detached');
  assert.equal(mount.pauseBaseline?.completeness, 'complete');
});


import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import type { MappingInput, MountBindingRecord } from '../src/sync-state-store.js';
import { completeWithMappings, installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

const incoming: MappingInput = { nativeId: 'new-folder', colpId: 'server-folder', rootNativeId: 'new-folder',
  mountId: 'new-mount', nodeKind: 'folder', parentColpId: 'root-colp', rootRole: 'custom',
  projection: { revision: 'r-server', childrenRevision: 'children-server', digest: 'sha256:server',
    content: { title: 'New folder', folderRole: 'custom' } } };
const binding: Omit<MountBindingRecord, 'scopeKey'> = { mountId: 'new-mount', nativeRootId: 'new-folder',
  remoteMountNodeId: 'server-folder', boundaryVersion: '1', materialized: false,
  customSourceKey: 'folder:new-folder', status: 'active' };

async function localRoot() {
  const f = await setup();
  await f.store.configureBrowserRoots(scope, { discovered: [{ nativeId: 'new-folder', ancestorNativeIds: [] }],
    selectedNativeIds: ['new-folder'], privateNativeIds: [], status: 'ready' });
  const local = (await f.store.getMappingByNativeId(scope, incoming.nativeId))!;
  assert.equal(local.projection.revision, 'local-root');
  return { ...f, local };
}

test('confirmed mount replaces only its local root reservation and atomically updates selected roots', async () => {
  const f = await localRoot();
  try {
    await f.store.putMountBinding(scope, binding);
    await completeWithMappings(f.store, 'root-page', 'cursor-old', 'cursor-new', [incoming]);
    assert.equal((await f.store.getMappingByNativeId(scope, incoming.nativeId))?.colpId, incoming.colpId);
    assert.equal(await f.store.getMappingByColpId(scope, f.local.colpId), null);
    assert.deepEqual((await f.store.getScope(scope))?.selectedRoots, [incoming.colpId]);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-new');
    assert.equal(f.api.calls.length, 0);
  } finally { f.store.close(); }
});

test('an already blocked local-root page resumes with the confirmed mount binding', async () => {
  const f = await localRoot();
  try {
    await assert.rejects(completeWithMappings(f.store, 'root-page', 'cursor-old', 'cursor-new', [incoming]), /recovery_required/);
    assert.equal((await f.store.listPullPages(scope))[0]?.state, 'blocked');
    await f.store.putMountBinding(scope, binding);
    await f.store.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      authorityRefreshRequired: true, notBefore: 0, lastError: 'recovery_required' });
    await f.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-old', serverRevision: 'revision-old' });
    await f.store.stagePullPage(scope, { pageId: 'root-page', previousCursor: 'cursor-old', nextCursor: 'cursor-new',
      collectionRevision: 'rev-root-page', pageDigest: 'sha256:root-page', events: [{
        eventId: 'root-page-e1', cursor: 'cursor-new', operationId: 'root-page-op', effectId: 'root-page-fx',
        effectDigest: 'sha256:fx', operationDigest: 'sha256:op', kind: 'node_created', payload: {},
      }], effectPages: [] });
    await f.store.completePullPage(scope, 'root-page');
    assert.equal((await f.store.listPullPages(scope))[0]?.state, 'page_complete');
    assert.equal((await f.store.getMappingByNativeId(scope, incoming.nativeId))?.colpId, incoming.colpId);
    assert.deepEqual((await f.store.getScope(scope))?.selectedRoots, [incoming.colpId]);
    assert.equal(f.api.calls.length, 0);
  } finally { f.store.close(); }
});

for (const invalid of ['remote-target', 'native-target', 'pending-mount', 'missing-mount',
  'authoritative-native', 'wrong-local-digest', 'bookmark', 'occupied-server-id'] as const) {
  test(`local-root promotion rejects ${invalid}`, async () => {
    const f = await localRoot();
    try {
      if (invalid !== 'missing-mount') await f.store.putMountBinding(scope, { ...binding,
        ...(invalid === 'remote-target' ? { remoteMountNodeId: 'another-server-id' } : {}),
        ...(invalid === 'native-target' ? { nativeRootId: 'another-native' } : {}),
        ...(invalid === 'pending-mount' ? { status: 'pending' } : {}),
      });
      const { scopeKey: _key, ...local } = f.local;
      if (invalid === 'authoritative-native' || invalid === 'wrong-local-digest') await f.store.putMapping(scope, {
        ...local, projection: { ...local.projection,
          ...(invalid === 'authoritative-native' ? { revision: 'real-server-revision', resourceRevision: 'real-server-revision' }
            : { digest: 'sha256:edited' }) },
      });
      if (invalid === 'occupied-server-id') await f.store.putMapping(scope, {
        ...incoming, nativeId: 'different-native', rootNativeId: 'different-native',
      });
      await assert.rejects(completeWithMappings(f.store, 'root-page', 'cursor-old', 'cursor-new',
        [{ ...incoming, ...(invalid === 'bookmark' ? { nodeKind: 'bookmark' } : {}) }]), /recovery_required/);
      assert.equal((await f.store.getMappingByNativeId(scope, incoming.nativeId))?.colpId, f.local.colpId);
      assert.deepEqual((await f.store.getScope(scope))?.selectedRoots, [f.local.colpId]);
      assert.equal(f.api.calls.length, 0);
    } finally { f.store.close(); }
  });
}

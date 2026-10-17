import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { bindKnownRoleMounts } from '../src/bootstrap/known-role-mounts.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import type { RemoteNodeFact } from '../src/bootstrap/matcher.js';

const scope: SyncScope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
const fact: RemoteNodeFact = { nodeId: 'canonical-bar', parentId: 'canonical-root', kind: 'folder',
  title: 'Bookmarks bar', folderRole: 'bookmarks-bar', revision: 'server-r1', childrenRevision: 'server-c1' };
let store: ReturnType<typeof createSyncStateStore>;
beforeEach(async () => {
  store = createSyncStateStore({ indexedDB: new IDBFactory() });
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: null, selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  await store.putMountBinding(scope, { mountId: 'bar', nativeRootId: '1', remoteMountNodeId: null,
    status: 'pending', materialized: false, rootRole: 'bookmarks-bar', boundaryVersion: '1' });
  await store.configureBrowserRoots(scope, { discovered: [{ nativeId: '1', ancestorNativeIds: [] }],
    selectedNativeIds: ['1'], privateNativeIds: ['1'], status: 'ready' });
});
afterEach(() => store.close());

test('canonical role binding promotes a local reservation and its selection/exclusion references together', async () => {
  const local = (await store.getMappingByNativeId(scope, '1'))!;
  await store.putMapping(scope, { nativeId: 'recovery:bar', colpId: fact.nodeId, rootNativeId: 'recovery:root',
    nodeKind: 'folder', projection: { revision: fact.revision, digest: 'sha256:remote' } });
  await bindKnownRoleMounts(store, scope, [fact], 'canonical-root');
  expect(await store.getScope(scope)).toMatchObject({ selectedRoots: ['canonical-bar'], privateRoots: ['canonical-bar'] });
  expect(await store.getMappingByNativeId(scope, '1')).toMatchObject({ colpId: fact.nodeId, rootRole: 'bookmarks-bar',
    projection: { revision: fact.revision, childrenRevision: fact.childrenRevision } });
  expect(await store.getMappingByNativeId(scope, 'recovery:bar')).toBeNull();
  expect(await store.getMappingByColpId(scope, local.colpId)).toBeNull();
  expect(await store.getMountBinding(scope, 'bar')).toMatchObject({ status: 'active', remoteMountNodeId: fact.nodeId });
});

test.each(['occupied', 'detached', 'duplicate-role', 'different-parent', 'missing-role'] as const)(
  '%s remote facts cannot replace the local reservation or selected identities', async reason => {
    if (reason === 'occupied') await store.putMapping(scope, { nativeId: 'another-browser-root', colpId: fact.nodeId,
      rootNativeId: 'another-browser-root', nodeKind: 'folder', projection: { revision: fact.revision, digest: 'sha256:live' } });
    if (reason === 'detached') await store.detachMount(scope, 'bar');
    const before = await store.exportScope(scope);
    const facts = reason === 'duplicate-role' ? [fact, { ...fact, nodeId: 'duplicate' }]
      : reason === 'different-parent' ? [{ ...fact, parentId: 'another-root' }] : reason === 'missing-role' ? [] : [fact];
    await bindKnownRoleMounts(store, scope, facts, 'canonical-root');
    expect(await store.exportScope(scope)).toEqual(before);
  });

test('canonical role discovery never replaces an established browser-to-remote identity', async () => {
  await store.deleteMapping(scope, '1');
  await store.putMapping(scope, { nativeId: '1', colpId: 'established', rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'established-r1', digest: 'sha256:established' } });
  const before = await store.exportScope(scope);
  await bindKnownRoleMounts(store, scope, [fact], 'canonical-root');
  expect(await store.exportScope(scope)).toEqual(before);
});

test('a stale role-binding retry cannot overwrite a newer landed projection for the same remote identity', async () => {
  await store.deleteMapping(scope, '1');
  await store.putMapping(scope, { nativeId: '1', colpId: fact.nodeId, rootNativeId: '1', nodeKind: 'folder',
    projection: { revision: 'server-r2', digest: 'sha256:newer', content: { title: 'Newer projection' } } });
  const before = await store.exportScope(scope);
  expect(await store.bindResolvedMountMapping(scope, { nativeId: '1', colpId: fact.nodeId, rootNativeId: '1',
    mountId: 'bar', nodeKind: 'folder', rootRole: 'bookmarks-bar', projection: { revision: fact.revision, digest: 'sha256:stale' } })).toBe(false);
  expect(await store.exportScope(scope)).toEqual(before);
});

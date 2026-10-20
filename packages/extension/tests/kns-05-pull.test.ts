/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { projectChildrenReordered } from '../src/bookmark-reorder-projection.js';
import { mayMutateNative } from '../src/pull-mount-apply.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { createSyncStateStore, SyncStateError, type MappingInput, type MountBindingRecord } from '../src/sync-state-store.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import {
  completeWithMappings, fakeApi, indexedDB, installKns05IndexedDb, mappingInput, mountBar, scope, setup,
} from './kns-05-pull-harness.js';

installKns05IndexedDb();

describe('KNS-05 pull apply, suppression and freeze', () => {
  test('remote delete removes live nodes and does not create a browser trash folder', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.some((call) => call.kind === 'delete'), true);
    assert.equal(fixture.api.calls.some((call) => call.kind === 'create'), false);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'node-1'), null);
    assert.equal(JSON.stringify(fixture.api.calls).toLowerCase().includes('trash'), false);
  });

  test('does not apply unmounted remote events and performs zero Chrome mutations', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const other = pullFixtures.createEvent({ kind: 'Folder', sequence: 51, collectionId: scope.collectionId,
      parentId: 'root-colp', folderRole: 'other-bookmarks' });
    const child = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 52, collectionId: scope.collectionId,
      parentId: 'node-created-51' });
    await fixture.applier.stage(fixture.page([other, child]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.length, 0);
    assert.ok((await fixture.store.getMappingByColpId(scope, 'node-created-51'))?.nativeId.startsWith('unmounted:'));
  });

  test.each(['invalid_effect', 'tampered_digest', 'wrong_source', 'missing_effect_page'] as const)(
    'freezes %s with zero Chrome mutation', async (fault) => {
      const fixture = await setup();
      const page = fixture.corrupt(fixture.page([fixture.createEvent('Bookmark')]), fault);
      await assert.rejects(() => fixture.applier.stage(page));
      assert.equal(fixture.api.calls.length, 0);
      assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'recovery_required');
      assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
    });

  test('sets an update of an unknown node aside with zero Chrome mutation', async () => {
    const fixture = await setup(undefined, true);
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.length, 0);
    // B5: one node this browser cannot place is one item; the cursor moves on.
    assert.deepEqual((await fixture.store.listPullIssues(scope)).map((issue) => [issue.nodeId, issue.code]),
      [['node-1', 'target_mapping_missing']]);
    const exported = await fixture.store.exportScope(scope);
    assert.equal(exported.scope?.lifecycle, 'active');
    assert.equal(exported.cursor?.cursor, 'cursor-next');
  });

  test('binds a special mount node without creating a browser system folder', async () => {
    const fixture = await setup();
    fixture.api.seed({ id: 'bar', index: 0, title: 'Bookmarks bar' });
    await mountBar(fixture, { nativeRootId: 'bar', remoteMountNodeId: null, rootRole: 'bookmarks-bar' });
    const mountNode = pullFixtures.createEvent({ kind: 'Folder', sequence: 81, collectionId: scope.collectionId,
      parentId: 'root-colp', folderRole: 'bookmarks-bar' });
    const child = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 82, collectionId: scope.collectionId,
      parentId: 'node-created-81' });
    await fixture.applier.stage(fixture.page([mountNode, child]));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.some((call) => call.kind === 'create' && call.nativeId === 'bar'), false);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-81'))?.nativeId, 'bar');
    assert.equal((await fixture.store.listMountBindings(scope))[0]?.remoteMountNodeId, 'node-created-81');
    const created = (await fixture.api.getChildren('bar')).find((node) => node.id.startsWith('created-'));
    assert.equal(created?.parentId, 'bar');
  });

  test('Chrome-creates snapshot children under an already-bound native bar mapping', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-kns05-replica-b',
      expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' },
      selectedRoots: [], rootStatus: 'ready', firstRun: 'running', mountMode: 'whole-profile' });
    await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'mount-bar',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
    await store.putMapping(scope, {
      nativeId: 'bar', colpId: 'mount-bar', rootNativeId: 'bar', nodeKind: 'folder', mountId: 'mount-bar',
      rootRole: 'bookmarks-bar', projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-colp', colpId: 'root-colp', rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '', folderRole: 'root' } },
    }, {
      nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'root-colp', rootRole: 'bookmarks-bar',
      projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    }, {
      nativeId: 'recovery:conflict', colpId: 'conflict', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
      parentColpId: 'mount-bar', projection: { revision: 'r-conflict', digest: 'sha256:conflict',
        content: { title: 'KNS08 conflict', url: 'https://example.test/conflict' } },
    }, {
      nativeId: 'recovery:folder-b', colpId: 'folder-b', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'mount-bar', projection: { revision: 'r-folder', childrenRevision: 'children-folder',
        digest: 'sha256:folder', content: { title: 'KNS08 move folder B' } },
    }, {
      nativeId: 'recovery:nested', colpId: 'nested', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
      parentColpId: 'folder-b', projection: { revision: 'r-nested', digest: 'sha256:nested',
        content: { title: 'KNS08 nested', url: 'https://example.test/nested' } },
    }];
    const api = fakeApi(); api.seed({ id: 'bar', index: 0, title: 'Bookmarks bar' });
    const projected = await recoverVerifiedOrFreeze({ scope, store, staged, api, freezeUnprovenIdentity: true });
    const creates = api.calls.filter((call) => call.kind === 'create');
    const children = await api.getChildren('bar');
    const folder = projected.find((row) => row.colpId === 'folder-b');
    const conflict = projected.find((row) => row.colpId === 'conflict');
    const nested = projected.find((row) => row.colpId === 'nested');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, undefined);
    assert.equal(projected.find((row) => row.colpId === 'mount-bar')?.nativeId, 'bar');
    assert.equal(creates.some((call) => call.nativeId === 'bar'), false);
    assert.equal(children.some((node) => node.title === 'Bookmarks bar'), false);
    assert.equal(children.some((node) => node.title === 'KNS08 conflict'), true);
    assert.equal(children.some((node) => node.title === 'KNS08 move folder B'), true);
    assert.ok(conflict?.nativeId && !conflict.nativeId.startsWith('recovery:'));
    assert.ok(folder?.nativeId && !folder.nativeId.startsWith('recovery:'));
    assert.ok(nested?.nativeId && !nested.nativeId.startsWith('recovery:'));
    assert.equal((await api.get(conflict!.nativeId))[0]?.parentId, 'bar');
    assert.equal((await api.get(nested!.nativeId))[0]?.parentId, folder!.nativeId);
    assert.equal((await store.getMappingByColpId(scope, 'conflict'))?.nativeId, conflict!.nativeId);
    assert.equal((await store.getMappingByColpId(scope, 'folder-b'))?.nativeId, folder!.nativeId);
    assert.equal((await store.getMappingByColpId(scope, 'nested'))?.nativeId, nested!.nativeId);
    assert.equal((await store.getMappingByColpId(scope, 'conflict'))?.rootNativeId, 'bar');
    assert.equal((await store.getMappingByColpId(scope, 'nested'))?.rootNativeId, 'bar');
    assert.equal(JSON.stringify(projected).includes('pending-'), false);
  });

  test('reprojects leftover virtual children after a later special-role mount bind', async () => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-kns05-later-bind',
      expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' },
      selectedRoots: [], rootStatus: 'ready', firstRun: 'running', mountMode: 'whole-profile' });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-colp', colpId: 'root-colp', rootNativeId: 'recovery:root', nodeKind: 'folder',
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '', folderRole: 'root' } },
    }, {
      nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'root-colp', rootRole: 'bookmarks-bar',
      projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    }, {
      nativeId: 'recovery:conflict', colpId: 'conflict', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
      parentColpId: 'mount-bar', projection: { revision: 'r-conflict', digest: 'sha256:conflict',
        content: { title: 'KNS08 conflict', url: 'https://example.test/conflict' } },
    }, {
      nativeId: 'recovery:folder-b', colpId: 'folder-b', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'mount-bar', projection: { revision: 'r-folder', childrenRevision: 'children-folder',
        digest: 'sha256:folder', content: { title: 'KNS08 move folder B' } },
    }, {
      nativeId: 'recovery:nested', colpId: 'nested', rootNativeId: 'recovery:root', nodeKind: 'bookmark',
      parentColpId: 'folder-b', projection: { revision: 'r-nested', digest: 'sha256:nested',
        content: { title: 'KNS08 nested', url: 'https://example.test/nested' } },
    }];
    const api = fakeApi(); api.seed({ id: 'bar', index: 0, title: 'Bookmarks bar' });
    const first = await recoverVerifiedOrFreeze({ scope, store, staged, api, freezeUnprovenIdentity: true });
    assert.equal(api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal(first.every((row) => row.nativeId.startsWith('recovery:')), true);
    for (const mapping of first) await store.putMapping(scope, mapping);
    await store.replaceProjectionIntents(scope, [{
      intentId: 'create:stale', kind: 'create', colpId: 'stale', order: 1,
      suppression: 'recovery:create:stale', generation: 1, state: 'terminal',
    }]);
    await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'mount-bar',
      boundaryVersion: '1', materialized: false, status: 'active', rootRole: 'bookmarks-bar' });
    const live = await store.listMappings(scope);
    const projected = await recoverVerifiedOrFreeze({ scope, store, staged: live, api, freezeUnprovenIdentity: true });
    const children = await api.getChildren('bar');
    const folder = projected.find((row) => row.colpId === 'folder-b');
    const conflict = projected.find((row) => row.colpId === 'conflict');
    const nested = projected.find((row) => row.colpId === 'nested');
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, undefined);
    assert.equal(projected.find((row) => row.colpId === 'mount-bar')?.nativeId, 'bar');
    assert.equal(api.calls.some((call) => call.kind === 'create' && call.nativeId === 'bar'), false);
    assert.equal(children.some((node) => node.title === 'Bookmarks bar'), false);
    assert.equal(children.some((node) => node.title === 'KNS08 conflict'), true);
    assert.equal(children.some((node) => node.title === 'KNS08 move folder B'), true);
    assert.ok(conflict?.nativeId && !conflict.nativeId.startsWith('recovery:'));
    assert.ok(folder?.nativeId && !folder.nativeId.startsWith('recovery:'));
    assert.ok(nested?.nativeId && !nested.nativeId.startsWith('recovery:'));
    assert.equal((await api.get(conflict!.nativeId))[0]?.parentId, 'bar');
    assert.equal((await api.get(nested!.nativeId))[0]?.parentId, folder!.nativeId);
    assert.equal((await store.getMappingByColpId(scope, 'conflict'))?.nativeId, conflict!.nativeId);
    assert.equal((await store.getMappingByNativeId(scope, 'recovery:conflict')), null);
    assert.equal((await store.getMappingByColpId(scope, 'nested'))?.rootNativeId, 'bar');
    assert.equal(JSON.stringify(projected).includes('pending-'), false);
  });

  test.each(['active', 'pending'] as const)('projects snapshot children only under a confirmed active mount (%s)', async status => {
    const store = createSyncStateStore({ indexedDB });
    await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-kns05',
      expiresAt: Date.parse('2099-01-01T00:00:00Z') }, checkpoint: { serverRevision: 'revision-old', cursor: 'cursor-old' },
      selectedRoots: [], rootStatus: 'ready', firstRun: 'running' });
    await store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: null,
      boundaryVersion: '1', materialized: false, status, rootRole: 'bookmarks-bar' });
    const staged: MappingInput[] = [{
      nativeId: 'recovery:root-colp', colpId: 'root-colp', rootNativeId: 'recovery:root', nodeKind: 'folder' as const,
      projection: { revision: 'r-root', childrenRevision: 'children-root', digest: 'sha256:root',
        content: { title: '', folderRole: 'root' } },
    }, {
      nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder' as const,
      parentColpId: 'root-colp', rootRole: 'bookmarks-bar' as const,
      projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bar', folderRole: 'bookmarks-bar' } },
    }, {
      nativeId: 'recovery:child-a', colpId: 'child-a', rootNativeId: 'recovery:root', nodeKind: 'bookmark' as const,
      parentColpId: 'mount-bar', projection: { revision: 'r-child', digest: 'sha256:child',
        content: { title: 'Child', url: 'https://example.test/child' } },
    }];
    const api = fakeApi(); api.seed({ id: 'bar', index: 0, title: 'Bookmarks bar' });
    const projected = await recoverVerifiedOrFreeze({ scope, store, staged, api, freezeUnprovenIdentity: true });
    const children = await api.getChildren('bar');
    assert.equal(api.calls.filter((call) => call.kind === 'create').length, status === 'active' ? 1 : 0);
    assert.equal(children.some((node) => node.title === 'Bar'), false);
    assert.equal(children.some((node) => node.title === 'Child'), status === 'active');
    assert.equal(projected.find((row) => row.colpId === 'mount-bar')?.nativeId, 'bar');
    const child = projected.find((row) => row.colpId === 'child-a');
    if (status === 'active') {
      assert.ok(child?.nativeId && !child.nativeId.startsWith('recovery:'));
      assert.equal((await api.get(child!.nativeId))[0]?.parentId, 'bar');
    } else {
      assert.equal(child?.nativeId, 'recovery:child-a');
      assert.deepEqual(await store.listProjectionIntents(scope), []);
    }
  });

  test('applies node_created under a bound mount whose mapping is still recovery:*', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'mount-bar', rootRole: 'bookmarks-bar' });
    await fixture.store.putMapping(scope, {
      nativeId: 'recovery:mount-bar', colpId: 'mount-bar', rootNativeId: 'recovery:root', nodeKind: 'folder',
      parentColpId: 'root-colp', rootRole: 'bookmarks-bar',
      projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:mount',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    });
    await fixture.applier.stage(fixture.page([pullFixtures.createEvent({
      kind: 'Bookmark', sequence: 93, collectionId: scope.collectionId, parentId: 'mount-bar',
    })]));
    await fixture.applier.resume();
    const mapping = await fixture.store.getMappingByColpId(scope, 'node-created-93');
    assert.ok(mapping?.nativeId && !mapping.nativeId.startsWith('recovery:')
      && !mapping.nativeId.startsWith('unmounted:'));
    assert.equal(mapping?.rootNativeId, 'native-root');
    assert.equal(mapping?.parentNativeId, 'native-root');
    assert.equal((await fixture.api.get(mapping!.nativeId))[0]?.parentId, 'native-root');
    assert.equal(fixture.api.calls.some((call) => call.kind === 'create'), true);
  });

  test('applies node_created after cutover when the mapping is still virtual', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, {
      nativeId: 'recovery:node-created-91', colpId: 'node-created-91', rootNativeId: 'native-root',
      nodeKind: 'bookmark', parentNativeId: 'native-root', parentColpId: 'root-colp',
      projection: { revision: 'revision-old', digest: 'sha256:virtual',
        content: { title: 'Remote', url: 'https://example.test/' } },
    });
    await fixture.applier.stage(fixture.page([pullFixtures.createEvent({
      kind: 'Bookmark', sequence: 91, collectionId: scope.collectionId, parentId: 'root-colp',
    })]));
    await fixture.applier.resume();
    const mapping = await fixture.store.getMappingByColpId(scope, 'node-created-91');
    assert.ok(mapping?.nativeId && !mapping.nativeId.startsWith('recovery:'));
    assert.equal(fixture.api.calls.some((call) => call.kind === 'create'), true);
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'recovery:node-created-91'), null);
  });

  test('completePullPage puts a mapping when the colpId has no owner', async () => {
    const fixture = await setup();
    await completeWithMappings(fixture.store, 'map-new', 'cursor-old', 'cursor-map-1', [
      mappingInput('native-new', 'colp-new'),
    ]);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'colp-new'))?.nativeId, 'native-new');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-map-1');
  });

  test('completePullPage overwrites when the colpId owner is the same native', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('native-same', 'colp-same'));
    await completeWithMappings(fixture.store, 'map-same', 'cursor-old', 'cursor-map-2', [
      { ...mappingInput('native-same', 'colp-same'), projection: { revision: 'r2', digest: 'sha256:native-same-2' } },
    ]);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'colp-same'))?.projection.digest, 'sha256:native-same-2');
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-map-2');
  });

  test('completePullPage replaces a virtual colpId owner with a real native', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('unmounted:colp-virt', 'colp-virt'));
    await completeWithMappings(fixture.store, 'map-virt', 'cursor-old', 'cursor-map-3', [
      mappingInput('native-virt', 'colp-virt'),
    ]);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'colp-virt'))?.nativeId, 'native-virt');
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'unmounted:colp-virt'), null);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-map-3');
  });

  test('completePullPage keeps a real native when the pending mapping is virtual', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('native-real', 'colp-keep'));
    await completeWithMappings(fixture.store, 'map-skip', 'cursor-old', 'cursor-map-4', [
      mappingInput('unmounted:colp-keep', 'colp-keep'),
    ]);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'colp-keep'))?.nativeId, 'native-real');
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'unmounted:colp-keep'), null);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-map-4');
  });

  test('completePullPage rebinds a pending-* mapping to the authoritative colpId', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('native-inflight', 'pending-op-echo'));
    await completeWithMappings(fixture.store, 'map-echo', 'cursor-old', 'cursor-map-echo', [
      mappingInput('native-inflight', 'colp-echo'),
    ]);
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'native-inflight'))?.colpId, 'colp-echo');
    assert.equal(await fixture.store.getMappingByColpId(scope, 'pending-op-echo'), null);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-map-echo');
  });

  test('completePullPage blocks two real natives fighting for the same colpId', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, mappingInput('native-a', 'colp-fight'));
    await assert.rejects(() => completeWithMappings(fixture.store, 'map-fight', 'cursor-old', 'cursor-map-5', [
      mappingInput('native-b', 'colp-fight'),
    ]), SyncStateError);
    const exported = await fixture.store.exportScope(scope);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'colp-fight'))?.nativeId, 'native-a');
    assert.equal(exported.pullPages[0]?.state, 'blocked');
    assert.equal(exported.pullPages[0]?.recoveryCode, 'mapping_identity_conflict');
    assert.equal(exported.scope?.lifecycle, 'recovery_required');
    assert.equal((await fixture.store.getCursor(scope))?.cursor ?? exported.scope?.checkpoint?.cursor, 'cursor-old');
  });

  test('refuses to stage a second page while a leftover staged page shares previousCursor', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.createEvent('Bookmark')]));
    await assert.rejects(
      () => fixture.applier.stage(fixture.page([fixture.createEvent('Folder')], 'cursor-other')),
      /pull_page_pending/,
    );
  });

  test('onChildrenReordered updates local projection only and does not enqueue an Operation', async () => {
    // A-09 (SR-08): the projection half of this test is unchanged; what changed is
    // that the return value now names what happened (`code`), so a projection-only
    // caller cannot be confused with an uploaded reorder. The production seam
    // (`sw/bookmarks.ts` -> `queue.reordered()`) injects the uplink and is covered
    // by tests/bookmark-reorder-uplink.test.ts; this call, with no uplink, is still
    // honestly `local_projection_only` and still enqueues nothing.
    const fixture = await setup();
    const result = await projectChildrenReordered({ scope, store: fixture.store, parentNativeId: 'native-root',
      childIds: ['native-node', 'native-child'] });
    assert.equal(result.outcome, 'projected');
    assert.equal(result.code, 'local_projection_only');
    const mapping = await fixture.store.getMappingByNativeId(scope, 'native-root');
    assert.equal(mapping?.projection.content?.childrenOrderDigest, undefined);
    assert.deepEqual(mapping?.projection.childrenOrder, ['native-node', 'native-child']);
    assert.equal((await fixture.store.listQueue(scope)).length, 0);
    const diagnostics = await fixture.store.exportDiagnostics();
    assert.equal(diagnostics.records.some((row) => row.code === 'local_projection_only'
      && row.kind === 'children_reordered'), true);
  });

  test('ordinary folder delete with no extras still Chrome-removes the folder', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, {
      nativeId: 'native-empty', colpId: 'empty-colp', rootNativeId: 'native-root', nodeKind: 'folder',
      parentNativeId: 'native-root', parentColpId: 'root-colp',
      projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:empty',
        content: { title: 'empty' } },
    });
    fixture.api.seed({ id: 'native-empty', parentId: 'native-root', index: 1, title: 'empty' });
    const treeIds: string[] = [];
    const removeTree = fixture.api.removeTree.bind(fixture.api);
    fixture.api.removeTree = async (id: string) => { treeIds.push(id); await removeTree(id); };
    const event = pullFixtures.mutationEvent({ kind: 'delete', sequence: 90, collectionId: scope.collectionId,
      targetId: 'empty-colp', parentId: 'root-colp', targetKind: 'folder' });
    await fixture.applier.stage(fixture.page([event]));
    await fixture.applier.resume();
    // A-11: the honest double now rejects `get` for a removed id (real Chromium never returns
    // `[]`), so absence is asserted through the fixture's own view instead of a fake empty array.
    assert.equal(fixture.api.getNode('native-empty'), undefined);
    assert.equal(treeIds.includes('native-empty'), false);
    assert.equal(await fixture.store.getMappingByNativeId(scope, 'native-empty'), null);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
  });

  test.each(['node_deleted', 'subtree_deleted'] as const)(
    'pending mount Pull %s observes without Chrome remove',
    async (kind) => {
      const fixture = await setup();
      await fixture.store.putMountBinding(scope, {
        mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
        boundaryVersion: '1', materialized: false, status: 'pending', rootRole: 'bookmarks-bar',
      });
      const event = kind === 'node_deleted' ? fixture.mutationEvent('delete')
        : pullFixtures.subtreeEvent({
          sequence: 50, collectionId: scope.collectionId, targetId: 'node-1',
          members: ['node-1', 'node-child'], paged: false,
        });
      await fixture.applier.stage(fixture.page([event]));
      await fixture.applier.resume();
      assert.equal(fixture.api.calls.some((call) => call.kind === 'delete'), false);
      assert.equal((await fixture.api.get('native-node')).length, 1);
      assert.equal((await fixture.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'native-node');
      assert.equal((await fixture.store.getRemoteObservation(scope, 'node-1'))?.kind, 'tombstone');
    },
  );

  test('mayMutateNative is writable-active only', () => {
    const mapping = { nativeId: 'native-node', mountId: 'mount-bar', rootNativeId: 'native-root' };
    const mount = (overrides: Partial<MountBindingRecord> = {}): MountBindingRecord => ({
      scopeKey: 's', mountId: 'mount-bar', nativeRootId: 'native-root', remoteMountNodeId: 'root-colp',
      boundaryVersion: '1', materialized: false, status: 'active', ...overrides,
    });
    assert.equal(mayMutateNative(mapping, []), true);
    assert.equal(mayMutateNative(mapping, [mount()]), true);
    assert.equal(mayMutateNative(mapping, [mount({ status: 'pending' })]), false);
    assert.equal(mayMutateNative(mapping, [mount({ status: 'detached' })]), false);
    assert.equal(mayMutateNative(mapping, [mount({ remoteMountNodeId: null })]), false);
    assert.equal(mayMutateNative(mapping, [mount({ mountId: 'other', nativeRootId: 'other-root' })]), false);
    assert.equal(mayMutateNative({ ...mapping, nativeId: 'sidecar:node' }, []), false);
    assert.equal(mayMutateNative({ ...mapping, nativeId: 'native-root' }, [mount()]), false);
  });
});

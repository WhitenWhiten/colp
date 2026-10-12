/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: see e2e/kns-08-ids.ts.
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBookmarkEventQueue, type BookmarkEventApi } from '../src/bookmark-event-queue.js';
import { createPullApplier } from '../src/pull-applier.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import {
  installKns05IndexedDb, mountBar, scope, setup,
} from './kns-05-pull-harness.js';

installKns05IndexedDb();

describe('KNS-05 pull restore', () => {
  test('applies node_restored with the original COLP id', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([fixture.mutationEvent('delete')]));
    await fixture.applier.resume();
    const restore = pullFixtures.restoreEvent({ sequence: 40, collectionId: scope.collectionId, targetId: 'node-1',
      parentId: 'root-colp' });
    await fixture.applier.stage(fixture.page([restore], 'cursor-restore'));
    await fixture.applier.resume();
    const mapping = await fixture.store.getMappingByColpId(scope, 'node-1');
    assert.equal(mapping?.colpId, 'node-1');
    assert.equal(mapping?.parentNativeId, 'native-root');
    assert.ok(mapping?.nativeId && !/^(?:sidecar:|pending-|recovery:)/.test(mapping.nativeId));
    assert.equal(JSON.stringify(await fixture.store.listMappings(scope)).includes('pending-'), false);
    assert.equal(fixture.api.calls.some((call) => call.kind === 'create'), true);
    assert.equal(await fixture.applier.observe(fixture.api.lastEvent!), true);
    assert.equal((await fixture.store.listQueue(scope)).length, 0);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, undefined);
  });

  test('does not guess Recovered onto the only local mount when the parent is missing', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const restore = pullFixtures.restoreEvent({ sequence: 41, collectionId: scope.collectionId,
      targetId: 'ghost-node', parentId: 'missing-parent' });
    await assert.rejects(() => fixture.applier.stage(fixture.page([restore])), /need_authority/);
    const titles = (await fixture.api.getChildren('native-root')).map((node) => String(node.title ?? ''));
    assert.equal(titles.includes('Recovered'), false);
    assert.equal(titles.some((title) => /trash/i.test(title)), false);
    assert.equal(JSON.stringify(fixture.api.calls).toLowerCase().includes('trash'), false);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'ghost-node'), null);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'missing-parent'), null);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'recovery_required');
    assert.equal((await fixture.store.exportScope(scope)).pullPages.length, 0);
  });

  test('does not Chrome-create Recovered for an unmapped server recovered folder', async () => {
    const fixture = await setup();
    fixture.api.seed({ id: '1', index: 0, title: 'Bookmarks bar' });
    await mountBar(fixture, { nativeRootId: '1', remoteMountNodeId: 'mount-bar', rootRole: 'bookmarks-bar' });
    await fixture.store.putMapping(scope, {
      nativeId: '1', colpId: 'mount-bar', rootNativeId: '1', nodeKind: 'folder', mountId: 'mount-bar',
      rootRole: 'bookmarks-bar', projection: { revision: 'r-bar', childrenRevision: 'children-bar', digest: 'sha256:bar',
        content: { title: 'Bookmarks bar', folderRole: 'bookmarks-bar' } },
    });
    const restore = pullFixtures.restoreEvent({ sequence: 42, collectionId: scope.collectionId,
      targetId: 'orphan-child', parentId: 'recovered-folder-colp', title: 'KNS08 orphan child' });
    await assert.rejects(() => fixture.applier.stage(fixture.page([restore])), /need_authority/);
    const barChildren = await fixture.api.getChildren('1');
    assert.equal(barChildren.some((node) => node.title === 'Recovered'), false);
    assert.equal(barChildren.some((node) => /trash/i.test(String(node.title ?? ''))), false);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 0);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'orphan-child'), null);
    assert.equal(await fixture.store.getMappingByColpId(scope, 'recovered-folder-colp'), null);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'recovery_required');
  });

  test('materializes Recovered only when the original mount mapping is proven', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const rec = pullFixtures.createEvent({ kind: 'Folder', sequence: 45, collectionId: scope.collectionId,
      parentId: 'root-colp', folderRole: 'recovered' });
    const restore = pullFixtures.restoreEvent({ sequence: 46, collectionId: scope.collectionId,
      targetId: 'proven-orphan', parentId: 'node-created-45', title: 'KNS08 proven orphan' });
    await fixture.applier.stage(fixture.page([rec, restore]));
    await fixture.applier.resume();
    const recovered = (await fixture.api.getChildren('native-root')).find((node) => node.title === 'Recovered');
    const restored = await fixture.store.getMappingByColpId(scope, 'proven-orphan');
    assert.ok(recovered);
    assert.equal(restored?.parentNativeId, recovered.id);
    assert.equal((await fixture.api.get(restored?.nativeId ?? ''))[0]?.parentId, recovered.id);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-45'))?.nativeId, recovered.id);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-45'))?.projection.content?.folderRole,
      'recovered');
    assert.ok(restored?.nativeId && !/^(?:sidecar:|pending-|recovery:|unmounted:)/.test(restored.nativeId));
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
  });

  test('does not freeze node_restored when Recovered create is already on the page', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const rec = pullFixtures.createEvent({ kind: 'Folder', sequence: 43, collectionId: scope.collectionId,
      parentId: 'root-colp', folderRole: 'recovered' });
    const restore = pullFixtures.restoreEvent({ sequence: 44, collectionId: scope.collectionId,
      targetId: 'orphan-child', parentId: 'node-created-43', title: 'KNS08 orphan child' });
    await fixture.applier.stage(fixture.page([rec, restore]));
    await fixture.applier.resume();
    const recovered = (await fixture.api.getChildren('native-root')).find((node) => node.title === 'Recovered');
    assert.ok(recovered);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'orphan-child'))?.parentNativeId, recovered.id);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'node-created-43'))?.nativeId, recovered.id);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, undefined);
    assert.equal((await fixture.store.getEngineState(scope))?.lastError, undefined);
  });

  test('parent-gone restore does not claim a pre-existing Recovered folder', async () => {
    const fixture = await setup();
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    fixture.api.seed({ id: 'user-recovered', parentId: 'native-root', index: 0, title: 'Recovered' });
    const rec = pullFixtures.createEvent({ kind: 'Folder', sequence: 47, collectionId: scope.collectionId,
      parentId: 'root-colp', folderRole: 'recovered' });
    const restore = pullFixtures.restoreEvent({ sequence: 48, collectionId: scope.collectionId,
      targetId: 'orphan-independent', parentId: 'node-created-47', title: 'KNS08 orphan child' });
    await fixture.applier.stage(fixture.page([rec, restore]));
    await fixture.applier.resume();
    const recovered = (await fixture.api.getChildren('native-root')).filter((node) => node.title === 'Recovered');
    const restored = await fixture.store.getMappingByColpId(scope, 'orphan-independent');
    assert.equal(recovered.length, 2);
    assert.notEqual(restored?.parentNativeId, 'user-recovered');
    assert.equal((await fixture.store.getMappingByNativeId(scope, 'user-recovered'))?.colpId, undefined);
    assert.equal((await fixture.store.exportScope(scope)).scope?.lifecycle, 'active');
  });

  test('parent-gone restore resumes after Chrome create without duplicating Recovered or the child', async () => {
    const fixture = await setup('after_browser_call');
    await mountBar(fixture, { nativeRootId: 'native-root', remoteMountNodeId: 'root-colp' });
    const rec = pullFixtures.createEvent({ kind: 'Folder', sequence: 72, collectionId: scope.collectionId,
      parentId: 'root-colp', folderRole: 'recovered' });
    const restore = pullFixtures.restoreEvent({ sequence: 73, collectionId: scope.collectionId,
      targetId: 'orphan-crash', parentId: 'node-created-72', title: 'KNS08 orphan child' });
    await fixture.applier.stage(fixture.page([rec, restore]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    fixture.disableCrash();
    await createPullApplier(fixture.options).resume();
    const recovered = (await fixture.api.getChildren('native-root')).filter((node) => node.title === 'Recovered');
    const orphans = (await fixture.api.getChildren(recovered[0]?.id ?? ''))
      .filter((node) => node.title === 'KNS08 orphan child');
    assert.equal(recovered.length, 1);
    assert.equal(orphans.length, 1);
    assert.equal((await fixture.store.getMappingByColpId(scope, 'orphan-crash'))?.colpId, 'orphan-crash');
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, undefined);
  });

  test('swallows a restore echo so it does not re-enter Push', async () => {
    const fixture = await setup('after_browser_call');
    const restore = pullFixtures.restoreEvent({ sequence: 61, collectionId: scope.collectionId,
      targetId: 'restored-live', parentId: 'root-colp' });
    await fixture.applier.stage(fixture.page([restore]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    const created = (await fixture.api.getChildren('native-root')).find((node) => node.id.startsWith('created-'))!;
    const queue = createBookmarkEventQueue({ scope, store: fixture.store,
      api: { get: (id) => fixture.api.get(id), getChildren: (id) => fixture.api.getChildren(id) } as BookmarkEventApi,
      autoFlush: false });
    const echo = await queue.created(created.id, { id: created.id, parentId: 'native-root', index: 0,
      title: 'Remote', url: 'https://example.test/' });
    assert.equal(echo.outcome, 'apply_intent_reserved');
    assert.equal((await fixture.store.listQueue(scope)).length, 0);
  });

  test.each(['before_event', 'after_browser_call'] as const)('restarts unfinished restore intents after %s', async (boundary) => {
    const fixture = await setup(boundary);
    const restore = pullFixtures.restoreEvent({ sequence: 71, collectionId: scope.collectionId,
      targetId: 'restored-crash', parentId: 'root-colp' });
    await fixture.applier.stage(fixture.page([restore]));
    await assert.rejects(() => fixture.applier.resume(), /worker_crash/);
    if (boundary === 'before_event') {
      const intent = (await fixture.store.exportScope(scope)).intents[0];
      assert.equal(intent?.generation, 1);
      assert.ok(intent?.state === 'browser_call_started' || intent?.state === 'intent_prepared');
    }
    fixture.disableCrash();
    await createPullApplier(fixture.options).resume();
    assert.equal((await fixture.store.getMappingByColpId(scope, 'restored-crash'))?.colpId, 'restored-crash');
    assert.equal((await fixture.store.exportScope(scope)).cursor?.cursor, 'cursor-next');
  });

  test('applies node_restored after cutover when the mapping is still virtual', async () => {
    const fixture = await setup();
    await fixture.store.putMapping(scope, {
      nativeId: 'recovery:restored-virtual', colpId: 'restored-virtual', rootNativeId: 'native-root',
      nodeKind: 'bookmark', parentNativeId: 'native-root', parentColpId: 'root-colp',
      projection: { revision: 'revision-old', digest: 'sha256:virtual',
        content: { title: 'Remote', url: 'https://example.test/' } },
    });
    await fixture.applier.stage(fixture.page([pullFixtures.restoreEvent({ sequence: 92,
      collectionId: scope.collectionId, targetId: 'restored-virtual', parentId: 'root-colp' })]));
    await fixture.applier.resume();
    const mapping = await fixture.store.getMappingByColpId(scope, 'restored-virtual');
    assert.ok(mapping?.nativeId && !mapping.nativeId.startsWith('recovery:'));
    assert.equal(fixture.api.calls.some((call) => call.kind === 'create'), true);
  });
});

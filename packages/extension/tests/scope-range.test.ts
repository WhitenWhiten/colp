/**
 * Owner: KNS-08 (QA). Fixture: see e2e/kns-08-ids.ts.
 * Run: npx vitest run tests/scope-range.test.ts tests/bookmark-roots.test.ts
 * Evidence: test-results/known-extension-first-run-sync/<commit>/
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { localFactsFromRoots } from '../src/bootstrap/local-facts.js';
import { scanBoundary } from '../src/bookmark-boundary.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import type { NormalizedBookmarkRoot } from '../src/chrome-bookmark-tree.js';
import {
  confirmAddRange, countMountAffected, detachScopeMount, executeRemoteDelete, mintRemoteDeleteConfirmation,
  previewAddRange,
} from '../src/scope-commands.js';
import {
  applyConfirmedRange, consumeRangePreview, discoveredFromRoots, liveAuthorityFromExport, previewRangeChange, previewRejection,
} from '../src/scope-range.js';
import { keepShiftedMount, preserveShiftMappings } from '../src/scope-range-shift.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { validRootRequest } from '../src/sw/messages.js';

const scope: SyncScope = Object.freeze({
  environment: 'production', serverId: 'server-range', serverOrigin: 'https://known.example',
  accountId: 'account-range', browserProfileId: 'profile-range', collectionId: 'collection-range',
  replicaId: 'replica-range', generation: 1,
});

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('P1-04 range preview, confirm, unmount and shift', () => {
  test('unselected root and subtree stay out of the scan and do not enqueue', async () => {
    const store = await activeStore();
    await seedBar(store);
    const roots = tree();
    const scan = scanBoundary({ roots, selectedNativeIds: ['bar'], privateNativeIds: [] });
    assert.equal(scan.classifications.get('other'), 'out-of-boundary');
    assert.equal(scan.classifications.get('skip-bm'), 'out-of-boundary');
    const before = liveAuthorityFromExport(await store.exportScope(scope));
    const preview = await previewAddRange(store, scope, { roots, selectedNativeIds: ['bar'] });
    assert.equal(preview.ok, true);
    assert.equal((await store.getScope(scope))?.boundaryVersion, before.scope?.boundaryVersion);
    assert.deepEqual(liveAuthorityFromExport(await store.exportScope(scope)), before);
    assert.equal((await store.listQueue(scope)).length, 0);
    const facts = localFactsFromRoots(roots, ['bar']);
    assert.equal(facts.some((row) => row.nativeId === 'skip-bm' || row.url === 'https://example.com/skip'), false);
  });

  test('nested selection normalizes to the minimal ancestor and warns', async () => {
    const roots = tree();
    const scan = scanBoundary({ roots, selectedNativeIds: ['bar', 'nested'] });
    assert.deepEqual(scan.selectedNativeIds, ['bar']);
    assert.equal(scan.nestedNormalized, true);
    assert.ok(scan.warnings.some((row) => row.code === 'nested_normalized'));
  });

  test.each(['bookmarks_bar', 'browser_root'] as const)(
    'confirming a %s range replaces the previous mount identity', async (rootKind) => {
      const store = await activeStore();
      try {
        await seedBar(store);
        const { scopeKey: _scopeKey, rootRole: _rootRole, ...prior } = (await store.getMountBinding(scope, 'mount-bar'))!;
        await store.putMountBinding(scope, { ...prior, ...(rootKind === 'bookmarks_bar'
          ? { customSourceKey: 'folder:legacy' } : { rootRole: 'bookmarks-bar' as const }) });
        const roots = tree().map(root => root.nativeId === 'bar' ? { ...root, rootKind } : root);
        const { preview } = await previewRangeChange(store, scope, { roots, selectedNativeIds: ['bar'] });

        await applyConfirmedRange(store, scope, { preview, keepNativeIds: [], unmountNativeIds: [] });

        const mount = (await store.getMountBinding(scope, 'mount-bar'))!;
        assert.equal(mount.rootRole, rootKind === 'bookmarks_bar' ? 'bookmarks-bar' : undefined);
        assert.equal(mount.customSourceKey, rootKind === 'browser_root' ? 'folder:bar' : undefined);
        assert.equal(mount.remoteMountNodeId, prior.remoteMountNodeId);
        assert.equal(mount.status, prior.status);
        assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'colp-bm-1');
        assert.deepEqual(await store.listQueue(scope), []);
      } finally { store.close(); }
    });

  test.each([['bar', 'other'], ['bar', 'nested', 'other']])(
    'expanding sync to browser roots preserves already synced nested folders (%j)', async (...selectedNativeIds) => {
      const store = await activeStore();
      await seedNested(store);
      const roots = tree();
      const discovered = [...discoveredFromRoots(roots)].map(([nativeId, ancestorNativeIds]) => ({ nativeId, ancestorNativeIds }));
      await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: ['nested'], privateNativeIds: [], status: 'ready' });
      const beforeMount = await store.getMountBinding(scope, 'mount-nested');
      const beforeMappings = await store.listMappings(scope);

      const { preview, diff } = await previewRangeChange(store, scope, { roots, selectedNativeIds });
      assert.deepEqual(diff.addedNativeIds, ['bar', 'other']);
      assert.deepEqual(diff.removedNativeIds, []);
      assert.deepEqual(diff.shiftNativeIds, []);
      assert.equal(preview.bookmarkCount, 4);
      assert.deepEqual(preview.remoteDeleteEvidence ?? [], []);

      await applyConfirmedRange(store, scope, { preview, keepNativeIds: [], unmountNativeIds: [] });
      await store.configureBrowserRoots(scope, { discovered, selectedNativeIds: preview.boundary.selectedNativeIds,
        privateNativeIds: [], status: 'ready' });
      assert.deepEqual(await store.getMountBinding(scope, 'mount-nested'), beforeMount);
      for (const mapping of beforeMappings) {
        assert.deepEqual(await store.getMappingByNativeId(scope, mapping.nativeId), mapping);
      }
      assert.deepEqual(await store.listQueue(scope), []);
      store.close();
    });

  test('explicitly excluding an existing nested mount still offers removal under a selected ancestor', async () => {
    const store = await activeStore();
    await seedNested(store);
    const { preview, diff } = await previewRangeChange(store, scope, {
      roots: tree(), selectedNativeIds: ['bar', 'other'], privateNativeIds: ['nested'],
    });
    assert.deepEqual(diff.removedNativeIds, ['nested']);
    assert.equal(preview.remoteDeleteEvidence?.[0]?.nativeRootId, 'nested');
    await applyConfirmedRange(store, scope, { preview, keepNativeIds: [], unmountNativeIds: [] });
    assert.equal((await store.getMountBinding(scope, 'mount-nested'))?.status, 'detached');
    store.close();
  });

  test('managed and private-local folders are excluded from writable mounts', async () => {
    const roots = tree();
    const scan = scanBoundary({
      roots, selectedNativeIds: ['bar', 'managed'], privateNativeIds: ['nested'],
    });
    assert.equal(scan.classifications.get('managed'), 'managed');
    assert.equal(scan.classifications.get('nested'), 'private-local');
    assert.ok(scan.mounts.every((mount) => mount.nativeRootId !== 'managed' && mount.nativeRootId !== 'nested'));
  });

  test('duplicate confirm, digest mismatch, expiry and later boundary bump are rejected', async () => {
    const store = await activeStore();
    await seedBar(store);
    const roots = tree();
    const { preview } = await previewRangeChange(store, scope, { roots, selectedNativeIds: ['bar'] });
    assert.equal(previewRejection(preview, { now: Date.now(), liveBoundaryVersion: '0', treeDigest: 'wrong' }),
      'preview_stale');
    assert.equal(previewRejection(preview, { now: preview.expiresAt + 1, liveBoundaryVersion: '0' }),
      'request_invalid');
    await consumeRangePreview(store, scope, preview);
    const consumed = await store.getScopePreview(scope, preview.previewId);
    assert.equal(previewRejection(consumed, { now: Date.now(), liveBoundaryVersion: '0', treeDigest: preview.treeDigest }),
      'duplicate_confirm');
    const second = await previewRangeChange(store, scope, { roots, selectedNativeIds: ['bar'] });
    await store.bumpBoundaryVersion(scope);
    assert.equal(previewRejection(second.preview, {
      now: Date.now(), liveBoundaryVersion: (await store.getScope(scope))?.boundaryVersion ?? '1',
      treeDigest: second.preview.treeDigest,
    }), 'preview_stale');
    const staleConfirm = await confirmAddRange(store, scope, {
      previewId: second.preview.previewId, confirmationId: 'conf-stale-boundary',
      treeDigest: second.preview.treeDigest, localFacts: [],
    });
    assert.equal(staleConfirm.ok, false);
    if (!staleConfirm.ok) assert.equal(staleConfirm.error, 'preview_stale');
  });

  test('excluding a role root keeps its binding and does not enqueue delete', async () => {
    const store = await activeStore();
    await seedBar(store);
    const roots = tree();
    const { preview, diff } = await previewRangeChange(store, scope, { roots, selectedNativeIds: [] });
    assert.ok(diff.removedNativeIds.includes('bar') || diff.shiftNativeIds.includes('bar'));
    await applyConfirmedRange(store, scope, {
      preview, keepNativeIds: [], unmountNativeIds: ['bar'],
    });
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.remoteMountNodeId, 'remote-bar');
    assert.equal((await store.getMappingByNativeId(scope, 'bm-1'))?.colpId, 'colp-bm-1');
    assert.equal((await store.listQueue(scope)).some((row) => row.payload.type === 'delete_node'
      || row.payload.type === 'delete_subtree'), false);
  });

  test('whole browser root exclusion appears in review and trashes contents idempotently', async () => {
    const store = await activeStore();
    await seedBar(store);
    const { preview, diff } = await previewRangeChange(store, scope, {
      roots: tree(), selectedNativeIds: ['bar'], privateNativeIds: ['bar'],
    });
    assert.deepEqual(diff.removedNativeIds, ['bar']);
    assert.equal(preview.remoteDeleteEvidence?.[0]?.affectedCount, 1);
    await applyConfirmedRange(store, scope, { preview, keepNativeIds: [], unmountNativeIds: [] });
    const { frozenRemoteDeleteCommand } = await import('../src/scope-commands.js');
    const command = frozenRemoteDeleteCommand(preview, 'bar')!;
    assert.equal((await executeRemoteDelete(store, scope, command)).ok, true);
    assert.equal((await executeRemoteDelete(store, scope, command)).ok, true);
    const queued = await store.listQueue(scope);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.payload.targetId, 'colp-bm-1');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
    const { discoveredFromRoots } = await import('../src/scope-range.js');
    await store.configureBrowserRoots(scope, { discovered: [...discoveredFromRoots(tree())].map(([nativeId, ancestorNativeIds]) => ({ nativeId, ancestorNativeIds })),
      selectedNativeIds: ['bar'], privateNativeIds: ['bar'], status: 'ready' });
    await assert.rejects(previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: ['bar'], privateNativeIds: [] }), /sync_busy/);
    store.close();
  });

  test('root trash keeps its frozen mount version across a later range confirmation', async () => {
    const store = await activeStore(); await seedBar(store);
    await store.bumpBoundaryVersion(scope); await store.bumpBoundaryVersion(scope); await store.bumpBoundaryVersion(scope);
    const { preview } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: ['bar'], privateNativeIds: ['bar'] });
    assert.notEqual(preview.boundaryVersion, (await store.getMountBinding(scope, 'mount-bar'))!.boundaryVersion);
    await applyConfirmedRange(store, scope, { preview, keepNativeIds: [], unmountNativeIds: [], remoteDeleteNativeIds: ['bar'] });
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))!.boundaryVersion, '1');
    // The range's own bootstrap confirmation stages mounts before the frozen
    // delete plan runs; it must not invalidate the version that plan froze.
    assert.equal((await confirmAddRange(store, scope, {
      previewId: preview.previewId, confirmationId: 'conf-root-trash', treeDigest: preview.treeDigest,
      localFacts: localFactsFromRoots(tree(), ['bar'], [], ['bar']),
      preserveBoundaryNativeIds: ['bar'], consumePreview: false,
    })).ok, true);
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))!.boundaryVersion, '1');
    const { frozenRemoteDeleteCommand } = await import('../src/scope-commands.js');
    const command = frozenRemoteDeleteCommand(preview, 'bar')!;
    assert.equal((await executeRemoteDelete(store, scope, command)).ok, true);
    assert.deepEqual((await store.listQueue(scope)).filter(row => String(row.payload.type).startsWith('delete'))
      .map(row => row.payload.targetId), ['colp-bm-1']);
    store.close();
  });

  test('role-root trash uses remote-only bookmark kind evidence', async () => {
    const store = await activeStore();
    await seedBar(store);
    await store.putRemoteObservation(scope, { colpId: 'remote-only-bm', remoteRevision: 'remote-only-r1', cursor: 'c1',
      kind: 'content', payload: { parentId: 'remote-bar', title: 'Remote only', url: 'https://example.test/remote' },
      sourceDigest: 'digest', observedAt: 1 });
    const { preview } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: ['bar'], privateNativeIds: ['bar'] });
    const { frozenRemoteDeleteCommand } = await import('../src/scope-commands.js');
    assert.equal((await executeRemoteDelete(store, scope, frozenRemoteDeleteCommand(preview, 'bar')!)).ok, true);
    const queued = await store.listQueue(scope);
    assert.deepEqual(queued.map(row => row.payload.targetId).sort(), ['colp-bm-1', 'remote-only-bm']);
    assert.ok(queued.every(row => row.payload.type === 'delete_node'));
    store.close();
  });

  test('excluding an empty browser root has a zero-content trash plan', async () => {
    const store = await activeStore();
    await seedBar(store);
    await store.deleteMapping(scope, 'bm-1');
    const { preview, diff } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: ['bar'], privateNativeIds: ['bar'] });
    assert.deepEqual(diff.removedNativeIds, ['bar']);
    assert.equal(preview.remoteDeleteEvidence?.[0]?.affectedCount, 0);
    const { frozenRemoteDeleteCommand } = await import('../src/scope-commands.js');
    assert.equal((await executeRemoteDelete(store, scope, frozenRemoteDeleteCommand(preview, 'bar')!)).ok, true);
    assert.deepEqual(await store.listQueue(scope), []);
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
    store.close();
  });

  test('explicit remote delete is a separate confirmed path with real COLP target', async () => {
    const store = await activeStore();
    await seedBar(store);
    const live = await countMountAffected(store, scope, 'mount-bar');
    assert.equal(live, 1);
    const rejected = await executeRemoteDelete(store, scope, {
      mountId: 'mount-bar', confirmationToken: 'nope', affectedCount: live,
    });
    assert.equal(rejected.ok, false);
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
    const token = mintRemoteDeleteConfirmation({
      mountId: 'mount-bar', affectedCount: live, boundaryVersion: '1',
    });
    const { preview } = await previewRangeChange(store, scope, { roots: tree(), selectedNativeIds: [] });
    const accepted = await executeRemoteDelete(store, scope, {
      mountId: 'mount-bar', confirmationToken: token, affectedCount: live, previewId: preview.previewId,
    });
    assert.equal(accepted.ok, true);
    const queued = await store.listQueue(scope);
    assert.equal(queued[0]?.payload.type, 'delete_node');
    assert.equal(queued[0]?.payload.targetId, 'colp-bm-1');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'active');
  });

  test('keeping a shifted ordinary folder preserves the COLP id', async () => {
    const store = await activeStore();
    await seedBar(store);
    await store.putMountBinding(scope, {
      mountId: 'mount-nested', nativeRootId: 'nested', remoteMountNodeId: 'remote-nested',
      boundaryVersion: '1', materialized: false, status: 'detached',
      customSourceKey: 'folder:nested', pendingShift: { colpId: 'remote-nested', fromParentNativeId: 'bar' },
    });
    await store.putMapping(scope, {
      nativeId: 'nested', colpId: 'remote-nested', rootNativeId: 'bar', mountId: 'mount-nested', nodeKind: 'folder',
      projection: { revision: 'r-nested', digest: 'sha256:nested' },
    });
    const mount = await store.getMountBinding(scope, 'mount-nested');
    const kept = await keepShiftedMount(store, scope, { mount: mount!, nativeRootId: 'nested' });
    await preserveShiftMappings(store, scope, {
      nativeRootId: 'nested', colpId: 'remote-nested', mountId: kept.mountId,
    });
    assert.equal(kept.status, 'active');
    assert.equal(kept.remoteMountNodeId, 'remote-nested');
    assert.equal((await store.getMappingByNativeId(scope, 'nested'))?.colpId, 'remote-nested');
    assert.equal(kept.pendingShift, undefined);
  });

  test('restart after an unconfirmed preview does not apply mounts or queue work', async () => {
    const store = await activeStore();
    await seedBar(store);
    const roots = tree();
    const before = liveAuthorityFromExport(await store.exportScope(scope));
    await previewRangeChange(store, scope, { roots, selectedNativeIds: ['bar', 'other'] });
    assert.deepEqual(liveAuthorityFromExport(await store.exportScope(scope)), before);
    store.close();
    const reopened = createSyncStateStore({ indexedDB });
    assert.equal((await reopened.getMountBinding(scope, 'mount-bar'))?.status, 'active');
    assert.equal((await reopened.listQueue(scope)).length, 0);
    assert.equal((await reopened.listMountBindings(scope)).some((mount) => mount.nativeRootId === 'other'), false);
  });

  test('confirmAddRange still uploads only newly selected existing bookmarks', async () => {
    const store = await activeStore();
    await seedBar(store);
    const roots = tree();
    const preview = await previewAddRange(store, scope, { roots, selectedNativeIds: ['bar'] });
    const confirmed = await confirmAddRange(store, scope, {
      previewId: preview.previewId, confirmationId: 'conf-range', treeDigest: preview.treeDigest,
      localFacts: localFactsFromRoots(roots, ['bar']),
      remoteFacts: [
        { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
        { nodeId: 'remote-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
          revision: 'r1' },
      ],
      rootNodeId: 'folder-root', now: () => 50,
    });
    assert.equal(confirmed.ok, true);
    const created = (await store.listQueue(scope)).filter((row) => row.payload.type === 'create_node');
    const wire = JSON.stringify(created);
    assert.equal(wire.includes('https://example.com/one'), false);
    assert.equal(wire.includes('https://example.com/two'), true);
    assert.equal(wire.includes('https://example.com/skip'), false);
    const duplicate = await confirmAddRange(store, scope, {
      previewId: preview.previewId, confirmationId: 'conf-range-2', treeDigest: preview.treeDigest,
      localFacts: localFactsFromRoots(roots, ['bar']),
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error, 'duplicate_confirm');
  });

  test('confirmAddRange after detach leaves the mount detached', async () => {
    const store = await activeStore();
    await seedBar(store);
    await detachScopeMount(store, scope, 'mount-bar');
    assert.equal((await store.getMountBinding(scope, 'mount-bar'))?.status, 'detached');
    const roots = tree();
    const preview = await previewAddRange(store, scope, { roots, selectedNativeIds: ['bar'] });
    const confirmed = await confirmAddRange(store, scope, {
      previewId: preview.previewId, confirmationId: 'conf-detached-range', treeDigest: preview.treeDigest,
      localFacts: localFactsFromRoots(roots, ['bar']),
      remoteFacts: [
        { nodeId: 'folder-root', parentId: null, kind: 'folder', title: '', folderRole: 'root', revision: 'r0' },
        { nodeId: 'remote-bar', parentId: 'folder-root', kind: 'folder', title: 'Bar', folderRole: 'bookmarks-bar',
          revision: 'r1' },
      ],
      rootNodeId: 'folder-root', now: () => 50,
    });
    assert.equal(confirmed.ok, true);
    const mount = await store.getMountBinding(scope, 'mount-bar');
    assert.equal(mount?.status, 'detached');
    assert.notEqual(mount?.status, 'pending');
    assert.notEqual(mount?.status, 'active');
  });

  test('moving a mapped ordinary folder out of boundary does not enqueue a subtree delete', async () => {
    const store = await activeStore();
    await seedBar(store);
    await store.putMapping(scope, {
      nativeId: 'nested', colpId: 'remote-nested', rootNativeId: 'bar', mountId: 'mount-bar', nodeKind: 'folder',
      projection: { revision: 'r-nested', digest: 'sha256:nested', content: { title: 'Nested' } },
    });
    const api = {
      async get(id: string) {
        if (id === 'nested') return [{ id: 'nested', parentId: 'other', title: 'Nested', type: 'folder' as const }];
        return [];
      },
      async getChildren() { return []; },
    };
    const queue = createBookmarkEventQueue({
      scope, store, api, now: () => '2026-09-09T00:00:00Z', uuid: () => 'shift-1', autoFlush: false,
    });
    const outcome = await queue.moved('nested', {
      parentId: 'other', index: 0, oldParentId: 'bar', oldIndex: 0,
    });
    assert.equal(outcome.outcome, 'filtered');
    assert.equal((await store.listQueue(scope)).length, 0);
    const shifted = (await store.listMountBindings(scope)).find((mount) => mount.nativeRootId === 'nested');
    assert.equal(shifted?.pendingShift?.colpId, 'remote-nested');
    assert.equal((await store.getMappingByNativeId(scope, 'nested'))?.colpId, 'remote-nested');
  });

  test('root message validators accept preview and confirm without native ids', () => {
    assert.equal(validRootRequest({
      kind: 'known.roots.preview', viewId: 'view', selectedRefs: ['a'], privateRefs: [],
    }), true);
    assert.equal(validRootRequest({
      kind: 'known.roots.confirm', previewId: 'preview', confirmationId: 'confirm', treeDigest: 'sha256:tree',
    }), true);
    assert.equal(validRootRequest({
      kind: 'known.roots.confirm', previewId: 'preview', confirmationId: 'confirm', treeDigest: 'sha256:tree',
      shiftActions: [{ ref: 'r1', action: 'keep' }], remoteDeleteRefs: ['r2'],
    }), true);
    assert.equal(validRootRequest({
      kind: 'known.roots.confirm', previewId: 'preview', confirmationId: 'confirm', treeDigest: 'sha256:tree',
      nativeId: 'chrome-id',
    }), false);
  });
});

async function activeStore() {
  const store = createSyncStateStore({ indexedDB });
  await store.registerScope({
    ...scope, lifecycle: 'active', lease: { leaseId: 'lease-range', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], rootStatus: 'ready',
    firstRun: 'completed',
  });
  return store;
}

async function seedBar(store: ReturnType<typeof createSyncStateStore>) {
  await store.putMountBinding(scope, {
    mountId: 'mount-bar', nativeRootId: 'bar', remoteMountNodeId: 'remote-bar', boundaryVersion: '1',
    materialized: false, status: 'active', rootRole: 'bookmarks-bar',
  });
  await store.putMapping(scope, {
    nativeId: 'bar', colpId: 'remote-bar', rootNativeId: 'bar', mountId: 'mount-bar', nodeKind: 'folder',
    projection: { revision: 'r-bar', digest: 'sha256:bar', content: { title: 'Bar' } },
  });
  await store.putMapping(scope, {
    nativeId: 'bm-1', colpId: 'colp-bm-1', rootNativeId: 'bar', mountId: 'mount-bar', parentNativeId: 'bar',
    nodeKind: 'bookmark', projection: { revision: 'r-bm', digest: 'sha256:bm',
      content: { title: 'One', url: 'https://example.com/one' } },
  });
}

async function seedNested(store: ReturnType<typeof createSyncStateStore>) {
  await store.putMountBinding(scope, {
    mountId: 'mount-nested', nativeRootId: 'nested', remoteMountNodeId: 'remote-nested', boundaryVersion: '1',
    materialized: false, status: 'active', customSourceKey: 'folder:nested',
  });
  await store.putMapping(scope, {
    nativeId: 'nested', colpId: 'remote-nested', rootNativeId: 'nested', mountId: 'mount-nested', nodeKind: 'folder',
    projection: { revision: 'r-nested', childrenRevision: 'c-nested', digest: 'sha256:nested', content: { title: 'Nested' } },
  });
  await store.putMapping(scope, {
    nativeId: 'bm-3', colpId: 'colp-bm-3', rootNativeId: 'nested', mountId: 'mount-nested', parentNativeId: 'nested',
    nodeKind: 'bookmark', projection: { revision: 'r-bm-3', digest: 'sha256:bm-3',
      content: { title: 'Three', url: 'https://example.com/three' } },
  });
}

function tree(): readonly NormalizedBookmarkRoot[] {
  return [
    {
      nativeId: 'bar', title: 'Bar', kind: 'folder', managed: false, rootKind: 'bookmarks_bar', children: [
        { nativeId: 'bm-1', title: 'One', kind: 'bookmark', managed: false, url: 'https://example.com/one', children: [] },
        { nativeId: 'bm-2', title: 'Two', kind: 'bookmark', managed: false, url: 'https://example.com/two', children: [] },
        {
          nativeId: 'nested', title: 'Nested', kind: 'folder', managed: false, children: [
            { nativeId: 'bm-3', title: 'Three', kind: 'bookmark', managed: false, url: 'https://example.com/three', children: [] },
          ],
        },
      ],
    },
    {
      nativeId: 'other', title: 'Other', kind: 'folder', managed: false, rootKind: 'other', children: [
        { nativeId: 'skip-bm', title: 'Skip', kind: 'bookmark', managed: false, url: 'https://example.com/skip', children: [] },
      ],
    },
    {
      nativeId: 'managed', title: 'Managed', kind: 'folder', managed: true, rootKind: 'browser_root', children: [],
    },
  ];
}

/**
 * Owner: KNS-04. Formal IDs: FR-F2-CAPTURE-LOSS.
 * Run: npx vitest run tests/bookmark-event-reconcile.test.ts
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { bindReceiptMapping, reconcileBookmarkTree, type ReconcileHost } from '../src/bookmark-event-reconcile.js';
import { identityFromMapping, type NodeIdentity } from '../src/bookmark-node-identity.js';
import type { BookmarkEventNode } from '../src/bookmark-event-queue.js';
import { bookmark, fixture, folder, mapping, scope } from './bookmark-event-queue-harness.js';

let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

describe('bookmark tree reconcile', () => {
  test('captures an uncaptured native move with its source and destination parents', async () => {
    const { store } = await fixture(indexedDB);
    try {
      await mapping(store, 'moved-native', 'moved-node', 'root-selected', 'r1',
        { title: 'Moved', url: 'https://example.test/moved' }, 'root-selected');
      const moved: unknown[] = [];
      await reconcileBookmarkTree(host(store, {
        readChildren: async parent => parent === 'root-selected' ? [folder('folder-parent', 'root-selected', 0, 'Parent')]
          : parent === 'folder-parent' ? [bookmark('moved-native', 'folder-parent', 0, 'Moved', 'https://example.test/moved')] : [],
        moved: async (nativeId, details) => { moved.push({ nativeId, ...details }); },
      }));
      assert.deepEqual(moved, [{ nativeId: 'moved-native', parentId: 'folder-parent', index: 0,
        oldParentId: 'root-selected', oldIndex: 0 }]);
    } finally { store.close(); }
  });
  test('ignores scopes that are not ready', async () => {
    const { store } = await fixture(indexedDB);
    const current = await store.getScope(scope);
    await store.registerScope({ ...current!, lifecycle: 'active', rootStatus: 'permission_required' });
    let created = 0;
    await reconcileBookmarkTree(host(store, { created: async () => { created += 1; } }));
    assert.equal(created, 0);
  });

  test('FR-F2-CAPTURE-LOSS skips new_local create while recoveryFrozen', async () => {
    const { store, api } = await fixture(indexedDB);
    await store.transitionEngine(scope, {
      phase: 'recovery', updatedAt: 1, recoveryFrozen: true, authorityRefreshRequired: true, notBefore: 0,
    });
    api.put(bookmark('bm-frozen', 'root-selected', 0, 'Frozen', 'https://example.test/frozen'));
    let created = 0;
    await reconcileBookmarkTree(host(store, {
      created: async () => { created += 1; },
      readChildren: async (parent) => parent === 'root-selected'
        ? [bookmark('bm-frozen', 'root-selected', 0, 'Frozen', 'https://example.test/frozen')] : [],
    }));
    assert.equal(created, 0);
    assert.equal((await store.getEngineState(scope))?.recoveryFrozen, true);
  });

  test('FR-F2-CAPTURE-LOSS: a selected unmapped bookmark is created once', async () => {
    const { store, api } = await fixture(indexedDB);
    api.put(bookmark('bm-new', 'root-selected', 0, 'New', 'https://example.test/new'));
    const created: string[] = [];
    await reconcileBookmarkTree(host(store, {
      created: async (nativeId) => { created.push(nativeId); },
      readChildren: async (parent) => parent === 'root-selected'
        ? [bookmark('bm-new', 'root-selected', 0, 'New', 'https://example.test/new')] : [],
    }));
    assert.deepEqual(created, ['bm-new']);
  });

  test('receipt_unbound binds the original Node before any second create', async () => {
    const { store } = await fixture(indexedDB);
    const created: string[] = [];
    await bindReceiptMapping(store, scope, {
      nativeId: 'bm-receipt', colpId: 'node-receipt', rootNativeId: 'root-selected', revision: 'r-bind',
      parentNativeId: 'root-selected', nodeKind: 'bookmark',
      content: { title: 'Receipt', url: 'https://example.test/receipt' },
    });
    await reconcileBookmarkTree(host(store, {
      created: async (nativeId) => { created.push(nativeId); },
      readChildren: async (parent) => parent === 'root-selected'
        ? [bookmark('bm-receipt', 'root-selected', 0, 'Receipt', 'https://example.test/receipt')] : [],
    }));
    assert.deepEqual(created, []);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-receipt'))?.colpId, 'node-receipt');
  });

  test('does not delete leftover virtual mappings while they still need reproject', async () => {
    const { store } = await fixture(indexedDB);
    await mapping(store, 'recovery:child', 'colp-virtual', 'root-selected', 'r-v', { title: 'Virtual' });
    const deletes: string[] = [];
    await reconcileBookmarkTree(host(store, {
      identityFor: async () => identityFromMapping({
        nativeId: 'recovery:child', colpId: 'colp-virtual', rootNativeId: 'root-selected',
        projection: { revision: 'r-v', digest: 'sha256:v', content: { title: 'Virtual' } },
      }),
      stageDelete: async (nativeId) => { deletes.push(nativeId); },
    }));
    assert.equal(deletes.includes('recovery:child'), false);
  });

  test('skips mapped mutate and missing deletes while the engine is pulling', async () => {
    const { store } = await fixture(indexedDB, { mappedNode: true });
    await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7',
      { title: 'Server before', url: 'https://example.test/before' }, 'root-selected');
    await store.transitionEngine(scope, {
      phase: 'pulling', updatedAt: 1, recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0,
    });
    const moved: unknown[] = []; const deletes: string[] = [];
    await reconcileBookmarkTree(host(store, {
      readChildren: async (parent) => parent === 'root-selected'
        ? [folder('folder-parent', 'root-selected', 0, 'Parent')] : [],
      moved: async (_nativeId, move) => { moved.push(move); },
      stageDelete: async (nativeId) => { deletes.push(nativeId); },
    }));
    assert.deepEqual(moved, []);
    assert.deepEqual(deletes, []);
  });

  test('missing descendants wait for the parent delete and skip identity-less rows', async () => {
    const { store } = await fixture(indexedDB);
    await mapping(store, 'gone-folder', 'colp-folder', 'root-selected', 'r-f', { title: 'Gone' });
    await mapping(store, 'gone-child', 'colp-child', 'root-selected', 'r-c',
      { title: 'Child' }, 'gone-folder');
    const deletes: string[] = [];
    await reconcileBookmarkTree(host(store, {
      identityFor: async (nativeId) => (nativeId === 'gone-folder'
        ? identityFromMapping({
          nativeId: 'gone-folder', colpId: 'colp-folder', rootNativeId: 'root-selected',
          projection: { revision: 'r-f', digest: 'sha256:f', content: { title: 'Gone' } },
        }) : null),
      stageDelete: async (nativeId) => { deletes.push(nativeId); },
    }));
    assert.deepEqual(deletes, ['gone-folder']);
  });

  test('bindReceiptMapping refuses a native/colp collision and is idempotent', async () => {
    const { store } = await fixture(indexedDB);
    await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'r1', { title: 'One' });
    const collision = await bindReceiptMapping(store, scope, {
      nativeId: 'mapped', colpId: 'other-colp', rootNativeId: 'root-selected', revision: 'r2', content: null,
    });
    assert.equal(collision, false);
    assert.equal(await bindReceiptMapping(store, scope, {
      nativeId: 'other-native', colpId: 'mapped-colp', rootNativeId: 'root-selected', revision: 'r2', content: null,
    }), false, 'a receipt cannot bind an already-owned COLP identity to another native');
    const same = await bindReceiptMapping(store, scope, {
      nativeId: 'mapped', colpId: 'mapped-colp', rootNativeId: 'root-selected', revision: 'r1', content: null,
    });
    assert.equal(same, true);
    const fresh = await bindReceiptMapping(store, scope, {
      nativeId: 'bm-bind', colpId: 'colp-bind', rootNativeId: 'root-selected', revision: 'r3',
      nodeKind: 'bookmark', parentNativeId: 'folder-parent',
      content: { title: 'Bind', url: 'https://example.test/bind' },
    });
    assert.equal(fresh, true);
    assert.equal((await store.getMappingByNativeId(scope, 'bm-bind'))?.colpId, 'colp-bind');
  });

  test('does not visit into a locally excluded folder', async () => {
    const { store } = await fixture(indexedDB);
    await store.putLocalSyncExclusion(scope, {
      nativeId: 'excluded-folder', decisionId: 'rx:op-range', rootNativeId: 'root-selected',
      generation: 1, sourceKind: 'range_exit', priorColpId: 'colp-excluded',
    });
    const created: string[] = []; const moved: unknown[] = []; const changed: unknown[] = [];
    await reconcileBookmarkTree(host(store, {
      created: async (nativeId) => { created.push(nativeId); },
      moved: async (_nativeId, move) => { moved.push(move); },
      changed: async (_nativeId, changes) => { changed.push(changes); },
      readChildren: async (parent) => {
        if (parent === 'root-selected') return [folder('excluded-folder', 'root-selected', 0, 'Excluded')];
        if (parent === 'excluded-folder') return [folder('child-folder', 'excluded-folder', 0, 'Child')];
        if (parent === 'child-folder') {
          return [bookmark('grandchild', 'child-folder', 0, 'Grand', 'https://example.test/grand')];
        }
        return [];
      },
    }));
    assert.deepEqual(created, []);
    assert.deepEqual(moved, []);
    assert.deepEqual(changed, []);
  });

  test('does not delete a mapped grandchild retained under an excluded folder', async () => {
    const { store } = await fixture(indexedDB);
    await store.putLocalSyncExclusion(scope, {
      nativeId: 'excluded-folder', decisionId: 'rx:op-range', rootNativeId: 'root-selected',
      generation: 1, sourceKind: 'range_exit', priorColpId: 'colp-excluded',
    });
    await mapping(store, 'grandchild', 'colp-grand', 'root-selected', 'r-g',
      { title: 'Grand', url: 'https://example.test/grand' }, 'root-selected');
    const created: string[] = []; const deletes: string[] = [];
    const moved: unknown[] = []; const changed: unknown[] = [];
    await reconcileBookmarkTree(host(store, {
      created: async (nativeId) => { created.push(nativeId); },
      stageDelete: async (nativeId) => { deletes.push(nativeId); },
      moved: async (_nativeId, move) => { moved.push(move); },
      changed: async (_nativeId, changes) => { changed.push(changes); },
      readChildren: async (parent) => {
        if (parent === 'root-selected') {
          return [folder('folder-parent', 'root-selected', 0, 'Parent'),
            folder('excluded-folder', 'root-selected', 1, 'Excluded')];
        }
        if (parent === 'excluded-folder') return [folder('child-folder', 'excluded-folder', 0, 'Child')];
        if (parent === 'child-folder') {
          return [bookmark('grandchild', 'child-folder', 0, 'Grand', 'https://example.test/grand')];
        }
        return [];
      },
    }));
    assert.deepEqual(created, []);
    assert.equal(deletes.includes('grandchild'), false);
    assert.deepEqual(moved, []);
    assert.deepEqual(changed, []);
  });

  test('does not delete a live mapping whose native is locally excluded', async () => {
    const { store } = await fixture(indexedDB);
    await mapping(store, 'excluded-native', 'colp-excluded-native', 'root-selected', 'r-x',
      { title: 'Excluded' }, 'root-selected');
    await store.putLocalSyncExclusion(scope, {
      nativeId: 'excluded-native', decisionId: 'rx:direct', rootNativeId: 'root-selected',
      generation: 1, sourceKind: 'range_exit', priorColpId: 'colp-excluded-native',
    });
    const deletes: string[] = [];
    await reconcileBookmarkTree(host(store, {
      stageDelete: async (nativeId) => { deletes.push(nativeId); },
      readChildren: async (parent) => parent === 'root-selected'
        ? [folder('folder-parent', 'root-selected', 0, 'Parent')] : [],
    }));
    assert.equal(deletes.includes('excluded-native'), false);
  });

  test('does not delete a mapping whose mapping parent is locally excluded', async () => {
    const { store } = await fixture(indexedDB);
    await mapping(store, 'excluded-folder', 'colp-excluded', 'root-selected', 'r-f', { title: 'Excluded' },
      'root-selected');
    await mapping(store, 'stale-child', 'colp-stale', 'root-selected', 'r-c', { title: 'Stale' }, 'excluded-folder');
    await store.putLocalSyncExclusion(scope, {
      nativeId: 'excluded-folder', decisionId: 'rx:op-range', rootNativeId: 'root-selected',
      generation: 1, sourceKind: 'range_exit', priorColpId: 'colp-excluded',
    });
    const created: string[] = []; const deletes: string[] = [];
    await reconcileBookmarkTree(host(store, {
      created: async (nativeId) => { created.push(nativeId); },
      stageDelete: async (nativeId) => { deletes.push(nativeId); },
      readChildren: async (parent) => {
        if (parent === 'root-selected') {
          return [folder('folder-parent', 'root-selected', 0, 'Parent'),
            folder('excluded-folder', 'root-selected', 1, 'Excluded')];
        }
        return [];
      },
    }));
    assert.deepEqual(created, []);
    assert.equal(deletes.includes('stale-child'), false);
  });

  test('mapped rename and move are forwarded', async () => {
    const { store } = await fixture(indexedDB, { mappedNode: true });
    await mapping(store, 'mapped', 'mapped-colp', 'root-selected', 'server-revision-7',
      { title: 'Server before', url: 'https://example.test/before' }, 'root-selected');
    const moved: unknown[] = []; const changed: unknown[] = [];
    await reconcileBookmarkTree(host(store, {
      readChildren: async (parent) => {
        if (parent === 'root-selected') return [folder('folder-parent', 'root-selected', 0, 'Parent')];
        if (parent === 'folder-parent') {
          return [bookmark('mapped', 'folder-parent', 0, 'Server after', 'https://example.test/after')];
        }
        return [];
      },
      moved: async (_nativeId, move) => { moved.push(move); },
      changed: async (_nativeId, changes) => { changed.push(changes); },
    }));
    assert.equal(moved.length, 1);
    assert.deepEqual(changed, [{ title: 'Server after', url: 'https://example.test/after' }]);
  });
});

function host(store: Awaited<ReturnType<typeof fixture>>['store'], overrides: Partial<ReconcileHost> = {}):
  ReconcileHost {
  return {
    store, scope,
    identityFor: overrides.identityFor ?? (async (nativeId: string): Promise<NodeIdentity | null> => {
      const row = await store.getMappingByNativeId(scope, nativeId);
      return row ? identityFromMapping(row) : null;
    }),
    created: overrides.created ?? (async () => undefined),
    changed: overrides.changed ?? (async () => undefined),
    moved: overrides.moved ?? (async () => undefined),
    stageDelete: overrides.stageDelete ?? (async () => undefined),
    readChildren: overrides.readChildren ?? (async () => [] as BookmarkEventNode[]),
    readNode: overrides.readNode ?? (async () => { throw new Error("Can't find bookmark for id."); }),
    listPendingEvents: overrides.listPendingEvents ?? (async () => []),
  };
}

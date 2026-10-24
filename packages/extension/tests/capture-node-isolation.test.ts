import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, test } from 'vitest';
import { reconcileBookmarkTree, type ReconcileHost } from '../src/bookmark-event-reconcile.js';
import { captureMissingNativeRemovals } from '../src/bookmark-removal-reconcile.js';
import { identityFromMapping, type NodeIdentity } from '../src/bookmark-node-identity.js';
import type { BookmarkEventNode } from '../src/bookmark-event-queue.js';
import { createNodeIsolation, ISOLATED_ISSUES_PER_PASS } from '../src/capture-node-isolation.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { bookmark, fixture, mapping, scope } from './bookmark-event-queue-harness.js';

/**
 * A-F11: the lost-event safety nets walk every bookmark in one pass. One bookmark that throws
 * used to end the pass, so a single poison node switched the net off for the whole library.
 */
let indexedDB: IDBFactory;
beforeEach(() => { indexedDB = new IDBFactory(); });

function host(store: Awaited<ReturnType<typeof fixture>>['store'], overrides: Partial<ReconcileHost> = {}): ReconcileHost {
  return { store, scope,
    identityFor: overrides.identityFor ?? (async (nativeId: string): Promise<NodeIdentity | null> => {
      const row = await store.getMappingByNativeId(scope, nativeId);
      return row ? identityFromMapping(row) : null;
    }),
    created: overrides.created ?? (async () => undefined), changed: overrides.changed ?? (async () => undefined),
    moved: overrides.moved ?? (async () => undefined), stageDelete: overrides.stageDelete ?? (async () => undefined),
    readChildren: overrides.readChildren ?? (async () => [] as BookmarkEventNode[]),
    readNode: overrides.readNode ?? (async () => { throw new Error("Can't find bookmark for id."); }),
    listPendingEvents: overrides.listPendingEvents ?? (async () => []) };
}
const three = ['bm-a', 'bm-b', 'bm-c'].map((id, index) => bookmark(id, 'root-selected', index, id, `https://example.test/${id}`));

describe('A-F11 tree reconcile isolates a bookmark that throws', () => {
  test('the others are still created and the failing one is reported as a local issue', async () => {
    const { store } = await fixture(indexedDB); const created: string[] = [];
    try {
      await reconcileBookmarkTree(host(store, {
        readChildren: async (parent) => parent === 'root-selected' ? three : [],
        created: async (nativeId) => { if (nativeId === 'bm-b') throw new TypeError('x is undefined'); created.push(nativeId); },
      }));
      assert.deepEqual(created, ['bm-a', 'bm-c']);
      const open = await readOpenSyncIssues(store, scope);
      assert.deepEqual(open.local.map((row) => [row.nativeId, row.code]), [['bm-b', 'type_error']]);
    } finally { store.close(); }
  });

  test('a node that works nowhere is not "one bookmark": the failure ends the pass as before', async () => {
    const { store } = await fixture(indexedDB);
    try {
      await assert.rejects(reconcileBookmarkTree(host(store, {
        readChildren: async (parent) => parent === 'root-selected' ? three.slice(0, 1) : [],
        created: async () => { throw new TypeError('x is undefined'); },
        // The fixture's mapped folder is also unseen; its deletion fails the same way.
        stageDelete: async () => { throw new TypeError('x is undefined'); },
      })), /x is undefined/);
    } finally { store.close(); }
  });

  test('a pause or a replica-wide fault still ends the pass at once', async () => {
    const { store } = await fixture(indexedDB); const created: string[] = [];
    try {
      for (const code of ['permission_required', 'queue_state_invalid']) {
        await assert.rejects(reconcileBookmarkTree(host(store, {
          readChildren: async (parent) => parent === 'root-selected' ? three : [],
          created: async (nativeId) => { if (nativeId === 'bm-a') { created.push(nativeId); return; } throw new Error(code); },
        })), new RegExp(code));
      }
      assert.deepEqual(created, ['bm-a', 'bm-a'], 'nothing after the failing node ran');
    } finally { store.close(); }
  });

  test('a folder that cannot be read does not hide its siblings', async () => {
    const { store } = await fixture(indexedDB); const created: string[] = [];
    try {
      await reconcileBookmarkTree(host(store, {
        readChildren: async (parent) => {
          if (parent === 'root-selected') return [{ id: 'folder-bad', parentId: 'root-selected', index: 0, title: 'Bad', type: 'folder' as const },
            bookmark('bm-ok', 'root-selected', 1, 'ok', 'https://example.test/ok')];
          if (parent === 'folder-bad') throw new TypeError('folder vanished');
          return [];
        },
        created: async (nativeId) => { created.push(nativeId); },
      }));
      assert.deepEqual(created.sort(), ['bm-ok', 'folder-bad']);
    } finally { store.close(); }
  });
});

describe('A-F11 the missing-removal scan isolates a bookmark that throws', () => {
  test('the other absent bookmarks are still captured as removals', async () => {
    const { store, api } = await fixture(indexedDB); const removed: string[] = [];
    try {
      for (const id of ['gone-a', 'gone-b', 'gone-c']) await mapping(store, id, `${id}-colp`, 'root-selected', 'r1', { title: id }, 'root-selected');
      await captureMissingNativeRemovals({ store, scope, api,
        removed: async (nativeId) => { if (nativeId === 'gone-b') throw new RangeError('Invalid array length'); removed.push(nativeId); } });
      assert.deepEqual(removed.sort(), ['gone-a', 'gone-c']);
      const open = await readOpenSyncIssues(store, scope);
      assert.deepEqual(open.local.map((row) => [row.nativeId, row.code]), [['gone-b', 'range_error']]);
    } finally { store.close(); }
  });
});

describe('createNodeIsolation', () => {
  const recorder = () => {
    const issues: Array<{ code: string; nativeId: string }> = []; const diagnostics: unknown[] = [];
    return { issues, diagnostics, store: {
      recordLocalIssue: async (_scope: unknown, issue: { code: string; nativeId: string }) => { issues.push(issue); },
      putScopeDiagnostic: async (_scope: unknown, row: unknown) => { diagnostics.push(row); } } as never };
  };

  test('records at most a few issues per pass and counts the rest in a diagnostic', async () => {
    const r = recorder(); const isolation = createNodeIsolation({ store: r.store, scope, now: () => 1 });
    await isolation.run('ok', async () => undefined);
    for (let index = 0; index < ISOLATED_ISSUES_PER_PASS + 4; index += 1) {
      await isolation.run(`bad-${index}`, async () => { throw new Error('unexpected_thing'); });
    }
    await isolation.finish();
    assert.equal(r.issues.length, ISOLATED_ISSUES_PER_PASS);
    assert.deepEqual(r.diagnostics, [{ kind: 'capture_net_node_failures', code: 'unexpected_thing',
      details: { failed: ISOLATED_ISSUES_PER_PASS + 4, attempted: ISOLATED_ISSUES_PER_PASS + 5 } }]);
  });

  test('registered item codes are isolated; transient, authority and replica codes are not', async () => {
    const r = recorder(); const isolation = createNodeIsolation({ store: r.store, scope });
    await isolation.run('a', async () => { throw new Error('mapping_missing_parent'); });
    for (const code of ['network_unavailable', 'stale_replica', 'queue_state_invalid']) {
      await assert.rejects(isolation.run('b', async () => { throw new Error(code); }), new RegExp(code));
    }
    // The browser refusing the extension's access is not one bookmark's problem.
    await assert.rejects(isolation.run('c', async () => { throw new Error('permission denied'); }), /permission denied/);
  });
});

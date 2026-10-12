/**
 * F002 + F117 regression: the delete operation shape is decided by the removed
 * node's own kind, never by how many descendants this replica happens to know.
 *
 * The protocol authority (`translateSyncBrowserDelete`) maps `folder` to
 * `delete_subtree` unconditionally, because a browser is not required to emit a
 * child event per descendant. The server permanently refuses (`invalid_document`,
 * 422) a single delete of a folder that still has remote children — and ingress
 * has already dropped the local mapping at that point, so the refusal froze the
 * scope in `recovery_required` with the local delete lost.
 *
 * Every case below is driven from the production entry `queue.removed(...)` →
 * `queue.flush()`, and the queued type is compared against the protocol
 * function for the same node kind.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, test } from 'vitest';
import { translateSyncBrowserDelete } from '@know-n/colp/sync';
import { bookmark, fixture, folder, installKns04IndexedDb, scope } from './kns-04-push-harness.js';
import type { BookmarkEventNode } from '../src/bookmark-event-queue.js';
import type { createSyncStateStore } from '../src/sync-state-store.js';

installKns04IndexedDb();

type Store = ReturnType<typeof createSyncStateStore>;
type NodeKind = 'folder' | 'bookmark' | 'separator';

function separator(id: string, parentId: string, index: number): BookmarkEventNode {
  return { id, parentId, index, title: '', type: 'separator' };
}

/** Writes the durable mapping identity under test, with an explicit (or absent) nodeKind. */
async function mapNode(store: Store, input: {
  readonly nativeId: string; readonly colpId: string; readonly revision: string;
  readonly nodeKind?: NodeKind; readonly content?: Record<string, string>; readonly parentNativeId?: string;
}) {
  await store.putMapping(scope, {
    nativeId: input.nativeId, colpId: input.colpId, rootNativeId: 'root-selected',
    ...(input.nodeKind ? { nodeKind: input.nodeKind } : {}),
    ...(input.parentNativeId ? { parentNativeId: input.parentNativeId } : {}),
    projection: { revision: input.revision, childrenRevision: `children-${input.revision}`,
      digest: `sha256:${input.revision}`, ...(input.content ? { content: input.content } : {}) },
  });
}

/** The authoritative protocol translation for the same native delete event. */
function protocolType(nodeId: string, nodeKind: NodeKind): string {
  return translateSyncBrowserDelete({ nodeId, nodeKind }).type;
}

describe('F002 delete shape follows the removed node kind, not local child count', () => {
  test('an empty folder with no local child mapping still emits delete_subtree', async () => {
    const { queue, store, api } = await fixture();
    await mapNode(store, { nativeId: 'folder-empty', colpId: 'colp-folder-empty', nodeKind: 'folder',
      revision: 'r-empty', content: { title: 'Empty' }, parentNativeId: 'root-selected' });
    api.put(folder('folder-empty', 'root-selected', 1, 'Empty'));
    // Chrome emits the folder event only: no child removal callback exists, and
    // this replica holds no child mapping for the folder.
    const result = await queue.removed('folder-empty', { parentId: 'root-selected', index: 1,
      node: api.node('folder-empty') });
    assert.equal(result.outcome, 'staged');
    await queue.flush();
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.payload.type), ['delete_subtree']);
    assert.equal(rows[0]!.payload.targetId, 'colp-folder-empty');
    assert.equal(rows[0]!.payload.type, protocolType('folder-empty', 'folder'));
    assert.equal(await store.getMappingByNativeId(scope, 'folder-empty'), null);
  });

  test('a bookmark emits delete_node and its local mapping is still reclaimed', async () => {
    const { queue, store, api } = await fixture();
    await mapNode(store, { nativeId: 'bm-live', colpId: 'colp-bm-live', nodeKind: 'bookmark',
      revision: 'r-bm', content: { title: 'Live', url: 'https://example.test/live' },
      parentNativeId: 'root-selected' });
    api.put(bookmark('bm-live', 'root-selected', 1, 'Live', 'https://example.test/live'));
    const result = await queue.removed('bm-live', { parentId: 'root-selected', index: 1,
      node: api.node('bm-live') });
    assert.equal(result.outcome, 'staged');
    await queue.flush();
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.payload.type), ['delete_node']);
    assert.equal(rows[0]!.payload.targetId, 'colp-bm-live');
    assert.equal(rows[0]!.payload.type, protocolType('bm-live', 'bookmark'));
    assert.equal(await store.getMappingByNativeId(scope, 'bm-live'), null);
  });

  test('a separator emits delete_node, matching the protocol for a non-folder', async () => {
    const { queue, store, api } = await fixture();
    await mapNode(store, { nativeId: 'sep-live', colpId: 'colp-sep-live', nodeKind: 'separator',
      revision: 'r-sep', content: {}, parentNativeId: 'root-selected' });
    api.put(separator('sep-live', 'root-selected', 1));
    const result = await queue.removed('sep-live', { parentId: 'root-selected', index: 1, node: api.node('sep-live') });
    assert.equal(result.outcome, 'staged');
    await queue.flush();
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.payload.type), ['delete_node']);
    assert.equal(rows[0]!.payload.type, protocolType('sep-live', 'separator'));
  });

  test('a folder with child mappings emits delete_subtree and still cleans the mapped subtree', async () => {
    const { queue, store, api } = await fixture({ mappedSubtree: true }, new IDBFactory());
    api.put(folder('folder-parent', 'root-selected', 0, 'Parent', [
      bookmark('mapped', 'folder-parent', 0, 'Child', 'https://example.test/child'),
      separator('mapped-separator', 'folder-parent', 1),
    ]));
    const result = await queue.removed('folder-parent', { parentId: 'root-selected', index: 0,
      node: api.node('folder-parent') });
    assert.equal(result.outcome, 'staged');
    await queue.flush();
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.payload.type), ['delete_subtree']);
    assert.equal(rows[0]!.payload.type, protocolType('folder-parent', 'folder'));
    // deleteNativeIds keeps its other job: local mapping cleanup.
    assert.equal(await store.getMappingByNativeId(scope, 'folder-parent'), null);
    assert.equal(await store.getMappingByNativeId(scope, 'mapped'), null);
    assert.equal(await store.getMappingByNativeId(scope, 'mapped-separator'), null);
  });

  test('a folder whose kind is proven only by the durable mapping emits delete_subtree', async () => {
    const { queue, store } = await fixture();
    await mapNode(store, { nativeId: 'folder-mapped', colpId: 'colp-folder-mapped', nodeKind: 'folder',
      revision: 'r-mapped', content: { title: 'Mapped folder' }, parentNativeId: 'root-selected' });
    const result = await queue.removed('folder-mapped', { parentId: 'root-selected', index: 1 });
    assert.equal(result.outcome, 'staged');
    await queue.flush();
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.payload.type), ['delete_subtree']);
    assert.equal(rows[0]!.payload.type, protocolType('folder-mapped', 'folder'));
  });

  test('an unproven node kind fails safe to delete_subtree, while a proven bookmark still emits delete_node',
    async () => {
      // Neither the removal callback node nor the mapping proves the kind: the
      // protocol cannot distinguish it, and the server permanently refuses
      // delete_node for a folder that still has remote children, so the
      // replica must take the subtree direction.
      const unproven = await fixture();
      await mapNode(unproven.store, { nativeId: 'node-unproven', colpId: 'colp-unproven',
        revision: 'r-unproven', content: { title: 'No kind evidence' }, parentNativeId: 'root-selected' });
      const unprovenResult = await unproven.queue.removed('node-unproven', { parentId: 'root-selected', index: 1 });
      assert.equal(unprovenResult.outcome, 'staged');
      await unproven.queue.flush();
      const unprovenRows = await unproven.store.listQueue(scope);
      assert.deepEqual(unprovenRows.map((row) => row.payload.type), ['delete_subtree']);
      assert.notEqual(unprovenRows[0]!.payload.type, 'delete_node');

      // Same absence of a callback node, but the mapping proves a bookmark:
      // the safe direction is not "always subtree".
      const proven = await fixture({}, new IDBFactory());
      await mapNode(proven.store, { nativeId: 'bm-mapped', colpId: 'colp-bm-mapped', nodeKind: 'bookmark',
        revision: 'r-bm-mapped', content: { title: 'Mapped', url: 'https://example.test/mapped' },
        parentNativeId: 'root-selected' });
      const provenResult = await proven.queue.removed('bm-mapped', { parentId: 'root-selected', index: 1 });
      assert.equal(provenResult.outcome, 'staged');
      await proven.queue.flush();
      const provenRows = await proven.store.listQueue(scope);
      assert.deepEqual(provenRows.map((row) => row.payload.type), ['delete_node']);
      assert.equal(provenRows[0]!.payload.type, protocolType('bm-mapped', 'bookmark'));
    });

  test('a projected url proves a bookmark even when nodeKind was never stored', async () => {
    // Durable projection content carries a url for bookmarks only; folders are
    // projected as { title }. This keeps the conservative rule from turning a
    // mapped bookmark delete into a server-rejected delete_subtree.
    const { queue, store } = await fixture();
    await mapNode(store, { nativeId: 'bm-url-only', colpId: 'colp-bm-url-only', revision: 'r-url-only',
      content: { title: 'Url only', url: 'https://example.test/url-only' }, parentNativeId: 'root-selected' });
    const result = await queue.removed('bm-url-only', { parentId: 'root-selected', index: 1 });
    assert.equal(result.outcome, 'staged');
    await queue.flush();
    const rows = await store.listQueue(scope);
    assert.deepEqual(rows.map((row) => row.payload.type), ['delete_node']);
    assert.equal(rows[0]!.payload.type, protocolType('bm-url-only', 'bookmark'));
  });

  test('the plugin never produces a protocol-forbidden delete_node for a folder', async () => {
    const cases = [
      { nodeId: 'folder-empty', node: folder('folder-empty', 'root-selected', 1, 'Empty'), kind: 'folder' as const },
      { nodeId: 'folder-nested', node: folder('folder-nested', 'root-selected', 2, 'Nested',
        [bookmark('inner', 'folder-nested', 0, 'Inner', 'https://example.test/inner')]), kind: 'folder' as const },
    ];
    for (const entry of cases) {
      const { queue, store, api } = await fixture({}, new IDBFactory());
      await mapNode(store, { nativeId: entry.nodeId, colpId: `colp-${entry.nodeId}`, nodeKind: 'folder',
        revision: `r-${entry.nodeId}`, content: { title: 'Folder' }, parentNativeId: 'root-selected' });
      api.put(entry.node);
      await queue.removed(entry.nodeId, { parentId: 'root-selected', index: entry.node.index ?? 0,
        node: api.node(entry.nodeId) });
      await queue.flush();
      const rows = await store.listQueue(scope);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.payload.type, 'delete_subtree');
      assert.equal(rows[0]!.payload.type, protocolType(entry.nodeId, entry.kind));
    }
  });
});

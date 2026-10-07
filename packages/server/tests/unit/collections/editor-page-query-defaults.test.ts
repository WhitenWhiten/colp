/**
 * P1-06 editor page query — first-page defaults, live icon JOIN, and stable sort.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  EDITOR_PAGE_DEFAULT_LIMIT,
  EDITOR_PAGE_MAX_BYTES,
  EDITOR_PAGE_MAX_LIMIT,
  PRODUCT_EDITOR_COMPARATOR_VERSION,
  PRODUCT_EDITOR_CURSOR_PURPOSE,
  PRODUCT_EDITOR_CURSOR_TTL_MS,
  PRODUCT_EDITOR_CURSOR_VERSION,
  formatUtcDateTime,
} from '../../../src/modules/collections/index.js';
import {
  COLLECTION_ID,
  CONTENT_REV,
  EDITOR_ICON_OBJECT_ID,
  EDITOR_PRODUCT_ORIGIN,
  NOW,
  POLICY_REV,
  ROOT_ID,
  addBookmark,
  addFolder,
  createState,
  ownerInput,
  query,
  seedOwnedCollection,
  sortedNodes,
} from './editor-page-query-helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: contract constants', () => {
  test('default limit 200, max 500, 4 MiB budget, 15 min TTL, product-editor-cursor purpose', () => {
    assert.equal(EDITOR_PAGE_DEFAULT_LIMIT, 200);
    assert.equal(EDITOR_PAGE_MAX_LIMIT, 500);
    assert.equal(EDITOR_PAGE_MAX_BYTES, 4 * 1024 * 1024);
    assert.equal(PRODUCT_EDITOR_CURSOR_TTL_MS, 15 * 60 * 1000);
    assert.equal(PRODUCT_EDITOR_CURSOR_PURPOSE, 'product-editor-cursor');
    assert.equal(PRODUCT_EDITOR_COMPARATOR_VERSION, 'v1');
    assert.equal(PRODUCT_EDITOR_CURSOR_VERSION, 1);
  });
});

// ---------------------------------------------------------------------------
// First page / empty tree
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: first page defaults', () => {
  test('empty tree returns root+collection, nodes=[], hasMore false', async () => {
    const state = createState();
    seedOwnedCollection(state);

    const page = await query(state, ownerInput());

    assert.equal(page.collection.id, COLLECTION_ID);
    assert.equal(page.collection.rootNodeId, ROOT_ID);
    assert.equal(page.collection.contentRevision, CONTENT_REV);
    assert.equal(page.collection.policyRevision, POLICY_REV);
    assert.equal(page.root.id, ROOT_ID);
    assert.equal(page.root.folderRole, 'root');
    assert.equal(page.root.parentId, null);
    assert.equal(page.root.position, null);
    assert.deepEqual(page.nodes, []);
    assert.equal(page.page.returnedCount, 0);
    assert.equal(page.page.hasMore, false);
    assert.equal(page.page.nextCursor, null);
    assert.equal(page.page.contentRevision, CONTENT_REV);
    assert.equal(page.page.policyRevision, POLICY_REV);
    assert.equal(page.page.comparatorVersion, PRODUCT_EDITOR_COMPARATOR_VERSION);
    assert.ok(page.page.snapshotId.length > 0);
    assert.equal(
      page.page.expiresAt,
      formatUtcDateTime(new Date(NOW.getTime() + PRODUCT_EDITOR_CURSOR_TTL_MS)),
    );
    assert.equal(page.capabilities.updateCollection, true);
    assert.equal(page.capabilities.managePublication, true);
    assert.equal(page.capabilities.createNode, true);
    assert.equal(page.capabilities.updateNode, true);
    assert.equal(page.capabilities.moveNode, true);
    assert.equal(page.capabilities.deleteNode, true);
  });

  test('omitted limit uses default 200 and returns at most 200 nodes with hasMore', async () => {
    const state = createState();
    seedOwnedCollection(state);
    for (let i = 0; i < 250; i += 1) {
      const pos = String(i).padStart(5, '0');
      addBookmark(state, {
        id: `bm-${pos}`,
        parentId: ROOT_ID,
        positionToken: pos,
        title: `Bookmark ${pos}`,
      });
    }

    const page = await query(state, ownerInput());
    assert.equal(page.nodes.length, EDITOR_PAGE_DEFAULT_LIMIT);
    assert.equal(page.page.returnedCount, EDITOR_PAGE_DEFAULT_LIMIT);
    assert.equal(page.page.hasMore, true);
    assert.ok(typeof page.page.nextCursor === 'string' && page.page.nextCursor.length > 0);
  });
});

describe('getCollectionEditorPage: live bookmark icon JOIN', () => {
  test('bookmark without a row still sends iconUrl JSON null; folder/root omit iconUrl', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addFolder(state, { id: 'folder-1', parentId: ROOT_ID, positionToken: 'a', title: 'Folder' });
    addBookmark(state, { id: 'bm-1', parentId: ROOT_ID, positionToken: 'b', title: 'Bookmark' });

    const page = await query(state, ownerInput());
    const bookmark = page.nodes.find((item) => item.kind === 'bookmark');
    const folder = page.nodes.find((item) => item.kind === 'folder');
    assert.ok(bookmark);
    assert.ok(folder);
    assert.equal(Object.hasOwn(bookmark, 'iconUrl'), true);
    assert.equal(bookmark.kind === 'bookmark' ? bookmark.iconUrl : 'missing', null);
    assert.equal(Object.hasOwn(folder, 'iconUrl'), false);
    assert.equal(Object.hasOwn(page.root, 'iconUrl'), false);
    assert.doesNotMatch(JSON.stringify(page), /favicon\.im|duckduckgo/i);
  });

  test('live JOIN projects a same-origin iconUrl for a bookmark with a row', async () => {
    const state = createState();
    seedOwnedCollection(state);
    addFolder(state, { id: 'folder-1', parentId: ROOT_ID, positionToken: 'a', title: 'Folder' });
    addBookmark(state, { id: 'bm-1', parentId: ROOT_ID, positionToken: 'b', title: 'Bookmark' });
    state.iconObjectIds.set('bm-1', EDITOR_ICON_OBJECT_ID);

    const page = await query(state, ownerInput());
    const bookmark = page.nodes.find((item) => item.id === 'bm-1');
    const folder = page.nodes.find((item) => item.id === 'folder-1');
    assert.ok(bookmark && bookmark.kind === 'bookmark');
    assert.equal(bookmark.iconUrl, `${EDITOR_PRODUCT_ORIGIN}/api/v1/favicon/${EDITOR_ICON_OBJECT_ID}`);
    assert.equal(Object.hasOwn(folder ?? {}, 'iconUrl'), false);
    assert.doesNotMatch(bookmark.iconUrl ?? '', /favicon\.im|duckduckgo/i);
  });

  test('eight bookmarks issue one icon batch lookup, not N queries', async () => {
    const state = createState();
    seedOwnedCollection(state);
    for (let index = 0; index < 8; index += 1) {
      const id = `bm-${index}`;
      addBookmark(state, { id, parentId: ROOT_ID, positionToken: String(index).padStart(2, '0') });
      state.iconObjectIds.set(id, EDITOR_ICON_OBJECT_ID);
    }
    const page = await query(state, ownerInput());
    assert.equal(page.nodes.filter((item) => item.kind === 'bookmark').length, 8);
    assert.equal(state.iconLookupCalls, 1);
    assert.ok(page.nodes.every((item) => (
      item.kind !== 'bookmark'
      || item.iconUrl === `${EDITOR_PRODUCT_ORIGIN}/api/v1/favicon/${EDITOR_ICON_OBJECT_ID}`
    )));
  });
});

// ---------------------------------------------------------------------------
// Stable sort
// ---------------------------------------------------------------------------

describe('getCollectionEditorPage: stable sort by parent/position/id', () => {
  test('nodes ordered by (parentId, positionToken, nodeId); root never in nodes', async () => {
    const state = createState();
    seedOwnedCollection(state);

    addFolder(state, { id: 'folder-b', parentId: ROOT_ID, positionToken: 'm', title: 'B' });
    addFolder(state, { id: 'folder-a', parentId: ROOT_ID, positionToken: 'a', title: 'A' });
    addBookmark(state, {
      id: 'bm-z',
      parentId: 'folder-a',
      positionToken: 'p1',
      title: 'Z',
    });
    addBookmark(state, {
      id: 'bm-a',
      parentId: 'folder-a',
      positionToken: 'p1',
      title: 'A-same-pos',
    });
    addBookmark(state, {
      id: 'bm-root-2',
      parentId: ROOT_ID,
      positionToken: 'z',
      title: 'Root child late',
    });

    const page = await query(state, ownerInput({ limit: 50 }));
    const ids = page.nodes.map((n) => n.id);
    assert.ok(!ids.includes(ROOT_ID), 'root must not appear in nodes');

    const expected = sortedNodes(state, COLLECTION_ID).map((n) => n.id);
    assert.deepEqual(ids, expected);
    // parent folder-a < root-editor-0001 → folder-a children first
    assert.deepEqual(ids, ['bm-a', 'bm-z', 'folder-a', 'folder-b', 'bm-root-2']);
  });
});

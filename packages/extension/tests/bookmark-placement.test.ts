import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { mapBookmarksAtPosition } from '../src/bookmark-placement.js';
import { savePagesThroughNativeIngress } from '../src/save-entry.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { createBookmarkCreatePlacementStore } from '../src/bookmark-create-placement.js';

describe('native bookmark placement', () => {
  test('with folders first, a top batch starts after the folders and pinned bookmarks', async () => {
    const children = [{ id: 'folder-a' }, { id: 'pinned', url: 'https://example.test/p' }, { id: 'other', url: 'https://example.test/o' }];
    const calls: number[] = [];
    await mapBookmarksAtPosition({
      items: ['n1', 'n2'], parentId: 'folder', position: 'top', afterPinned: new Set(['pinned']),
      api: { async getChildren() { return children; } },
      async create(_item, index) { calls.push(index); return index; },
    });
    assert.deepEqual(calls, [2, 3]);
  });

  test('top and bottom batches preserve input order with one native children read', async () => {
    for (const [position, expected] of [
      ['top', ['n1', 'n2', 'folder-a', 'bookmark-x', 'folder-b', 'bookmark-y']],
      ['bottom', ['folder-a', 'bookmark-x', 'folder-b', 'bookmark-y', 'n1', 'n2']],
    ] as const) {
      const children = ['folder-a', 'bookmark-x', 'folder-b', 'bookmark-y'];
      let reads = 0;
      const calls: Array<readonly [string, number]> = [];
      const results = await mapBookmarksAtPosition({
        items: ['n1', 'n2'], parentId: 'folder', position,
        api: { async getChildren() { reads += 1; return children.map((id) => ({ id })); } },
        async create(item, index) {
          calls.push([item, index]);
          children.splice(index, 0, item);
          return `${item}-saved`;
        },
      });
      assert.equal(reads, 1);
      assert.deepEqual(calls.map(([, index]) => index), position === 'top' ? [0, 1] : [4, 5]);
      assert.deepEqual(children, expected);
      assert.deepEqual(results, ['n1-saved', 'n2-saved']);
    }
  });

  test('a failed create does not consume an insertion index', async () => {
    const calls: Array<readonly [string, number]> = [];
    await assert.rejects(mapBookmarksAtPosition({
      items: ['n1', 'n2', 'n3'], parentId: 'folder', position: 'top',
      api: { async getChildren() { return [{ id: 'old' }]; } },
      async create(item, index) {
        calls.push([item, index]);
        if (item === 'n2') throw new Error('create_failed');
        return item;
      },
    }), /create_failed/u);
    assert.deepEqual(calls, [['n1', 0], ['n2', 1]]);
  });

  test('a confirmed prefix resumes after its current native position', async () => {
    let reads = 0;
    const indexes: number[] = [];
    await mapBookmarksAtPosition({
      items: ['n2', 'n3'], parentId: 'folder', position: 'top', resumeNativeIds: ['n1'],
      api: { async getChildren() { reads += 1; return ['concurrent', 'n1', 'old'].map(id => ({ id })); } },
      async create(_item, index) { indexes.push(index); return index; },
    });
    assert.equal(reads, 1);
    assert.deepEqual(indexes, [2, 3]);
  });

  for (const children of [['n2', 'n1'], ['n1']]) {
    test(`a moved or reordered confirmed prefix cannot resume: ${children.join(',')}`, async () => {
      let creates = 0;
      await assert.rejects(mapBookmarksAtPosition({ items: ['n3'], parentId: 'folder', position: 'top',
        resumeNativeIds: ['n1', 'n2'], api: { getChildren: async () => children.map(id => ({ id })) },
        create: async () => { creates++; } }), /bookmark_resume_placement_unproven/u);
      assert.equal(creates, 0);
    });
  }

  test('favicon capture failure cannot change the indexes already used by native create', async () => {
    const creates: Array<{ readonly title?: string; readonly index?: number }> = [];
    const placementStorage = new MemoryStorageArea();
    const result = await savePagesThroughNativeIngress({
      pages: [
        { title: 'One', url: 'https://one.example/', favIconUrl: 'https://one.example/favicon.ico' },
        { title: 'Two', url: 'https://two.example/', favIconUrl: 'https://two.example/favicon.ico' },
      ],
      parentNativeId: 'folder', collectionId: 'collection', insertPosition: 'top',
      placementStore: createBookmarkCreatePlacementStore({ storage: placementStorage }),
      bookmarks: {
        async getChildren() { return [{ id: 'old' }]; },
        async create(input) {
          creates.push(input);
          return { id: `native-${creates.length}`, title: input.title ?? '', url: input.url };
        },
      },
      sidecar: { close() { /* test double */ }, async put() { throw new Error('sidecar_failed'); } } as never,
      fetch: async () => { throw new Error('favicon_failed'); },
    });
    assert.deepEqual(creates.map(({ title, index }) => [title, index]), [['One', 0], ['Two', 1]]);
    assert.deepEqual(result.map(({ nativeId, captured }) => ({ nativeId, captured })), [
      { nativeId: 'native-1', captured: false }, { nativeId: 'native-2', captured: false },
    ]);
    const intents = Object.values(await placementStorage.get(null)) as Array<{ state: string; nativeId?: string }>;
    assert.deepEqual(intents.map(({ state, nativeId }) => ({ state, nativeId })), [
      { state: 'bound', nativeId: 'native-1' }, { state: 'bound', nativeId: 'native-2' },
    ]);
  });

  test('created consumption is two-phase and attention remains unproven', async () => {
    const storage = new MemoryStorageArea();
    const store = createBookmarkCreatePlacementStore({ storage, now: () => 100 });
    const input = { mode: 'top' as const, targetParentNativeId: 'parent-1', collectionId: 'collection',
      batchId: '11111111-1111-4111-8111-111111111111', batchOrder: 0, batchSize: 1,
      title: 'Reserved', url: 'https://reserved.example/', expectedIndex: 0 };
    const reserved = await store.reserve(input);
    const first = await store.consumeForCreated({ id: 'native-1', parentId: 'parent-1', index: 0,
      title: input.title, url: input.url });
    assert.equal(first?.state, 'ready');
    assert.ok(await store.get(reserved.intentId));
    await store.complete(reserved.intentId);
    assert.equal(await store.get(reserved.intentId), undefined);
    const ambiguous = await store.reserve({ ...input, batchId: '22222222-2222-4222-8222-222222222222' });
    await store.markAttention(ambiguous.intentId);
    const blocked = await store.consumeForCreated({ id: 'native-2', parentId: 'parent-1', index: 0,
      title: input.title, url: input.url });
    assert.equal(blocked?.state, 'unproven');
  });

  test('an omitted destination never creates a bookmark in Other bookmarks', async () => {
    const creates: Array<{ readonly parentId?: string; readonly index?: number }> = [];
    await assert.rejects(savePagesThroughNativeIngress({
      pages: [{ title: 'Default parent', url: 'https://default.example/' }],
      insertPosition: 'top',
      bookmarks: {
        async getTree() { return [{ id: '0', children: [{ id: '1' }, { id: '2' }, { id: '3' }] }]; },
        async getChildren(parentId) { assert.equal(parentId, '2'); return [{ id: 'old' }]; },
        async create(input) { creates.push(input); return { id: 'created', title: input.title ?? '', url: input.url }; },
      },
      sidecar: { close() { /* test double */ }, async put() { /* no icon */ } } as never,
    }), /folder_required/);
    assert.deepEqual(creates, []);
  });
});

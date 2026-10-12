import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createManagerNode } from '../src/bookmark-manager-create.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX } from '../src/bookmark-create-placement.js';
import { validFaviconRequest } from '../src/sw/messages.js';

afterEach(() => vi.unstubAllGlobals());

for (const position of ['top', 'bottom'] as const) {
  test(`manager persists ${position} intent before create and binds its native identity`, async () => {
    const storage = new MemoryStorageArea();
    const messages: string[] = [];
    vi.stubGlobal('chrome', { storage: { local: storage }, runtime: {
      sendMessage: async ({ kind }: { kind: string }) => {
        messages.push(kind);
        return kind === 'known.bookmark.preferences.local'
          ? { ok: true, preferences: { bookmarkInsertPosition: position, foldersFirst: true } }
          : { ok: true, collectionId: 'current-collection' };
      },
    } });
    const records = async () => Object.entries(await storage.get(null))
      .filter(([key]) => key.startsWith(BOOKMARK_CREATE_PLACEMENT_KEY_PREFIX)).map(([, value]) => value);
    await createManagerNode({
      getChildren: async () => [{ id: 'existing-folder' }, { id: 'existing-bookmark', url: 'https://example.test/old' }],
      create: async (input) => {
        // Folders first: the top of the folder is after its subfolders (and any pinned bookmarks).
        assert.deepEqual(input, { parentId: 'parent', index: position === 'top' ? 1 : 2,
          title: 'Manager bookmark', url: 'https://example.test/new' });
        assert.equal((await records()).length, 1);
        assertPartial(await records(), {
          state: 'reserved', mode: position, collectionId: 'current-collection',
          targetParentNativeId: 'parent', expectedIndex: input.index,
        });
        return { id: 'created', title: input.title! };
      },
    }, 'parent', 'Manager bookmark', 'https://example.test/new');
    assertPartial(await records(), { state: 'bound', nativeId: 'created', mode: position });
    assert.deepEqual(messages, ['known.bookmark.preferences.local', 'known.favicon.save-context-local']);
  });
}

function assertPartial(records: unknown[], expected: Record<string, unknown>): unknown {
  assert.equal(records.length, 1);
  const record = records[0] as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) assert.equal(record[key], value);
  return record;
}

test('unconnected manager saves locally without attaching stale collection authority', async () => {
  const storage = new MemoryStorageArea();
  await storage.set({ 'known.sync.collection.v1': 'previous-account-collection' });
  vi.stubGlobal('chrome', { storage: { local: storage }, runtime: { sendMessage: async () => ({ ok: false }) } });
  const create = vi.fn(async () => ({ id: 'local', title: 'Local' }));
  await createManagerNode({ getChildren: async () => [], create }, 'parent', 'Local', 'https://example.test/local');
  assert.equal(create.mock.calls.length, 1);
  assert.deepEqual(Object.keys(await storage.get(null)), ['known.sync.collection.v1']);
});

test('folder creation appends without preferences, scope lookup, or placement reservation', async () => {
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const create = vi.fn(async () => ({ id: 'folder', title: 'Folder' }));
  await createManagerNode({ create }, 'parent', 'Folder');
  assert.deepEqual(create.mock.calls, [[{ parentId: 'parent', title: 'Folder' }]]);
  assert.equal(sendMessage.mock.calls.length, 0);
});

test('local save context accepts only a closed parameterless request', () => {
  assert.equal(validFaviconRequest({ kind: 'known.favicon.save-context-local' }), true);
  assert.equal(validFaviconRequest({ kind: 'known.favicon.save-context-local', collectionId: 'other-account' }), false);
});

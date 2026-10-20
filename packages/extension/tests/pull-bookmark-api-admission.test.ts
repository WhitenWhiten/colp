import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';
import { NativeWriteNotStartedError } from '../src/native-call-result.js';
import { subscriptionStore as db } from '../src/bookmark-subscriptions/store.js';
import { nativeFixture, row, root, owned } from './bookmark-subscriptions-fixture.js';

let native: ReturnType<typeof nativeFixture>;
beforeEach(async () => {
  await db.close(); vi.stubGlobal('indexedDB', new IDBFactory()); native = nativeFixture();
  const mapping = { ...row(), rootNativeId: 'readonly', state: 'current' as const };
  native.nodes.set('readonly', { id: 'readonly', parentId: 'bar', title: 'Read-only source' });
  await db.put('mappings', mapping); await db.put('nodes', owned(mapping, root, 'readonly'));
  vi.stubGlobal('chrome', { bookmarks: { ...native.api, removeTree: vi.fn() } });
});
afterEach(async () => { await db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Replaces source-format assertions about `return chrome.bookmarks.*`. A
// direct-to-Chrome regression must fail for each operation, regardless of syntax.
test.each(['create', 'update', 'move', 'remove', 'removeTree'] as const)
('the production Pull %s adapter refuses a real read-only subscription before its final check and native call', async kind => {
  const api = createChromePullBookmarkApi(), check = vi.fn(async () => undefined);
  const attempt = kind === 'create' ? api.create({ parentId: 'readonly', title: 'Unwanted' }, check)
    : kind === 'update' ? api.update('readonly', { title: 'Unwanted' }, check)
      : kind === 'move' ? api.move('readonly', { parentId: 'bar' }, check)
        : api[kind]('readonly', check);
  await expect(attempt).rejects.toBeInstanceOf(NativeWriteNotStartedError);
  await expect(attempt).rejects.toThrow('readonly_write_blocked');
  expect(check).not.toHaveBeenCalled(); expect(native.calls).toEqual([]);
  expect(chrome.bookmarks.removeTree).not.toHaveBeenCalled();
  expect(native.nodes.get('readonly')).toMatchObject({ parentId: 'bar', title: 'Read-only source' });
  expect(await db.all('diagnostics')).toMatchObject([{ nativeId: 'readonly', reasonCode: 'readonly_write_blocked' }]);
});

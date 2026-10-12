import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'vitest';
import { BookmarkApiError, CHROME_BOOKMARK_NOT_FOUND, classifyBookmarkApiFailure } from '../src/bookmark-api-error.js';
import { createPullApplier } from '../src/pull-applier.js';
import { createChromePullBookmarkApi } from '../src/pull-bookmark-api.js';

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');

afterEach(() => {
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome);
  else delete (globalThis as { chrome?: unknown }).chrome;
});

describe('Pull Chrome bookmark adapter', () => {
  test('forwards every native mutation and lookup to chrome.bookmarks', async () => {
    const calls: string[] = [];
    const bookmarks = {
      async create() { calls.push('create'); return { id: 'created' }; },
      async update() { calls.push('update'); return {}; },
      async move() { calls.push('move'); return {}; },
      async remove() { calls.push('remove'); },
      async removeTree() { calls.push('removeTree'); },
      async get() { calls.push('get'); return [{ id: 'node' }]; },
      async getChildren() { calls.push('getChildren'); return [{ id: 'child' }]; },
    };
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { bookmarks } });
    const api = createChromePullBookmarkApi();
    assert.deepEqual(await api.create({ title: 'Title' }), { id: 'created' });
    await api.update('node', { title: 'Updated' });
    await api.move('node', { parentId: 'parent', index: 1 });
    await api.remove('node'); await api.removeTree('folder');
    assert.deepEqual(await api.get('node'), [{ id: 'node' }]);
    assert.deepEqual(await api.getChildren('folder'), [{ id: 'child' }]);
    // The first get is move's destination check (assertBookmarkFolderAllowed reads the parent's ancestry).
    assert.deepEqual(calls, ['create', 'update', 'get', 'move', 'remove', 'removeTree', 'get', 'getChildren']);
  });

  test('missing get rejects with classified not_found and never becomes []', async () => {
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: { bookmarks: { async get() { throw new Error(CHROME_BOOKMARK_NOT_FOUND); } } },
    });
    const api = createChromePullBookmarkApi();
    await assert.rejects(() => api.get('missing'), (error: unknown) =>
      error instanceof BookmarkApiError && error.failureClass === 'not_found'
      && classifyBookmarkApiFailure(error) === 'not_found');
  });

  test('the public facade selects the Chrome adapter and remains frozen when no API is injected', () => {
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { bookmarks: {} } });
    const applier = createPullApplier({ store: {} as never, scope: {} as never,
      session: { sessionId: 'session', collectionId: 'collection' },
      effectPageTemplate: 'https://known.example/effects/{effectId}/pages/{pageNumber}',
      effectPageAuthority: 'https://known.example' });
    assert.equal(Object.isFrozen(applier), true);
    assert.deepEqual(Object.keys(applier), ['pull', 'stage', 'resume', 'observe']);
  });
});

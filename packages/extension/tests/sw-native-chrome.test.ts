import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { nativeChromeFacts } from '../src/sw/native-chrome.js';

// Keep the personal/subscription write guards in this composition test. Only
// their persistence port and Chrome are external; the wrapper must use them.
const excluded = vi.hoisted(() => new Set<string>());
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], ready: async () => {},
  count: async (table: string) => table === 'nodes' ? excluded.size : 0,
  all: async (table: string) => table === 'nodes'
    ? [...excluded].map(nativeId => ({ nativeId, mappingId: 'subscription' })) : [],
  nodeForNative: async (id: string) => excluded.has(id) ? { nativeId: id } : undefined,
  get: async () => undefined,
} }));

beforeEach(() => {
  excluded.clear();
  vi.stubGlobal('chrome', { bookmarks: {
    get: vi.fn(async (id: string) => [{ id, title: id, parentId: id === '1' ? '0' : '1',
      ...(id === '1' ? { folderType: 'bookmarks-bar' } : {}) }]),
    getChildren: vi.fn(async () => [{ id: 'child', title: 'Child', parentId: '1' }]),
    getSubTree: vi.fn(async (id: string) => [{ id, title: id, parentId: '1', children: [] }]),
    create: vi.fn(async (input: object) => ({ id: 'created', ...input })),
    move: vi.fn(async (id: string, placement: object) => ({ id, ...placement })),
    update: vi.fn(async (id: string, changes: object) => ({ id, ...changes })),
    remove: vi.fn(async () => {}), removeTree: vi.fn(async () => {}),
  } });
});
afterEach(() => vi.unstubAllGlobals());

test('native ports preserve exact create, move, update and lookup facts through the personal guards', async () => {
  const api = nativeChromeFacts();
  const input = { parentId: '1', index: 0, title: '', url: 'https://example.test/#/route' };
  expect(await api.createNative(input)).toEqual({ id: 'created', ...input });
  expect(chrome.bookmarks.create).toHaveBeenCalledExactlyOnceWith(input);
  const placement = { parentId: '1', index: 2 };
  expect(await api.moveNative('created', placement)).toEqual({ id: 'created', ...placement });
  expect(chrome.bookmarks.move).toHaveBeenCalledExactlyOnceWith('created', placement);
  const changes = { title: '', url: 'https://example.test/next/' };
  expect(await api.updateNative('created', changes)).toBeUndefined();
  expect(chrome.bookmarks.update).toHaveBeenCalledExactlyOnceWith('created', changes);
  expect(await api.getNative('created')).toEqual({ id: 'created', title: 'created', parentId: '1' });
  expect(await api.getChildren('1')).toEqual([{ id: 'child', title: 'Child', parentId: '1' }]);
  expect(chrome.bookmarks.getChildren).toHaveBeenCalledExactlyOnceWith('1');
});

test('leaf deletion and tree deletion call their respective guarded Chrome operations exactly once', async () => {
  const api = nativeChromeFacts();
  await api.removeNative('leaf', false); await api.removeNative('folder', true);
  expect(chrome.bookmarks.remove).toHaveBeenCalledExactlyOnceWith('leaf');
  expect(chrome.bookmarks.removeTree).toHaveBeenCalledExactlyOnceWith('folder');
});

const writes = [
  ['create', (api: ReturnType<typeof nativeChromeFacts>) => api.createNative({ parentId: 'shared', title: 'New' })],
  ['move', (api: ReturnType<typeof nativeChromeFacts>) => api.moveNative('shared', { parentId: '1', index: 0 })],
  ['update', (api: ReturnType<typeof nativeChromeFacts>) => api.updateNative('shared', { title: 'Changed' })],
  ['remove', (api: ReturnType<typeof nativeChromeFacts>) => api.removeNative('shared', false)],
  ['removeTree', (api: ReturnType<typeof nativeChromeFacts>) => api.removeNative('shared', true)],
] as const;
test.each(writes)('%s cannot bypass subscription ownership through the rejoin native wrapper', async (_name, write) => {
  excluded.add('shared');
  await expect(write(nativeChromeFacts())).rejects.toThrow('readonly_write_blocked');
  for (const method of ['create', 'move', 'update', 'remove', 'removeTree'] as const) {
    expect(chrome.bookmarks[method]).not.toHaveBeenCalled();
  }
});

test('unsupported browser roots and Chrome write failures remain observable', async () => {
  await expect(nativeChromeFacts().createNative({ parentId: '0', title: 'Invalid' }))
    .rejects.toThrow('bookmark_folder_unavailable');
  expect(chrome.bookmarks.create).not.toHaveBeenCalled();
  const failure = new Error('Chrome write failed');
  vi.mocked(chrome.bookmarks.move).mockRejectedValueOnce(failure);
  await expect(nativeChromeFacts().moveNative('child', { parentId: '1', index: 0 })).rejects.toBe(failure);
});

test('only verified not-found means absence; empty or unreadable Chrome responses are errors', async () => {
  const api = nativeChromeFacts();
  vi.mocked(chrome.bookmarks.get).mockRejectedValueOnce(new Error("Can't find bookmark for id."));
  expect(await api.getNative('missing')).toBeUndefined();
  vi.mocked(chrome.bookmarks.get).mockResolvedValueOnce([]);
  await expect(api.getNative('unreadable')).rejects.toThrow('bookmark_lookup_empty');
  for (const message of ['permission denied', 'managed bookmark cannot be modified', 'service temporarily unavailable']) {
    const failure = new Error(message);
    vi.mocked(chrome.bookmarks.get).mockRejectedValueOnce(failure);
    await expect(api.getNative('unreadable')).rejects.toBe(failure);
  }
});

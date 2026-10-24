import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBookmarkAnnotationStore } from '../src/bookmark-annotation-store.js';
import { listenToWorkerAnnotationChanges } from '../src/bookmark-annotation-notice.js';
import { validPinRequest } from '../src/bookmark-pin-messages.js';
import { handlePinRequest, PIN_PLACEMENT_ALARM, placeDeferredUnpins } from '../src/sw/bookmark-pins.js';

const mocks = vi.hoisted(() => ({ permission: vi.fn(), busy: vi.fn(), scope: vi.fn(), state: vi.fn(), excluded: vi.fn(),
  preferences: vi.fn(), schedule: vi.fn() }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: mocks.permission, syncState: { getEngineState: mocks.state },
  workCoordinator: { run: (_lane: string, work: () => Promise<unknown>) => work(), hasInFlight: mocks.busy } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: mocks.scope }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { settled: async () => undefined } }));
vi.mock('../src/sw/bookmark-folders-first.js', () => ({ scheduleNativeFoldersFirst: mocks.schedule }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: mocks.preferences }));
vi.mock('../src/bookmark-subscriptions/barrier.js', () => ({ withSubscriptionRead: (work: () => Promise<unknown>) => work() }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: mocks.excluded }));

type Node = chrome.bookmarks.BookmarkTreeNode;
let nodes: Map<string, Node>;
let session: Record<string, unknown>;
const ids = (id: string) => nodes.get(id)!.children!.map(node => node.id);
const pin = (nativeId: string, pinned = true) => handlePinRequest({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId, pinned });
const top = { bookmarkInsertPosition: 'top', foldersFirst: true };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('indexedDB', new IDBFactory());
  mocks.permission.mockResolvedValue(true); mocks.busy.mockReturnValue(false);
  mocks.scope.mockRejectedValue(new Error('not_connected')); mocks.excluded.mockResolvedValue(new Set());
  mocks.preferences.mockResolvedValue(top);
  nodes = new Map();
  const add = (id: string, parentId?: string, url?: string) => {
    const node: Node = { id, title: id, dateAdded: 1, parentId, ...(url ? { url } : { children: [] }) };
    nodes.set(id, node);
    if (parentId) { const siblings = nodes.get(parentId)!.children!; node.index = siblings.length; siblings.push(node); }
  };
  add('0'); add('1', '0'); add('f', '1');
  for (const id of ['u1', 'u2', 'u3']) add(id, '1', `https://example.test/${id}`);
  add('g', '0'); add('g-folder', 'g');
  const move = vi.fn(async (id: string, destination: { parentId: string; index?: number }) => {
    const node = nodes.get(id)!;
    const previous = nodes.get(node.parentId!)!.children!;
    const from = previous.indexOf(node); previous.splice(from, 1);
    const siblings = nodes.get(destination.parentId)!.children!;
    // Chromium reads a same-parent index before removal.
    let index = destination.index ?? siblings.length + (node.parentId === destination.parentId ? 1 : 0);
    if (node.parentId === destination.parentId && index > from) index -= 1;
    siblings.splice(index, 0, node); node.parentId = destination.parentId;
    siblings.forEach((child, i) => { child.index = i; });
    return structuredClone(node);
  });
  session = {};
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => undefined) }, alarms: { create: vi.fn() },
    storage: { session: {
      get: vi.fn(async (key: string) => (key in session ? { [key]: session[key] } : {})),
      set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(session, structuredClone(items)); }),
      remove: vi.fn(async (key: string) => { delete session[key]; }),
    } }, bookmarks: {
    get: vi.fn(async (id: string) => nodes.has(id) ? [structuredClone({ ...nodes.get(id)!, children: undefined })] : []),
    getChildren: vi.fn(async (id: string) => structuredClone(nodes.get(id)!.children!)), move,
  } });
});
afterEach(() => vi.unstubAllGlobals());

async function pinnedIds(): Promise<string[]> {
  const store = createBookmarkAnnotationStore();
  try { return (await store.list()).filter(row => row.pinned).map(row => row.nativeId).sort(); } finally { store.close(); }
}

test('accepts only well-formed pin messages', () => {
  expect(validPinRequest({ kind: 'known.bookmarks.pin.set', userGesture: true, nativeId: 'u1', pinned: true })).toBe(true);
  expect(validPinRequest({ kind: 'known.bookmarks.pin.set', nativeId: 'u1', pinned: true })).toBe(false);
  expect(validPinRequest({ kind: 'known.bookmarks.pin.status', folderIds: ['1'] })).toBe(true);
  expect(validPinRequest({ kind: 'known.bookmarks.pin.status', folderIds: [] })).toBe(false);
});

test('each pin joins the end of the pinned section, right after the folders', async () => {
  expect(await pin('u3')).toEqual({ ok: true, blockers: [] });
  expect(ids('1')).toEqual(['f', 'u3', 'u1', 'u2']);
  expect(await pin('u2')).toEqual({ ok: true, blockers: [] });
  expect(ids('1')).toEqual(['f', 'u3', 'u2', 'u1']);
  expect(await pinnedIds()).toEqual(['u2', 'u3']);
});

test('a pin that moves nothing still reaches the worker, which wakes sync for it', async () => {
  const heard = vi.fn();
  listenToWorkerAnnotationChanges(heard);
  try {
    expect(await pin('u1')).toEqual({ ok: true, blockers: [] });
    expect(await pin('u1', false)).toEqual({ ok: true, blockers: [] });
    expect(chrome.bookmarks.move).not.toHaveBeenCalled();
    expect(heard.mock.calls).toEqual([['u1'], ['u1']]);
  } finally { listenToWorkerAnnotationChanges(() => undefined); }
});

test('unpinning follows Top of folder: the bookmark becomes the first unpinned one', async () => {
  await pin('u3'); await pin('u2');
  expect(await pin('u3', false)).toEqual({ ok: true, blockers: [] });
  expect(ids('1')).toEqual(['f', 'u2', 'u3', 'u1']);
  expect(await pinnedIds()).toEqual(['u2']);
});

test('pinning is refused with its blockers; unpinning still works and follows Bottom of folder', async () => {
  await pin('u3');
  mocks.preferences.mockResolvedValue({ bookmarkInsertPosition: 'bottom', foldersFirst: true });
  expect(await pin('u2')).toEqual({ ok: false, error: 'not_available', blockers: ['insert_bottom'] });
  expect(await pin('u3', false)).toEqual({ ok: true, blockers: ['insert_bottom'] });
  expect(ids('1')).toEqual(['f', 'u1', 'u2', 'u3']);
  expect(await pinnedIds()).toEqual([]);
});

test('reports blockers per folder, including an unorganized one', async () => {
  const folder = nodes.get('1')!.children!;
  folder.push(folder.shift()!);
  expect(await handlePinRequest({ kind: 'known.bookmarks.pin.status', folderIds: ['1', 'g', '0'] })).toEqual({ ok: true,
    folders: { 1: ['folder_unorganized'], g: [], 0: ['folder_read_only'] } });
});

test('while sync owns the order the flag is kept and placement is left to the folders-first pass', async () => {
  mocks.busy.mockReturnValue(true);
  expect(await pin('u3')).toEqual({ ok: true, blockers: [] });
  expect(ids('1')).toEqual(['f', 'u1', 'u2', 'u3']);
  expect(mocks.schedule).toHaveBeenCalledWith('1');
  expect(await pinnedIds()).toEqual(['u3']);
});

test('a pin retries placement when sync starts after the initial order check', async () => {
  mocks.busy.mockReturnValueOnce(false).mockReturnValue(true);
  expect(await pin('u3')).toEqual({ ok: true, blockers: [] });
  expect(await pinnedIds()).toEqual(['u3']);
  expect(ids('1')).toEqual(['f', 'u1', 'u2', 'u3']);
  expect(chrome.bookmarks.move).not.toHaveBeenCalled();
  expect(mocks.schedule).toHaveBeenCalledWith('1');
});

test('an unpin retries sorting the remaining pins when sync starts mid-pass', async () => {
  await pin('u3'); await pin('u2');
  // Native order may still need repair when the flag is removed.
  const children = nodes.get('1')!.children!;
  children.splice(children.findIndex(node => node.id === 'u2'), 1);
  children.push(nodes.get('u2')!);
  mocks.schedule.mockClear(); vi.mocked(chrome.bookmarks.move).mockClear();
  mocks.busy.mockReturnValueOnce(false).mockReturnValue(true);
  expect(await pin('u3', false)).toEqual({ ok: true, blockers: [] });
  expect(await pinnedIds()).toEqual(['u2']);
  expect(chrome.bookmarks.move).not.toHaveBeenCalled();
  expect(mocks.schedule).toHaveBeenCalledWith('1');
});

test('an unavailable sync database does not report failure after persisting the local pin', async () => {
  mocks.scope.mockResolvedValue({ accountId: 'account', collectionId: 'collection' });
  mocks.state.mockRejectedValue(new Error('sync_database_unavailable'));
  expect(await pin('u3')).toEqual({ ok: true, blockers: [] });
  expect(await pinnedIds()).toEqual(['u3']);
  expect(chrome.bookmarks.move).not.toHaveBeenCalled();
  expect(mocks.schedule).toHaveBeenCalledWith('1');
});

test('an unpin that waits for sync still goes to the bottom once sync releases the order', async () => {
  await pin('u1');
  mocks.preferences.mockResolvedValue({ bookmarkInsertPosition: 'bottom', foldersFirst: true });
  mocks.busy.mockReturnValue(true);
  expect(await pin('u1', false)).toEqual({ ok: true, blockers: ['insert_bottom'] });
  expect(ids('1')).toEqual(['f', 'u1', 'u2', 'u3']);
  expect(chrome.alarms.create).toHaveBeenCalledWith(PIN_PLACEMENT_ALARM, expect.objectContaining({ when: expect.any(Number) }));

  // Still busy at the alarm: nothing moves and the alarm is armed again.
  await placeDeferredUnpins();
  expect(ids('1')).toEqual(['f', 'u1', 'u2', 'u3']);
  expect(chrome.alarms.create).toHaveBeenCalledTimes(2);

  mocks.busy.mockReturnValue(false);
  await placeDeferredUnpins();
  expect(ids('1')).toEqual(['f', 'u2', 'u3', 'u1']);
  expect(session).toEqual({});
});

test('a deferred unpin that was pinned again, or cannot move, stays where it is', async () => {
  await pin('u1'); await pin('u2');
  mocks.preferences.mockResolvedValue({ bookmarkInsertPosition: 'bottom', foldersFirst: true });
  mocks.busy.mockReturnValue(true);
  await pin('u1', false); await pin('u2', false);
  mocks.preferences.mockResolvedValue(top);
  await pin('u1');
  mocks.preferences.mockResolvedValue({ bookmarkInsertPosition: 'bottom', foldersFirst: true });
  mocks.excluded.mockResolvedValue(new Set(['u2']));
  mocks.busy.mockReturnValue(false);
  await placeDeferredUnpins();
  expect(ids('1')).toEqual(['f', 'u1', 'u2', 'u3']);
  expect(chrome.bookmarks.move).not.toHaveBeenCalled();
});

test('fails closed without permission or for folders', async () => {
  expect(await pin('f')).toEqual({ ok: false, error: 'not_found' });
  mocks.permission.mockResolvedValue(false);
  expect(await pin('u1')).toEqual({ ok: false, error: 'permission_required' });
});

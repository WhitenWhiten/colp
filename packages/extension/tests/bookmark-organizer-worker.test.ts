import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { handleOrganizeRequest } from '../src/sw/bookmark-organizer.js';

const mocks = vi.hoisted(() => ({ permission: vi.fn(), busy: vi.fn(), scope: vi.fn(), state: vi.fn(), settled: vi.fn(), excluded: vi.fn(), run: vi.fn(),
  preferences: vi.fn(), pins: vi.fn(), sortPins: vi.fn() }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: mocks.preferences }));
vi.mock('../src/sw/bookmark-pin-pass.js', () => ({ loadPinIndex: mocks.pins, sortFolderPins: mocks.sortPins }));
vi.mock('../src/sw/runtime.js', () => ({ hasBookmarkPermission: mocks.permission,
  syncState: { getEngineState: mocks.state },
  workCoordinator: { run: mocks.run, hasInFlight: mocks.busy },
}));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: mocks.scope }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { settled: mocks.settled } }));
vi.mock('../src/sw/bookmark-folders-first.js', () => ({ withManualBookmarkOrganization: (work: () => Promise<unknown>) => work() }));
vi.mock('../src/bookmark-subscriptions/barrier.js', () => ({ withSubscriptionRead: (work: () => Promise<unknown>) => work() }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: mocks.excluded }));

type Node = chrome.bookmarks.BookmarkTreeNode;
let nodes: Map<string, Node>;
let move: ReturnType<typeof vi.fn>;
const ids = (id: string) => nodes.get(id)!.children!.map(node => node.id);
const apply = (nativeIds: string[]) => handleOrganizeRequest({ kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue(true); mocks.busy.mockReturnValue(false);
  mocks.scope.mockRejectedValue(new Error('not_connected')); mocks.state.mockResolvedValue(undefined);
  mocks.settled.mockResolvedValue(undefined); mocks.excluded.mockResolvedValue(new Set());
  mocks.run.mockImplementation((_lane: string, work: () => Promise<unknown>) => work());
  mocks.preferences.mockResolvedValue({ bookmarkInsertPosition: 'bottom', foldersFirst: false });
  nodes = new Map();
  const add = (id: string, parentId?: string, url?: string): Node => {
    const node: Node = { id, title: id, parentId, ...(url ? { url } : { children: [] }) };
    nodes.set(id, node);
    if (parentId) { const siblings = nodes.get(parentId)!.children!; node.index = siblings.length; siblings.push(node); }
    return node;
  };
  add('0'); add('1', '0'); add('2', '0'); add('root-link', '1', 'https://example.test/root'); add('a', '1'); add('b', '1');
  add('a-link', 'a', 'https://example.test/a'); add('nested', 'a');
  add('deep-link', 'nested', 'https://example.test/deep'); add('deep-folder', 'nested');
  add('b-link', 'b', 'https://example.test/b'); add('b-folder', 'b');
  move = vi.fn(async (id: string, destination: { parentId: string; index: number }) => {
    const node = nodes.get(id)!;
    const previous = nodes.get(node.parentId!)!.children!;
    previous.splice(previous.indexOf(node), 1);
    const siblings = nodes.get(destination.parentId)!.children!;
    siblings.splice(destination.index, 0, node); node.parentId = destination.parentId;
    siblings.forEach((child, index) => { child.index = index; });
    return structuredClone(node);
  });
  vi.stubGlobal('chrome', { bookmarks: {
    getTree: vi.fn(async () => [structuredClone(nodes.get('0')!)]),
    get: vi.fn(async (id: string) => nodes.has(id) ? [structuredClone(nodes.get(id)!)] : []),
    getChildren: vi.fn(async (id: string) => structuredClone(nodes.get(id)!.children!)), move,
  } });
});
afterEach(() => vi.unstubAllGlobals());

test('selected first-level folders organize recursively while root and unselected siblings stay untouched', async () => {
  expect(await apply(['a'])).toEqual({ ok: true, moved: 2 });
  expect(ids('1')).toEqual(['root-link', 'a', 'b']);
  expect(ids('a')).toEqual(['nested', 'a-link']);
  expect(ids('nested')).toEqual(['deep-folder', 'deep-link']);
  expect(ids('b')).toEqual(['b-link', 'b-folder']);
  expect(await apply(['a'])).toEqual({ ok: true, moved: 0 });
});

test('root selection moves only root folders and leaves their contents alone', async () => {
  expect(await apply(['1'])).toEqual({ ok: true, moved: 2 });
  expect(ids('1')).toEqual(['a', 'b', 'root-link']);
  expect(ids('a')).toEqual(['a-link', 'nested']);
  expect(ids('b')).toEqual(['b-link', 'b-folder']);
  expect(move.mock.calls.map(call => call[0])).toEqual(['a', 'b']);
});

test('invalid, stale and deep selections are rejected before any moves', async () => {
  expect(await apply(['a', 'missing'])).toMatchObject({ ok: false, error: 'tree_changed', moved: 0 });
  expect(await apply(['nested'])).toMatchObject({ ok: false, error: 'tree_changed', moved: 0 });
  expect(move).not.toHaveBeenCalled();
});

test.each(['permission', 'busy', 'frozen', 'state_failure'])('does not mutate when %s prevents a safe pass', async condition => {
  if (condition === 'permission') mocks.permission.mockResolvedValue(false);
  if (condition === 'busy') mocks.busy.mockReturnValue(true);
  if (condition === 'frozen' || condition === 'state_failure') mocks.scope.mockResolvedValue({ collectionId: 'collection' });
  if (condition === 'frozen') mocks.state.mockResolvedValue({ recoveryFrozen: true });
  if (condition === 'state_failure') mocks.state.mockRejectedValue(new Error('database_unavailable'));
  expect(await apply(['a'])).toMatchObject({ ok: false, moved: 0 });
  expect(move).not.toHaveBeenCalled();
});

test('a partial failure reports completed moves and retry does not repeat them', async () => {
  const nativeMove = move.getMockImplementation()!;
  move.mockImplementationOnce(nativeMove).mockRejectedValueOnce(new Error('temporary_failure'));
  expect(await apply(['a'])).toEqual({ ok: false, error: 'organize_failed', moved: 1 });
  expect(ids('a')).toEqual(['nested', 'a-link']);
  expect(await apply(['a'])).toEqual({ ok: true, moved: 1 });
  expect(move.mock.calls.filter(call => call[0] === 'nested')).toHaveLength(1);
});

test('concurrent apply calls cannot interleave their mutations', async () => {
  let release!: () => void;
  mocks.settled.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = apply(['a']);
  await vi.waitFor(() => expect(mocks.settled).toHaveBeenCalled());
  expect(await apply(['b'])).toEqual({ ok: false, error: 'busy', moved: 0 });
  release();
  expect(await first).toEqual({ ok: true, moved: 2 });
});

test('stops if a selected ancestor is dragged out while its descendants are being organized', async () => {
  const nativeMove = move.getMockImplementation()!;
  move.mockImplementationOnce(async (id, destination) => {
    const result = await nativeMove(id, destination);
    await nativeMove('a', { parentId: '2', index: 0 });
    return result;
  });
  expect(await apply(['a'])).toEqual({ ok: false, error: 'tree_changed', moved: 1 });
  expect(ids('nested')).toEqual(['deep-link', 'deep-folder']);
});

test('holds the engine lane in connected profiles without mistaking its own captured sync wakes for contention', async () => {
  mocks.scope.mockResolvedValue({ collectionId: 'collection' });
  mocks.run.mockImplementation(async (lane: string, work: () => Promise<unknown>) => {
    if (lane === 'engine') mocks.busy.mockReturnValue(true);
    try { return await work(); }
    finally { mocks.busy.mockReturnValue(false); }
  });
  expect(await apply(['a'])).toEqual({ ok: true, moved: 2 });
  expect(mocks.run).toHaveBeenCalledWith('engine', expect.any(Function));
});

test('with Top of folder, organizing also keeps pinned bookmarks after the folders and counts those moves', async () => {
  mocks.preferences.mockResolvedValue({ bookmarkInsertPosition: 'top', foldersFirst: false });
  mocks.pins.mockResolvedValue(new Map([['b-link', {}]]));
  mocks.sortPins.mockImplementation(async (id: string, _pins: unknown, preferences: { foldersFirst: boolean },
    _excluded: unknown, _enabled: unknown, options: { onMoved: () => void }) => {
    expect(preferences.foldersFirst).toBe(true);
    if (id === 'b') options.onMoved();
    return true;
  });
  expect(await apply(['b'])).toEqual({ ok: true, moved: 2 });
  expect(mocks.sortPins.mock.calls.map(call => call[0])).toEqual(['b', 'b-folder']);
  mocks.sortPins.mockResolvedValue(false);
  expect(await apply(['b'])).toMatchObject({ ok: false, error: 'tree_changed' });
});

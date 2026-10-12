import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  preferences: vi.fn(), permission: vi.fn(), settled: vi.fn(), busy: vi.fn(), engine: vi.fn(),
  scope: vi.fn(), sort: vi.fn(), excluded: vi.fn(), unsupported: vi.fn(), exclusions: vi.fn(), pins: vi.fn(), sortPins: vi.fn(),
}));
vi.mock('../src/sw/bookmark-pin-pass.js', () => ({ loadPinIndex: mocks.pins, sortFolderPins: mocks.sortPins }));
vi.mock('../src/sw/bookmark-preferences.js', () => ({ readEffectiveBookmarkPreferences: mocks.preferences }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { settled: mocks.settled } }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: mocks.scope }));
vi.mock('../src/sw/runtime.js', () => ({
  hasBookmarkPermission: mocks.permission, syncState: { getEngineState: mocks.engine },
  workCoordinator: { run: (_lane: string, work: () => Promise<void>) => work(), hasInFlight: mocks.busy },
}));
vi.mock('../src/bookmark-subscriptions/barrier.js', () => ({ withSubscriptionRead: (work: () => Promise<void>) => work() }));
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: mocks.exclusions, isSubscriptionExcluded: mocks.excluded }));
vi.mock('../src/bookmark-folder-policy.js', () => ({ isUnsupportedBookmarkFolder: mocks.unsupported }));
vi.mock('../src/bookmark-folders-first.js', () => ({
  nativeBookmarkFolders: () => ['parent', 'nested'], sortNativeBookmarkFolder: mocks.sort,
}));

function event() {
  const callbacks = new Set<(...args: never[]) => void>();
  return { callbacks, addListener: vi.fn(callback => callbacks.add(callback)) };
}
let api: { getTree: ReturnType<typeof vi.fn>; onCreated: ReturnType<typeof event>;
  onMoved: ReturnType<typeof event>; onChildrenReordered: ReturnType<typeof event> };
let changed: ReturnType<typeof event>;
let alarm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  mocks.preferences.mockResolvedValue({ foldersFirst: true });
  mocks.permission.mockResolvedValue(true); mocks.settled.mockResolvedValue(undefined);
  mocks.busy.mockReturnValue(false); mocks.engine.mockResolvedValue(undefined);
  mocks.scope.mockRejectedValue(new Error('not_connected'));
  mocks.sort.mockResolvedValue(undefined); mocks.excluded.mockResolvedValue(false);
  mocks.unsupported.mockResolvedValue(false); mocks.exclusions.mockResolvedValue(new Set());
  api = { getTree: vi.fn().mockResolvedValue([]), onCreated: event(), onMoved: event(), onChildrenReordered: event() };
  changed = event(); alarm = vi.fn();
  vi.stubGlobal('chrome', { bookmarks: api, storage: { onChanged: changed }, alarms: { create: alarm } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test.each(['permission', 'disabled'])('does not read or mutate the tree with %s unavailable', async condition => {
  if (condition === 'permission') mocks.permission.mockResolvedValue(false);
  else mocks.preferences.mockResolvedValue({ foldersFirst: false });
  const worker = await import('../src/sw/bookmark-folders-first.js');
  worker.scheduleNativeFoldersFirst();
  await vi.advanceTimersByTimeAsync(100);
  expect(api.getTree).not.toHaveBeenCalled(); expect(mocks.sort).not.toHaveBeenCalled();
});

test('coalesces native event parents and installs the same listener callbacks', async () => {
  const worker = await import('../src/sw/bookmark-folders-first.js');
  worker.installNativeFoldersFirst(); worker.installNativeFoldersFirst();
  expect(api.onMoved.callbacks.size).toBe(1);
  const move = api.onMoved.addListener.mock.calls[0]![0];
  move('x', { parentId: 'new-parent', oldParentId: 'old-parent' });
  move('y', { parentId: 'new-parent', oldParentId: 'old-parent' });
  await vi.advanceTimersByTimeAsync(100);
  expect(api.getTree).not.toHaveBeenCalled();
  expect(mocks.sort.mock.calls.map(call => call[1])).toEqual(['new-parent', 'old-parent']);
});

test('waits for creation receipt capture, then applies local grouping while signed out', async () => {
  let release!: () => void;
  mocks.settled.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  const worker = await import('../src/sw/bookmark-folders-first.js');
  worker.scheduleNativeFoldersFirst('parent');
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.sort).not.toHaveBeenCalled();
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.sort).toHaveBeenCalledTimes(1);
});

test.each(['busy', 'frozen', 'api_failure', 'state_failure'])('defers %s work to a durable alarm without immediate retry loops', async condition => {
  mocks.scope.mockResolvedValue({ collectionId: 'collection' });
  if (condition === 'busy') mocks.busy.mockReturnValue(true);
  if (condition === 'frozen') mocks.engine.mockResolvedValue({ recoveryFrozen: true });
  if (condition === 'api_failure') api.getTree.mockRejectedValue(new Error('temporary_failure'));
  if (condition === 'state_failure') mocks.engine.mockRejectedValue(new Error('database_unavailable'));
  const worker = await import('../src/sw/bookmark-folders-first.js');
  worker.scheduleNativeFoldersFirst();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.sort).not.toHaveBeenCalled();
  expect(alarm).toHaveBeenCalledTimes(1);
  expect(alarm).toHaveBeenCalledWith(worker.FOLDERS_FIRST_ALARM, { when: expect.any(Number) });
  mocks.busy.mockReturnValue(false); mocks.engine.mockResolvedValue(undefined); api.getTree.mockResolvedValue([]);
  worker.scheduleNativeFoldersFirst();
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.sort).toHaveBeenCalledTimes(2);
});

test('preference changes request all existing folders and never sort subscription parents', async () => {
  const worker = await import('../src/sw/bookmark-folders-first.js');
  worker.installNativeFoldersFirstStorageListener();
  mocks.excluded.mockImplementation(async id => id === 'nested');
  const listener = changed.addListener.mock.calls[0]![0];
  listener({ 'known.bookmark.preferences.v1': { newValue: {} } }, 'local');
  await vi.advanceTimersByTimeAsync(100);
  expect(api.getTree).toHaveBeenCalledTimes(1);
  expect(mocks.sort.mock.calls.map(call => call[1])).toEqual(['parent']);
});

test('manual folder moves cannot trigger an automatic pass outside the chosen scope', async () => {
  const worker = await import('../src/sw/bookmark-folders-first.js');
  worker.installNativeFoldersFirst();
  const onMoved = api.onMoved.addListener.mock.calls[0]![0];
  await worker.withManualBookmarkOrganization(async () => {
    onMoved('folder', { parentId: 'chosen', oldParentId: 'chosen' });
    await vi.advanceTimersByTimeAsync(500);
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(mocks.sort).not.toHaveBeenCalled();
  expect(api.getTree).not.toHaveBeenCalled();
});

test('keeps pinned bookmarks after the folders only for Top of folder and grouped folders', async () => {
  mocks.sort.mockImplementation(async (_api: unknown, id: string) => id === 'parent');
  mocks.pins.mockResolvedValue(new Map([['pinned', {}]])); mocks.sortPins.mockResolvedValue(true);
  mocks.preferences.mockResolvedValue({ foldersFirst: true, bookmarkInsertPosition: 'top' });
  const worker = await import('../src/sw/bookmark-folders-first.js');
  worker.scheduleNativeFoldersFirst();
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.sortPins.mock.calls.map(call => call[0])).toEqual(['parent']);
  mocks.sortPins.mockClear(); mocks.pins.mockClear();
  mocks.preferences.mockResolvedValue({ foldersFirst: true, bookmarkInsertPosition: 'bottom' });
  worker.scheduleNativeFoldersFirst();
  await vi.advanceTimersByTimeAsync(100);
  expect(mocks.pins).not.toHaveBeenCalled(); expect(mocks.sortPins).not.toHaveBeenCalled();
});

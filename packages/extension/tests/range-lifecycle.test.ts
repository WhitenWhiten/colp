// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { resolveIngressBoundary } from '../src/bookmark-event-ingress.js';
import { bindFolders } from '../src/sync-folders.js';
import { bindRangeAdjustment } from '../src/range-ui.js';
import { handleRootRequest, loadRootView, readRootFolders } from '../src/sw/roots.js';
import { sw, syncState } from '../src/sw/runtime.js';
import { handleRangeConfirm } from '../src/sw/range.js';
import { mayMutateNative } from '../src/pull-mount-apply.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { RootRequest, RootResponse } from '../src/types.js';
import type { SyncScope } from '../src/sync-state-store.js';

// Keep the picker, message handlers, range planner, bootstrap and IndexedDB real.
// Only the browser and background scheduling are replaced at the process boundary.
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: createSyncStateStore({ indexedDB: new IDBFactory() }), sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => permissions.granted, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
const permissions = vi.hoisted(() => ({ granted: true }));
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/bookmarks.js', () => ({
  bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn(),
}));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

let scope: SyncScope;
let raw: ChromeBookmarkNode[];
let serial = 0;
const node = (id: string): ChromeBookmarkNode => {
  const visit = (rows: readonly ChromeBookmarkNode[]): ChromeBookmarkNode | undefined => {
    for (const row of rows) { if (row.id === id) return row; const found = visit(row.children ?? []); if (found) return found; }
  };
  const found = visit(raw); if (!found) throw new Error(`Can't find bookmark for id. ${id}`); return found;
};
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const checkbox = (title: string) => Array.from(document.querySelectorAll<HTMLInputElement>('.root-select input'))
  .find(input => input.getAttribute('aria-label') === title)!;

beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test', accountId: `account-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };
  sw.rootViewTokens = undefined;
  permissions.granted = true;
  raw = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
      { id: '10', parentId: '1', title: 'Novels', children: [
        { id: '11', parentId: '10', title: 'Novel', url: 'https://example.test/novel' },
      ] },
      { id: '20', parentId: '1', title: 'AI', children: [
        { id: '21', parentId: '20', title: 'Model', url: 'https://example.test/model' },
      ] },
      { id: '12', parentId: '1', title: 'Loose', url: 'https://example.test/loose' },
    ] },
    { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
  ] }];
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } },
    runtime: { sendMessage: vi.fn((message: RootRequest) => handleRootRequest(message)) },
    bookmarks: { getTree: async () => structuredClone(raw), get: async (id: string) => [structuredClone(node(id))],
      getChildren: async (id: string) => structuredClone(node(id).children ?? []),
      create: vi.fn(), update: vi.fn(), move: vi.fn(), remove: vi.fn(), removeTree: vi.fn() } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
afterAll(() => syncState.close());

async function seed(mode: 'nested' | 'roots' = 'nested') {
  for (const id of ['1', '2', '10', '11', '20', '21']) {
    const native = node(id), rootId = mode === 'roots' ? (id === '2' ? '2' : '1')
      : ['1', '2', '10', '20'].includes(id) ? id : native.parentId!;
    await syncState.putMapping(scope, { nativeId: id, colpId: `remote-${id}`, rootNativeId: rootId,
      mountId: `mount-${rootId}`, nodeKind: native.url ? 'bookmark' : 'folder',
      ...(native.parentId && native.parentId !== '0' ? { parentNativeId: native.parentId, parentColpId: `remote-${native.parentId}` } : {}),
      ...(['1', '2'].includes(id) ? { rootRole: id === '1' ? 'bookmarks-bar' as const : 'other-bookmarks' as const } : {}),
      projection: { revision: `r-${id}`, digest: `sha256:${id}`, ...(native.url ? {} : { childrenRevision: `c-${id}` }),
        content: { title: native.title, ...(native.url ? { url: native.url } : {}) } } });
  }
  const selected = mode === 'roots' ? ['1', '2'] : ['10', '20'];
  for (const id of selected) await syncState.putMountBinding(scope, {
    mountId: `mount-${id}`, nativeRootId: id, remoteMountNodeId: `remote-${id}`, boundaryVersion: '0',
    materialized: false, status: 'active', ...(mode === 'roots'
      ? { rootRole: id === '1' ? 'bookmarks-bar' as const : 'other-bookmarks' as const } : { customSourceKey: `folder:${id}` }),
  });
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: selected, privateNativeIds: [], status: 'ready' });
}

async function screen() {
  const folders = bindFolders({ isConnected: () => true, firstRun: () => ({ isRangeActive: () => false, onRootsRendered: () => {} }) });
  folders.render(await loadRootView(scope));
  const range = bindRangeAdjustment({ saveRoots: element('save-roots'), rootTree: element('root-tree'),
    rootFeedback: element('root-feedback'), getView: folders.view, setView: folders.render,
    reloadBoundaries: () => {}, onConfirmed: () => {}, isConnected: () => true,
    renderFailure: code => { throw new Error(code); } });
  return { folders, review: range.save };
}

async function confirm() {
  element('range-confirm').click();
  const calls = vi.mocked(chrome.runtime.sendMessage).mock;
  const response = await calls.results.at(-1)!.value as RootResponse;
  await vi.waitFor(() => expect(element('range-confirm').hasAttribute('aria-busy')).toBe(false));
  return response;
}

test('expanding three first-sync folders from 12/28 to 28/28 reviews only the newly covered items', async () => {
  const bookmarks = (parentId: string, count: number): ChromeBookmarkNode[] => Array.from({ length: count }, (_, index) => ({
    id: `${parentId}-bookmark-${index}`, parentId, title: `Bookmark ${index}`, url: `https://example.test/${parentId}/${index}`,
  }));
  const selected = ['synced-a', 'synced-b', '2'];
  const groups: ChromeBookmarkNode[] = selected.slice(0, 2).map((id, group) => ({ id, parentId: '1', title: id,
    children: [...bookmarks(id, 450), ...Array.from({ length: 4 + group }, (_, index) => ({
      id: `${id}-child-${index}`, parentId: id, title: `${id} child ${index}`, children: [],
    }))] }));
  const added: ChromeBookmarkNode[] = Array.from({ length: 15 }, (_, index) => ({
    id: `new-${index}`, parentId: '1', title: `New folder ${index}`, children: [],
  }));
  raw = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar',
      children: [...groups, ...added, ...bookmarks('1', 1226)] },
    { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
  ] }];
  for (const id of selected) {
    await syncState.putMapping(scope, { nativeId: id, colpId: `remote-${id}`, rootNativeId: id,
      mountId: `mount-${id}`, nodeKind: 'folder', projection: { revision: `r-${id}`, digest: `sha256:${id}` } });
    await syncState.putMountBinding(scope, { mountId: `mount-${id}`, nativeRootId: id,
      remoteMountNodeId: `remote-${id}`, boundaryVersion: '0', materialized: false,
      status: 'active', ...(id === '2' ? { rootRole: 'other-bookmarks' as const } : { customSourceKey: `folder:${id}` }) });
  }
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: selected, privateNativeIds: [], status: 'ready' });
  const before = await syncState.exportScope(scope);
  const ui = await screen();
  expect(element('folder-count').textContent).toBe('12 of 28 folders sync');
  element('tree-select-level').click();
  expect(element('folder-count').textContent).toBe('28 of 28 folders sync');
  await ui.review();
  const response = await vi.mocked(chrome.runtime.sendMessage).mock.results.at(-1)!.value as RootResponse;
  if (!response.ok || !('preview' in response)) throw new Error('range_preview_missing');
  expect(response.preview).toMatchObject({ folderCount: 28, bookmarkCount: 2126, addedCount: 16, addedBookmarkCount: 1226 });
  expect((await syncState.getScopePreview(scope, response.preview.previewId))?.addedNativeIds).toEqual(['1']);
  expect(response.preview.additions).toHaveLength(16);
  expect(response.preview.additions.map(row => row.title)).toEqual(['Bookmarks bar', ...added.map(row => row.title)]);
  expect(response.preview.additions.find(row => row.title === 'Bookmarks bar')?.bookmarkCount).toBe(1226);
  expect(response.preview.additions.filter(row => row.title !== 'Bookmarks bar').every(row => row.bookmarkCount === 0)).toBe(true);
  expect(JSON.stringify(response.preview.additions)).not.toMatch(/nativeId|synced-[abc]/u);
  expect(element('range-preview-totals').textContent).toContain('Will sync 2126 bookmarks in 28 folders.');
  expect(element('range-preview-totals').textContent).toContain('16 folders and 1226 bookmarks will start syncing');
  expect(element('range-add-list').children).toHaveLength(16);
  expect(element('range-add-list').textContent).toContain('Bookmarks bar / New folder 0');
  expect(element('range-add-list').textContent).not.toContain('synced-a');
  const after = await syncState.exportScope(scope);
  expect(after.scope).toEqual(before.scope); expect(after.mountBindings).toEqual(before.mountBindings);
  expect(after.mappings).toEqual(before.mappings); expect(after.queue).toEqual(before.queue);
});

test('existing subfolder sync → Sync all → review → confirm → reload preserves identity and captures later edits', async () => {
  await seed();
  const ui = await screen();
  expect(checkbox('Novels').checked).toBe(true);
  element('tree-select-level').click();
  await ui.review();
  expect(element('range-remove-list').hidden).toBe(true);
  expect(element('range-shift-list').hidden).toBe(true);
  expect(element('range-remote-delete-label').hidden).toBe(true);
  expect(await confirm()).toMatchObject({ ok: true });
  ui.folders.render(await loadRootView(scope));
  for (const title of ['Bookmarks bar', 'Novels', 'AI', 'Other bookmarks']) expect(checkbox(title).checked).toBe(true);
  for (const id of ['10', '20']) expect(await syncState.getMountBinding(scope, `mount-${id}`)).toMatchObject({ status: 'active', remoteMountNodeId: `remote-${id}` });
  for (const id of ['10', '11', '20', '21']) expect((await syncState.getMappingByNativeId(scope, id))?.colpId).toBe(`remote-${id}`);
  expect((await syncState.listQueue(scope)).every(row => row.payload.type === 'create_node')).toBe(true);
  expect(JSON.stringify(await syncState.listQueue(scope))).not.toMatch(/example.test\/(novel|model)/u);
  const queue = createBookmarkEventQueue({ scope, store: syncState, api: chrome.bookmarks, autoFlush: false });
  Object.assign(node('11'), { title: 'Edited novel' });
  expect((await queue.changed('11', { title: 'Edited novel' })).outcome).toBe('staged');
});

test.each(['nested', 'roots'] as const)('clearing %s selection really stops sync and survives reload', async mode => {
  await seed(mode);
  const ui = await screen();
  element('tree-clear-selection').click();
  await ui.review();
  expect(element('range-shift-list').hidden).toBe(true);
  expect(element('range-remove-list').children).toHaveLength(2);
  expect(await confirm()).toMatchObject({ ok: true });
  ui.folders.render(await loadRootView(scope));
  for (const title of ['Bookmarks bar', 'Novels', 'AI', 'Other bookmarks']) expect(checkbox(title).checked).toBe(false);
  expect([...(await resolveIngressBoundary(syncState, scope)).selectedNative]).toEqual([]);
  expect(await syncState.listQueue(scope)).toEqual([]);
  expect((await syncState.getMappingByNativeId(scope, '11'))?.colpId).toBe('remote-11');
});

test('excluding and restoring an existing subfolder under a selected parent resumes its original binding', async () => {
  await seed();
  const ui = await screen(); element('tree-select-level').click(); await ui.review();
  expect(await confirm()).toMatchObject({ ok: true });
  checkbox('Novels').click(); await ui.review();
  expect(element('range-remove-list').textContent).toContain('Novels');
  expect(await confirm()).toMatchObject({ ok: true });
  expect((await syncState.getMountBinding(scope, 'mount-10'))?.status).toBe('detached');
  checkbox('Novels').click(); await ui.review();
  expect(element('range-remove-list').hidden).toBe(true);
  expect(element('range-preview-totals').textContent).toContain('1 folder and 1 bookmark will start syncing');
  expect(element('range-add-list').children).toHaveLength(1);
  expect(element('range-add-list').textContent).toContain('Bookmarks bar / Novels');
  expect(await confirm()).toMatchObject({ ok: true });
  expect((await syncState.getMountBinding(scope, 'mount-10'))?.status).toBe('active');
  expect((await syncState.getMappingByNativeId(scope, '11'))?.colpId).toBe('remote-11');
});

test('canceling review leaves durable selections, mounts and queue unchanged', async () => {
  await seed(); const before = await syncState.exportScope(scope);
  const ui = await screen(); element('tree-clear-selection').click(); await ui.review(); element('range-cancel').click();
  const after = await syncState.exportScope(scope);
  expect(after.scope).toEqual(before.scope); expect(after.mountBindings).toEqual(before.mountBindings);
  expect(after.mappings).toEqual(before.mappings); expect(after.queue).toEqual(before.queue);
  expect(element('root-tree').hasAttribute('inert')).toBe(false);
});

test('a background folder refresh preserves an unsaved clear selection before review', async () => {
  await seed(); const ui = await screen(); element('tree-clear-selection').click();
  await ui.folders.load();
  expect(document.querySelectorAll('.root-select input:checked')).toHaveLength(0);
  await ui.review(); expect(element('range-remove-list').children).toHaveLength(2);
});

test.each(['nested', 'roots'] as const)('clear %s sync → confirm → Sync all resumes paused identities', async mode => {
  await seed(mode); const ui = await screen();
  element('tree-clear-selection').click(); await ui.review(); expect(await confirm()).toMatchObject({ ok: true });
  element('tree-select-level').click(); await ui.review(); expect(await confirm()).toMatchObject({ ok: true });
  for (const id of mode === 'nested' ? ['10', '20'] : ['1', '2']) {
    expect(await syncState.getMountBinding(scope, `mount-${id}`)).toMatchObject({ status: 'active', remoteMountNodeId: `remote-${id}` });
  }
  expect((await syncState.getMappingByNativeId(scope, '11'))?.colpId).toBe('remote-11');
});

test('reopening an unchanged private browser-root selection produces no repeated removals', async () => {
  await seed('roots');
  await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: ['1', '2'], privateNativeIds: ['1'], status: 'ready' });
  const ui = await screen();
  await ui.review();
  expect(element('range-remove-list').hidden).toBe(true);
  expect(element('range-shift-list').hidden).toBe(true);
  expect(element('range-add-list').hidden).toBe(true);
  expect(element('range-preview-totals').textContent).not.toContain('will start syncing');
});

async function confirmationRequest(): Promise<Extract<RootRequest, { kind: 'known.roots.confirm' }>> {
  const response = await vi.mocked(chrome.runtime.sendMessage).mock.results.at(-1)!.value as RootResponse;
  if (!response.ok || !('preview' in response)) throw new Error('preview_missing');
  return { kind: 'known.roots.confirm', previewId: response.preview.previewId,
    treeDigest: response.preview.treeDigest, confirmationId: crypto.randomUUID() };
}

test('a changed folder outside the next selection invalidates a removal preview before any settings change', async () => {
  await seed(); const ui = await screen(); element('tree-clear-selection').click(); await ui.review();
  const request = await confirmationRequest(); const before = await syncState.exportScope(scope);
  Object.assign(node('10'), { title: 'Renamed after review' });
  expect(await handleRangeConfirm(request)).toEqual({ ok: false, error: 'preview_stale' });
  expect(await syncState.exportScope(scope)).toEqual(before);
});

test('two simultaneous confirmations apply a preview once', async () => {
  await seed(); const ui = await screen(); element('tree-select-level').click(); await ui.review();
  const request = await confirmationRequest();
  const responses = await Promise.all([handleRangeConfirm(request), handleRangeConfirm({ ...request, confirmationId: crypto.randomUUID() })]);
  expect(responses).toEqual([{ ok: true }, { ok: false, error: 'duplicate_confirm' }]);
  expect((await syncState.getScope(scope))?.boundaryVersion).toBe('1');
  expect(await syncState.listBootstrapRuns(scope)).toHaveLength(1);
});

test('remote trash growth rejects the whole confirmation without consuming its preview or detaching folders', async () => {
  await seed(); const ui = await screen(); element('tree-clear-selection').click(); await ui.review();
  const request = await confirmationRequest();
  const novelRef = Array.from(sw.rootViewTokens!.entries).find(([, entry]) => entry.nativeId === '10')![0];
  await syncState.putRemoteObservation(scope, { colpId: 'remote-new', remoteRevision: 'r-new', cursor: 'c1', kind: 'content',
    payload: { parentId: 'remote-10', title: 'New remote bookmark', url: 'https://example.test/new' }, sourceDigest: 'digest', observedAt: Date.now() });
  const before = await syncState.exportScope(scope);
  expect(await handleRangeConfirm({ ...request, remoteDeleteRefs: [novelRef] })).toEqual({ ok: false, error: 'preview_stale' });
  expect(await syncState.exportScope(scope)).toEqual(before);
});

test('permission revoked during review reports failure instead of claiming settings were saved', async () => {
  await seed(); const ui = await screen(); element('tree-select-level').click(); await ui.review();
  permissions.granted = false;
  expect(await confirm()).toEqual({ ok: false, error: 'permission_required' });
  expect(element('root-feedback').textContent).toContain('Bookmark access is required');
  expect(element('range-preview').hidden).toBe(true);
  expect(await syncState.listQueue(scope)).toEqual([]);
  expect((await syncState.getScope(scope))?.boundaryVersion ?? '0').toBe('0');
});

test.each(['nested', 'roots'] as const)('explicit remote trash after clearing %s sync preserves every native bookmark and stops ingress', async mode => {
  await seed(mode); const before = structuredClone(raw);
  const ui = await screen(); element('tree-clear-selection').click(); await ui.review();
  element<HTMLInputElement>('range-remote-delete').checked = true;
  expect(await confirm()).toMatchObject({ ok: true });
  const operations = await syncState.listQueue(scope);
  expect(operations).toHaveLength(2);
  expect(operations.every(row => row.payload.type === 'delete_subtree')).toBe(true);
  expect([...(await resolveIngressBoundary(syncState, scope)).selectedNative]).toEqual([]);
  expect(raw).toEqual(before);
  expect(chrome.bookmarks.remove).not.toHaveBeenCalled(); expect(chrome.bookmarks.removeTree).not.toHaveBeenCalled();
});

test('narrowing a browser root to a synced child keeps downloads writable for that child only', async () => {
  await seed('roots'); const ui = await screen(); element('tree-clear-selection').click();
  checkbox('Novels').click(); await ui.review(); expect(await confirm()).toMatchObject({ ok: true });
  const mappings = await syncState.listMappings(scope), mounts = await syncState.listMountBindings(scope);
  expect(mayMutateNative(mappings.find(row => row.nativeId === '11')!, mounts)).toBe(true);
  expect(mayMutateNative(mappings.find(row => row.nativeId === '21')!, mounts)).toBe(false);
});

async function shifted() {
  await seed();
  const { scopeKey: _key, ...mount } = (await syncState.getMountBinding(scope, 'mount-10'))!;
  await syncState.putMountBinding(scope, { ...mount, status: 'detached',
    pendingShift: { colpId: 'remote-10', fromParentNativeId: '1', toParentNativeId: '2' } });
  const ui = await screen(); await ui.review(); return ui;
}

test('a real pending move only offers remote trash when its action is Stop syncing', async () => {
  await shifted();
  const action = element('range-shift-list').querySelector('select')!;
  expect(action.value).toBe('keep'); expect(element('range-remote-delete-label').hidden).toBe(true);
  action.value = 'unmount'; action.dispatchEvent(new Event('change', { bubbles: true }));
  expect(element('range-remote-delete-label').hidden).toBe(false);
  element<HTMLInputElement>('range-remote-delete').checked = true;
  action.value = 'keep'; action.dispatchEvent(new Event('change', { bubbles: true }));
  expect(element('range-remote-delete-label').hidden).toBe(true);
  expect(element<HTMLInputElement>('range-remote-delete').checked).toBe(false);
});

test('stopping a pending move removes its selection instead of immediately rejoining it', async () => {
  const ui = await shifted();
  const action = element('range-shift-list').querySelector('select')!;
  action.value = 'unmount'; action.dispatchEvent(new Event('change', { bubbles: true }));
  expect(await confirm()).toMatchObject({ ok: true });
  expect((await syncState.getMountBinding(scope, 'mount-10'))?.status).toBe('detached');
  ui.folders.render(await loadRootView(scope));
  expect(checkbox('Novels').checked).toBe(false); expect(checkbox('AI').checked).toBe(true);
  await ui.review(); expect(element('range-shift-list').hidden).toBe(true);
});

test.each(['conflicting-trash', 'duplicate-action'] as const)('a %s move confirmation is rejected before changing settings', async mode => {
  await shifted(); const request = await confirmationRequest();
  const ref = element('range-shift-list').querySelector('select')!.dataset.ref!;
  const before = await syncState.exportScope(scope);
  expect(await handleRangeConfirm({ ...request, shiftActions: [{ ref, action: 'keep' },
    ...(mode === 'duplicate-action' ? [{ ref, action: 'unmount' as const }] : [])],
    ...(mode === 'conflicting-trash' ? { remoteDeleteRefs: [ref] } : {}),
  })).toEqual({ ok: false, error: 'request_invalid' });
  expect(await syncState.exportScope(scope)).toEqual(before);
});

test('review locks selection controls and repeated clicks cannot create competing previews', async () => {
  await seed(); const ui = await screen(); element('tree-select-level').click();
  const send = vi.mocked(chrome.runtime.sendMessage), original = send.getMockImplementation()!;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  send.mockImplementationOnce(async message => { await wait; return original(message); });
  const first = ui.review(), second = ui.review();
  expect(send).toHaveBeenCalledTimes(1);
  for (const id of ['tree-select-level', 'tree-clear-selection', 'refresh-roots']) expect(element<HTMLButtonElement>(id).disabled).toBe(true);
  expect(element('root-tree').hasAttribute('inert')).toBe(true);
  release(); await Promise.all([first, second]); element('range-cancel').click();
  expect(element<HTMLButtonElement>('tree-select-level').disabled).toBe(false);
  expect(element('root-tree').hasAttribute('inert')).toBe(false);
});

test.each([false, true])('expanding into canonical browser roots binds remote role identities (local reservation: %s)', async reserve => {
  await seed();
  for (const id of ['1', '2']) await syncState.deleteMapping(scope, id);
  for (const [id, role] of [['root', 'root'], ['1', 'bookmarks-bar'], ['2', 'other-bookmarks']]) {
    await syncState.putMapping(scope, { nativeId: `recovery:${id}`, colpId: `canonical-${id}`, rootNativeId: 'recovery:root', nodeKind: 'folder',
      ...(id !== 'root' ? { parentColpId: 'canonical-root' } : {}),
      projection: { revision: `r-${id}`, childrenRevision: `c-${id}`, digest: `sha256:${id}`,
        content: { title: id === 'root' ? 'Bookmarks' : node(id!).title, folderRole: role! } } });
  }
  if (reserve) await syncState.configureBrowserRoots(scope, { discovered: (await readRootFolders()).discovered,
    selectedNativeIds: ['1', '2'], privateNativeIds: [], status: 'ready' });
  const ui = await screen(); element('tree-select-level').click(); await ui.review(); expect(await confirm()).toMatchObject({ ok: true });
  for (const id of ['1', '2']) {
    expect(await syncState.getMountBinding(scope, `mount:${id}`)).toMatchObject({ status: 'active', remoteMountNodeId: `canonical-${id}` });
    expect(await syncState.getMappingByNativeId(scope, id)).toMatchObject({ colpId: `canonical-${id}`, projection: { revision: `r-${id}` } });
    expect(await syncState.getMappingByColpId(scope, `canonical-${id}`)).toMatchObject({ nativeId: id });
  }
  expect((await syncState.getScope(scope))?.selectedRoots).toEqual(['canonical-1', 'canonical-2']);
});

test('excluding a root after earlier range changes confirms its cloud trash in the same operation', async () => {
  await seed('roots');
  await syncState.bumpBoundaryVersion(scope); await syncState.bumpBoundaryVersion(scope);
  const ui = await screen();
  checkbox('Bookmarks bar').click(); await ui.review();
  element<HTMLInputElement>('range-remote-delete').checked = true;
  expect(await confirm()).toMatchObject({ ok: true });
  expect((await syncState.listQueue(scope)).map(row => row.payload.targetId).sort()).toEqual(['remote-10', 'remote-20']);
});

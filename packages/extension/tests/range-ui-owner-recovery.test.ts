// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { MemoryStorageArea } from '../src/credential-store.js';
import { bindFolders } from '../src/sync-folders.js';
import { bindRangeAdjustment } from '../src/range-ui.js';
import { RANGE_CONFIRMATION_TIMEOUT_MS } from '../src/range-confirmation-session.js';
import { handleRootRequest } from '../src/sw/roots.js';
import { sw, syncState } from '../src/sw/runtime.js';
import type { ChromeBookmarkNode } from '../src/chrome-bookmark-tree.js';
import type { PublicRangeResume, RootRequest, RootResponse } from '../src/types.js';
import type { SyncScope } from '../src/sync-state-store.js';

// The browser transport and independent subscription database are external
// ports. Root admission, immutable receipts, UI and IndexedDB remain real.
vi.mock('../src/sw/runtime.js', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { createSyncStateStore } = await import('../src/sync-state-store.js');
  return { syncState: { ...createSyncStateStore({ indexedDB: new IDBFactory() }) }, sw: { rootViewTokens: undefined },
    hasBookmarkPermission: async () => true, rootScopeKey: (value: unknown) => JSON.stringify(value), DEFAULT_SYNC_FOLDER_TITLE: 'Know-N' };
});
vi.mock('../src/sw/scope.js', () => ({ currentSyncScope: async () => scope }));
vi.mock('../src/sw/bookmarks.js', () => ({ bookmarkListenerLifecycle: { install: vi.fn() }, recoverBookmarkEvents: vi.fn() }));
vi.mock('../src/sw/engine.js', () => ({ scheduleSyncEngineWake: vi.fn() }));
vi.mock('../src/sw/library.js', () => ({ resolveLibraryRootId: async () => 'canonical-root' }));
vi.mock('../src/bookmark-subscriptions/store.js', () => ({ subscriptionStore: {
  pendingOperations: async () => [], all: async () => [], count: async () => 0, ready: async () => {},
} }));

const STORAGE_KEY = 'known.range.confirmation.v1';
let markup: string, scope: SyncScope, tree: ChromeBookmarkNode[], storage: MemoryStorageArea;
let connected = false, serial = 0;
let held: { kind: RootRequest['kind']; ready(response: RootResponse): void; wait: Promise<void> } | undefined;
const messages: RootRequest[] = [];
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
beforeAll(async () => { markup = (await readFile('options.html', 'utf8')).match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, ''); });
beforeEach(async () => {
  scope = { environment: 'development', serverId: 'server', serverOrigin: 'https://known.test', accountId: `ui-owner-${++serial}`,
    browserProfileId: 'profile', collectionId: 'collection-A', replicaId: 'replica', generation: 1 };
  connected = false; held = undefined; messages.length = 0; storage = new MemoryStorageArea(); sw.rootViewTokens = undefined;
  tree = [{ id: '0', title: '', children: [
    { id: '1', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [] },
    { id: '2', parentId: '0', title: 'Other bookmarks', folderType: 'other', children: [] },
  ] }];
  vi.stubGlobal('chrome', { storage: { local: storage }, runtime: { sendMessage: async (request: RootRequest) => {
    messages.push(structuredClone(request));
    const ticket = held?.kind === request.kind ? held : undefined;
    if (ticket) held = undefined;
    const response = await handleRootRequest(request);
    if (ticket) { ticket.ready(response); await ticket.wait; }
    return response;
  } }, bookmarks: { getTree: async () => structuredClone(tree) } });
  await syncState.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: Date.now() + 60_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [], privateRoots: [], rootStatus: 'ready', firstRun: 'completed' });
  document.body.innerHTML = markup;
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
afterAll(() => syncState.close());

function hold(kind: RootRequest['kind']) {
  let release!: () => void, ready!: (response: RootResponse) => void;
  const received = new Promise<RootResponse>(resolve => { ready = resolve; });
  held = { kind, ready, wait: new Promise<void>(resolve => { release = resolve; }) };
  return { received, release };
}
async function screen() {
  let range!: ReturnType<typeof bindRangeAdjustment>;
  const folders = bindFolders({ isConnected: () => connected,
    firstRun: () => ({ isRangeActive: () => false, onRootsRendered: () => {} }),
    onRootResponse: response => range.onRootResponse(response) });
  const onConfirmed = vi.fn(), reloadBoundaries = vi.fn();
  range = bindRangeAdjustment({ saveRoots: byId('save-roots'), rootTree: byId('root-tree'), rootFeedback: byId('root-feedback'),
    getView: folders.view, setView: folders.render, reloadBoundaries, onConfirmed,
    isConnected: () => connected, renderFailure: folders.renderFailure });
  range.setLibraryId(scope.collectionId); folders.setLibraryId(scope.collectionId);
  connected = true; await folders.load(); range.onConnection(true);
  return { range, folders, onConfirmed, reloadBoundaries };
}
async function changeOwner(ui: Awaited<ReturnType<typeof screen>>, kind: 'aba' | 'pagehide') {
  if (kind === 'pagehide') { window.dispatchEvent(new Event('pagehide')); return; }
  connected = false; ui.range.onConnection(false); ui.folders.onConnection(false);
  for (const id of ['collection-B', 'collection-A']) { ui.range.setLibraryId(id); ui.folders.setLibraryId(id); }
  tree = tree.map(root => ({ ...root, children: root.children?.map(row => row.id === '1'
    ? { ...row, title: 'Current account folder' } : row) }));
  connected = true; await ui.folders.load();
}

test.each(['aba', 'pagehide'] as const)('late preview cannot repaint or confirm after %s', async owner => {
  const ui = await screen(), pending = hold('known.roots.preview'), save = ui.range.save();
  expect(await pending.received).toMatchObject({ ok: true, preview: { boundaryVersion: '0' } });
  await changeOwner(ui, owner); const current = document.body.innerHTML;
  pending.release(); await save;
  expect(document.body.innerHTML).toBe(current);
  byId('range-confirm').click(); await Promise.resolve();
  expect(messages.filter(row => row.kind === 'known.roots.confirm')).toHaveLength(0);
  expect(ui.onConfirmed).not.toHaveBeenCalled();
});

test.each(['aba', 'pagehide'] as const)('late committed reply cannot update the new page owner after %s', async owner => {
  const ui = await screen(); await ui.range.save();
  const pending = hold('known.roots.confirm'); byId('range-confirm').click();
  const committed = await pending.received;
  expect(committed).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  expect((await syncState.getScope(scope))?.boundaryVersion).toBe('1');
  await changeOwner(ui, owner); const current = document.body.innerHTML;
  pending.release(); await vi.waitFor(() => expect(byId('range-confirm').hasAttribute('aria-busy')).toBe(false));
  expect(document.body.innerHTML).toBe(current);
  expect(ui.onConfirmed).not.toHaveBeenCalled(); expect(ui.reloadBoundaries).not.toHaveBeenCalled();
});

test.each(['aba', 'pagehide'] as const)('late root load cannot forward a stale recovery response after %s', async owner => {
  const ui = await screen(), pending = hold('known.roots.get'), load = ui.folders.load();
  await pending.received; await changeOwner(ui, owner); const current = document.body.innerHTML;
  pending.release(); await load;
  expect(document.body.innerHTML).toBe(current); expect(ui.onConfirmed).not.toHaveBeenCalled();
});

test.each(['aba', 'pagehide'] as const)('late persisted resume cannot submit after %s', async owner => {
  const ui = await screen(); await ui.range.save();
  const previewMessage = messages.find(row => row.kind === 'known.roots.preview')!;
  const response = await handleRootRequest(previewMessage);
  if (!response.ok || !('preview' in response)) throw new Error('preview_missing');
  const resume: PublicRangeResume = { libraryId: scope.collectionId, preview: response.preview,
    request: { kind: 'known.roots.confirm', previewId: response.preview.previewId,
      treeDigest: response.preview.treeDigest, confirmationId: crypto.randomUUID() } };
  byId('range-cancel').click();
  let release!: (value: Record<string, unknown>) => void;
  const read = vi.spyOn(storage, 'get').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  ui.range.onConnection(true); await changeOwner(ui, owner);
  const current = document.body.innerHTML; release({ [STORAGE_KEY]: resume }); await Promise.resolve(); await Promise.resolve();
  expect(document.body.innerHTML).toBe(current);
  expect(messages.filter(row => row.kind === 'known.roots.confirm')).toHaveLength(0);
  expect(ui.onConfirmed).not.toHaveBeenCalled(); read.mockRestore();
});

test.each(['missing-additions', 'invalid-shift', 'wrong-preview', 'wrong-digest'] as const)(
  'malformed saved recovery data (%s) cannot create a confirmable preview', async corruption => {
  const ui = await screen(); await ui.range.save();
  const response = await handleRootRequest(messages.find(row => row.kind === 'known.roots.preview')!);
  if (!response.ok || !('preview' in response)) throw new Error('preview_missing');
  const resume = { libraryId: scope.collectionId, preview: { ...response.preview },
    request: { kind: 'known.roots.confirm', previewId: response.preview.previewId,
      treeDigest: response.preview.treeDigest, confirmationId: crypto.randomUUID() } };
  const corrupt = corruption === 'missing-additions' ? { ...resume, preview: { ...resume.preview, additions: null } }
    : corruption === 'invalid-shift' ? { ...resume, preview: { ...resume.preview, shifts: [{}] } }
      : corruption === 'wrong-preview' ? { ...resume, request: { ...resume.request, previewId: 'other-preview' } }
        : { ...resume, request: { ...resume.request, treeDigest: 'sha256:other' } };
  byId('range-cancel').click(); await storage.set({ [STORAGE_KEY]: corrupt }); ui.range.onConnection(true);
  await Promise.resolve(); await Promise.resolve(); byId('range-confirm').click(); await Promise.resolve();
  expect(byId('range-preview').hidden).toBe(true);
  expect(messages.filter(row => row.kind === 'known.roots.confirm')).toHaveLength(0);
  expect(ui.onConfirmed).not.toHaveBeenCalled();
});

test('a timed-out confirmed change reopens through real durable roots and replays the exact committed receipt', async () => {
  const ui = await screen(); await ui.range.save();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const pending = hold('known.roots.confirm'); byId('range-confirm').click();
  const response = await pending.received;
  expect(response).toMatchObject({ ok: true, confirmation: { state: 'committed' } });
  const request = messages.find(row => row.kind === 'known.roots.confirm')!;
  expect((await syncState.getBoundaryCommand(scope, request.confirmationId))?.state).toBe('committed');
  await vi.advanceTimersByTimeAsync(RANGE_CONFIRMATION_TIMEOUT_MS + 1);
  expect(byId('root-feedback').textContent).not.toBe('Folder settings saved');
  expect(ui.onConfirmed).not.toHaveBeenCalled();
  // Lose the transport reply while keeping the worker's real committed journal.
  window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); syncState.close();
  document.body.innerHTML = markup; connected = false;
  const reopened = await screen();
  await vi.waitFor(() => expect(reopened.onConfirmed).toHaveBeenCalledTimes(1));
  expect(messages.filter(row => row.kind === 'known.roots.confirm')).toEqual([request, request]);
  expect(messages.filter(row => row.kind === 'known.roots.get')).toHaveLength(2);
  expect((await syncState.getScope(scope))?.boundaryVersion).toBe('1');
  expect(byId('root-feedback').textContent).toBe('Folder settings saved');
  pending.release(); await Promise.resolve();
  expect(ui.onConfirmed).not.toHaveBeenCalled();
  expect(reopened.onConfirmed).toHaveBeenCalledTimes(1);
});

// @vitest-environment happy-dom
// A deferred onboarding draft must yield to the durable sync result.
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindFolders } from '../src/sync-folders.js';
import { bindFirstRunOnboarding } from '../src/first-run-ui.js';
import { signedInSyncStatus } from '../src/sync-label.js';
import { markFirstRunDraftStarted, popupFirstRunStatus } from '../src/first-run-draft.js';
import type { FirstRunPreviewOk, FirstRunRequest, PublicRootView } from '../src/types.js';

const rootView: PublicRootView = { viewId: 'view', status: 'ready', roots: [
  { ref: 'bar', kind: 'bookmarks_bar', title: 'Bookmarks bar', depth: 0, selected: true,
    privateLocal: false, managed: false, bookmarkCount: 2, folderCount: 1 },
  { ref: 'child', kind: 'folder', title: 'Local-only child', depth: 1, selected: false,
    privateLocal: false, managed: false, bookmarkCount: 1, folderCount: 0 },
  { ref: 'other', kind: 'other', title: 'Other bookmarks', depth: 0, selected: false,
    privateLocal: false, managed: false, bookmarkCount: 0, folderCount: 0 },
] };
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const preview = (id: string, excluded: readonly string[] = []): FirstRunPreviewOk => ({ ok: true,
  previewId: id, treeDigest: id, boundaryVersion: '1', bookmarkCount: excluded.length ? 1 : 2,
  folderCount: excluded.length ? 0 : 1, skippedCount: 0, warnings: [] });

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount(handle: (request: FirstRunRequest) => Promise<unknown>, initialValues: Record<string, unknown> = {}) {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  document.body.dataset.library = 'ready';
  const values: Record<string, unknown> = { 'known.sync.collection.v1': 'library', ...initialValues };
  const sendMessage = vi.fn(handle);
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: values[key] }),
    set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } }, runtime: { sendMessage } });
  const folders = bindFolders({ isConnected: () => true, firstRun: () => ui });
  const ui = bindFirstRunOnboarding({ rootTree: byId('root-tree'), saveRoots: byId('save-roots'),
    requestPermission: byId('request-bookmark-permission'), folderHeading: byId('folder-heading'),
    folderIntro: byId('folder-intro'), showPane: () => {} });
  await vi.waitFor(() => expect(ui.isRangeActive()).toBe(true));
  folders.render(rootView);
  await vi.waitFor(() => expect(byId<HTMLButtonElement>('first-run-start').disabled).toBe(false));
  return { ui, folders, sendMessage, values };
}

test('a user who chose Later can later finish sync without remaining setup-required forever', async () => {
  let firstRun = 'deferred';
  const f = await mount(async request => {
    const kind = (request as { kind: string }).kind;
    if (kind === 'known.personalSync.status') return { ok: true, policy: { mode: 'enabled' } };
    if (kind === 'known.sync.engine.status') return { ok: true, engine: { phase: 'idle', hasPendingWork: false } };
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun, phase: firstRun === 'completed' ? 'completed' : 'draft' };
    if (request.kind === 'known.firstRun.preview') return preview('reviewed');
    firstRun = 'completed';
    return { ok: true, firstRun, phase: 'completed' };
  }, { 'known.firstRun.draft.v1': { deferred: true, libraryId: 'library',
    selected: [{ ref: 'bar', kind: 'bookmarks_bar', title: 'Bookmarks bar', depth: 0 }], excluded: [] } });
  byId('first-run-start').click();
  await vi.waitFor(() => expect(f.ui.isRangeActive()).toBe(false));
  expect((await signedInSyncStatus()).kind).toBe('synced');
  await vi.waitFor(() => expect((f.values['known.firstRun.draft.v1'] as { deferred: boolean }).deferred).toBe(false));
});

test('a completed durable phase overrides a leftover local deferral hint', () => {
  expect(popupFirstRunStatus({ connected: true, firstRun: 'completed', phase: 'completed', deferredDraft: true,
    engine: { phase: 'idle', hasPendingWork: false } })).toBe('synced');
  expect(popupFirstRunStatus({ connected: true, firstRun: 'running', deferredDraft: true })).toBe('syncing');
});

test('starting one library does not clear another library onboarding draft', async () => {
  const saved = { deferred: true, selected: [], excluded: [], libraryId: 'another-library' };
  const write = vi.fn();
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({ 'known.firstRun.draft.v1': saved }), set: write } } });
  await markFirstRunDraftStarted('current-library');
  expect(write).not.toHaveBeenCalled();
});

test.each(['authority', 'storage'])('Later keeps its selection retryable when %s persistence fails', async (failure) => {
  const f = await mount(async request => request.kind === 'known.firstRun.status'
    ? { ok: true, firstRun: 'none', phase: 'draft' }
    : request.kind === 'known.firstRun.preview' ? preview('reviewed')
      : failure === 'authority' ? { ok: false, error: 'defer_failed' }
        : { ok: true, firstRun: 'deferred', phase: 'draft' });
  if (failure === 'storage') vi.spyOn(chrome.storage.local, 'set').mockRejectedValue(new Error('storage unavailable'));
  byId('first-run-later').click();
  await vi.waitFor(() => expect(byId('first-run-error').textContent).toContain('Could not save your choice'));
  expect(byId('first-run-error').textContent).not.toBe('Sync is off');
  expect(byId<HTMLButtonElement>('first-run-start').disabled).toBe(false);
  expect(f.values['known.firstRun.draft.v1']).not.toMatchObject({ deferred: true });
});

// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindFirstRunOnboarding } from '../src/first-run-ui.js';
import { bindOptionsSyncProgress } from '../src/sync-progress-dom.js';
import type { FirstRunPreviewOk, FirstRunRequest, PublicRootView } from '../src/types.js';
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const preview = (id: string): FirstRunPreviewOk => ({ ok: true, previewId: id, treeDigest: id, boundaryVersion: '1',
  bookmarkCount: 2, folderCount: 1, skippedCount: 0, warnings: [] });
const view = (id: string): PublicRootView => ({ viewId: id, status: 'ready', roots: [
  { ref: 'bar', kind: 'bookmarks_bar', title: 'Bookmarks bar', depth: 0, selected: true, privateLocal: false,
    managed: false, bookmarkCount: 2, folderCount: 1 },
] });
async function mount(sendMessage: (message: FirstRunRequest) => Promise<unknown>, initialValues: Record<string, unknown> = {},
  onSyncStatusChanged?: () => void) {
  const markup = await readFile('options.html', 'utf8');
  // Mount only the real page body; this controller test does not load its entry script or stylesheets.
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const values: Record<string, unknown> = { 'known.sync.collection.v1': 'library', ...initialValues };
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: values[key] }),
    set: async (patch: Record<string, unknown>) => { Object.assign(values, patch); } } }, runtime: { sendMessage } });
  const rootTree = document.getElementById('root-tree')!;
  rootTree.innerHTML = '<label class="root-select"><input type="checkbox" data-ref="bar" checked></label>';
  const ui = bindFirstRunOnboarding({ rootTree, saveRoots: document.getElementById('save-roots') as HTMLButtonElement,
    requestPermission: document.getElementById('request-bookmark-permission') as HTMLButtonElement,
    folderHeading: document.getElementById('folder-heading')!, folderIntro: document.getElementById('folder-intro')!, showPane: () => {},
    onSyncStatusChanged });
  await vi.waitFor(() => expect(ui.isRangeActive()).toBe(true));
  return { ui, values, start: document.getElementById('first-run-start') as HTMLButtonElement };
}

test('starting first sync reveals the progress card without a reload or the idle polling delay', async () => {
  let firstRun = 'none';
  let refreshProgress = () => {};
  const f = await mount(async message => {
    const kind = (message as { kind: string }).kind;
    if (kind === 'known.sync.progress.get') return { ok: true, progress: firstRun === 'none' ? null : {
      stage: firstRun === 'completed' ? 'done' : 'syncing', firstSync: true, liveWork: firstRun !== 'completed',
      bookmarks: { synced: firstRun === 'completed' ? 2 : 0, total: 2 }, folders: { synced: 1, total: 1 },
    } };
    if (kind === 'known.personalSync.status') return { ok: true, policy: { mode: 'enabled' } };
    if (kind === 'known.sync.engine.status') return { ok: true, engine: { phase: 'idle', hasPendingWork: firstRun === 'running' } };
    if (message.kind === 'known.firstRun.status') return { ok: true, firstRun, phase: firstRun === 'none' ? 'draft' : firstRun === 'running' ? 'syncing' : 'completed' };
    if (message.kind === 'known.firstRun.preview') return preview('reviewed');
    firstRun = 'running';
    return { ok: true, firstRun, phase: 'syncing' };
  }, {}, () => refreshProgress());
  f.ui.onRootsRendered(view('ready'), true, true);
  await vi.waitFor(() => expect(f.start.disabled).toBe(false));
  vi.useFakeTimers();
  const progress = bindOptionsSyncProgress({ connected: () => true });
  refreshProgress = () => { void progress.refresh(); };
  try {
    await progress.refresh();
    expect(document.getElementById('sync-progress')!.hidden).toBe(true);
    f.start.click();
    await vi.advanceTimersByTimeAsync(1);
    expect(document.getElementById('sync-progress')!.hidden).toBe(false);
    expect(document.getElementById('sync-progress-detail')!.textContent).toContain('0 of 2 bookmarks synced');
    firstRun = 'completed';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(document.getElementById('sync-progress-title')!.textContent).toBe('Sync complete');
  } finally { progress.stop(); }
});

test('a stale draft cannot override the currently bound library on reload', async () => {
  const confirmations: FirstRunRequest[] = [];
  const f = await mount(async message => {
    if (message.kind === 'known.firstRun.status') return { ok: true, firstRun: 'none', phase: 'draft' };
    if (message.kind === 'known.firstRun.preview') return preview('current');
    confirmations.push(message);
    return { ok: true, firstRun: 'running', phase: 'syncing' };
  }, { 'known.firstRun.draft.v1': { selected: [], deferred: false, libraryId: 'stale-library' } });
  f.ui.onRootsRendered(view('ready'), true, true);
  await vi.waitFor(() => expect(f.start.disabled).toBe(false));
  f.start.click();
  await vi.waitFor(() => expect(confirmations).toHaveLength(1));
  expect(confirmations[0]).toMatchObject({ kind: 'known.firstRun.confirm', libraryId: 'library' });
});

test('creating a library keeps the current sync target when selection fails', async () => {
  const confirmations: FirstRunRequest[] = [];
  const f = await mount(async message => {
    const kind = (message as { kind: string }).kind;
    if (kind === 'known.collections.create') return { ok: true, collection: { id: 'new-library', title: 'New library' } };
    if (kind === 'known.collection.select') return { ok: false, error: 'personal_sync_disconnect_required' };
    if (message.kind === 'known.firstRun.status') return { ok: true, firstRun: 'none', phase: 'draft' };
    if (message.kind === 'known.firstRun.preview') return preview('current');
    confirmations.push(message);
    return { ok: true, firstRun: 'running', phase: 'syncing' };
  });
  f.ui.onRootsRendered(view('ready'), true, true);
  await vi.waitFor(() => expect(f.start.disabled).toBe(false));
  (document.getElementById('library-create-title') as HTMLInputElement).value = 'New library';
  document.getElementById('library-create')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await vi.waitFor(() => expect((document.getElementById('library-create-submit') as HTMLButtonElement).disabled).toBe(false));
  expect(document.getElementById('collection-feedback')?.dataset.tone).toBe('error');
  expect(f.values['known.firstRun.draft.v1']).not.toMatchObject({ libraryId: 'new-library' });
  f.start.click();
  await vi.waitFor(() => expect(confirmations).toHaveLength(1));
  expect(confirmations[0]).toMatchObject({ libraryId: 'library' });
});

test('a terminal first-sync failure replaces the syncing timer with the actual stopped state', async () => {
  let stopped = false;
  const f = await mount(async message => {
    if (message.kind === 'known.firstRun.status') return stopped
      ? { ok: false, error: 'mapping_identity_collision' }
      : { ok: true, firstRun: 'none', phase: 'draft' };
    if (message.kind === 'known.firstRun.preview') return preview('reviewed');
    return { ok: true, firstRun: 'running', phase: 'syncing' };
  });
  f.ui.onRootsRendered(view('ready'), true, true);
  await vi.waitFor(() => expect(f.start.disabled).toBe(false));
  vi.useFakeTimers();
  f.start.click();
  await vi.advanceTimersByTimeAsync(1);
  stopped = true;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(document.getElementById('first-run-error')!.textContent).toContain('Sync on this device has stopped');
  await vi.advanceTimersByTimeAsync(100_000);
  expect(document.getElementById('first-run-error')!.textContent).not.toContain('still running in the background');
});
test('a later root render owns the displayed preview even when an earlier read returns last', async () => {
  const reads: Array<(value: unknown) => void> = [];
  const f = await mount(async message => message.kind === 'known.firstRun.status' ? { ok: true, firstRun: 'none', phase: 'draft' }
    : new Promise(resolve => { reads.push(resolve); }));
  f.ui.onRootsRendered(view('first'), true, true); await vi.waitFor(() => expect(reads).toHaveLength(1));
  f.ui.onRootsRendered(view('second'), true, true); await vi.waitFor(() => expect(reads).toHaveLength(2));
  reads[1]!(preview('latest')); await vi.waitFor(() => expect(f.start.disabled).toBe(false));
  reads[0]!(preview('stale')); await Promise.resolve();
  expect(document.getElementById('first-run-confirm')!.dataset.treeDigest).toBe('latest');
});
test('the merge button prevents duplicate submissions and retries the same reviewed command', async () => {
  const confirmations: Extract<FirstRunRequest, { kind: 'known.firstRun.confirm' }>[] = [];
  let finish!: (value: unknown) => void;
  const f = await mount(async message => {
    if (message.kind === 'known.firstRun.status') return { ok: true, firstRun: 'none', phase: 'draft' };
    if (message.kind === 'known.firstRun.preview') return preview('reviewed');
    if (message.kind === 'known.firstRun.confirm') { confirmations.push(message); return new Promise(resolve => { finish = resolve; }); }
    return { ok: false, error: 'unexpected' };
  });
  f.ui.onRootsRendered(view('ready'), true, true); await vi.waitFor(() => expect(f.start.disabled).toBe(false));
  f.start.click(); f.start.click(); expect(confirmations).toHaveLength(1);
  finish({ ok: false, error: 'offline' }); await vi.waitFor(() => expect(f.start.disabled).toBe(false));
  f.start.click(); expect(confirmations).toHaveLength(2);
  expect(confirmations[1]?.confirmationId).toBe(confirmations[0]?.confirmationId);
  finish({ ok: false, error: 'offline' }); await vi.waitFor(() => expect(f.start.disabled).toBe(false));
});

// @vitest-environment happy-dom
// Confirmations exercise the real options controller while transport can lose or delay replies.
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindFolders } from '../src/sync-folders.js';
import { bindFirstRunOnboarding } from '../src/first-run-ui.js';
import { excludedFolderRefs, syncRootRefs } from '../src/folder-coverage.js';
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
const input = (ref: string) => document.querySelector<HTMLInputElement>(`.root-select input[data-ref="${ref}"]`)!;
const preview = (id: string, excluded: readonly string[] = []): FirstRunPreviewOk => ({ ok: true,
  previewId: id, treeDigest: id, boundaryVersion: '1', bookmarkCount: excluded.length ? 1 : 2,
  folderCount: excluded.length ? 0 : 1, skippedCount: 0, warnings: [] });

afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount(handle: (request: FirstRunRequest) => Promise<unknown>, initialValues: Record<string, unknown> = {}, waitForStart = true) {
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
  if (waitForStart) await vi.waitFor(() => expect(byId<HTMLButtonElement>('first-run-start').disabled).toBe(false));
  return { ui, folders, sendMessage, values };
}

test('changing the picker during first confirm must not discard an accepted running result', async () => {
  let finish!: (value: unknown) => void;
  let serial = 0;
  await mount(async request => {
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun: 'none', phase: 'draft' };
    if (request.kind === 'known.firstRun.preview') return preview(`preview-${++serial}`, request.excludedRefs);
    if (request.kind === 'known.firstRun.confirm') return new Promise(resolve => { finish = resolve; });
    return { ok: false };
  });
  byId('first-run-start').click();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  vi.useFakeTimers();
  input('child').click();
  finish({ ok: true, firstRun: 'running', phase: 'syncing' });
  await vi.advanceTimersByTimeAsync(1);
  expect(document.body.dataset.firstRun).toBe('syncing');
});

test('a confirming first-run merge disables Later until its durable result is known', async () => {
  let finish!: (value: unknown) => void;
  await mount(async request => {
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun: 'none', phase: 'draft' };
    if (request.kind === 'known.firstRun.preview') return preview('reviewed');
    return new Promise(resolve => { finish = resolve; });
  });
  byId('first-run-start').click();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const disabled = byId<HTMLButtonElement>('first-run-later').disabled;
  finish({ ok: false, error: 'extension_unavailable' });
  await Promise.resolve();
  expect(disabled).toBe(true);
});

test('a lost confirmation reply is recovered by status without another user submission', async () => {
  let firstRun = 'none';
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun, phase: firstRun === 'none' ? 'draft' : 'syncing',
      ...(request.confirmationId ? { confirmation: { confirmationId: request.confirmationId, state: 'committed' } } : {}) };
    if (request.kind === 'known.firstRun.preview') return preview('reviewed');
    firstRun = 'running';
    throw new Error('the message port closed after admission');
  });
  vi.useFakeTimers();
  byId('first-run-start').click();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(document.body.dataset.firstRun).toBe('syncing');
  expect(byId<HTMLButtonElement>('first-run-later').disabled).toBe(true);
  expect(f.sendMessage.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(1);
});

test('status completes the UI even if the original callback never returns', async () => {
  let firstRun = 'none';
  await mount(async request => {
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun,
      phase: firstRun === 'none' ? 'draft' : firstRun === 'running' ? 'syncing' : 'completed',
      ...(request.confirmationId ? { confirmation: { confirmationId: request.confirmationId, state: 'committed' } } : {}) };
    if (request.kind === 'known.firstRun.preview') return preview('reviewed');
    firstRun = 'running';
    return new Promise(() => {});
  });
  vi.useFakeTimers(); byId('first-run-start').click();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(document.body.dataset.firstRun).toBe('syncing');
  firstRun = 'completed';
  await vi.advanceTimersByTimeAsync(1_001);
  expect(byId('first-run-confirm').hidden).toBe(true);
  expect(byId('root-tree').hasAttribute('inert')).toBe(false);
});

test('root rerenders cannot discard a submitted command, and changing libraries ignores its later callback', async () => {
  let finish!: (value: unknown) => void;
  const f = await mount(async request => request.kind === 'known.firstRun.status' ? { ok: true, firstRun: 'none', phase: 'draft' }
    : request.kind === 'known.firstRun.preview' ? preview('reviewed') : new Promise(resolve => { finish = resolve; }));
  byId('first-run-start').click(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.folders.render({ ...rootView, viewId: 'new-root-read' });
  expect(input('child').disabled).toBe(true);
  expect(byId<HTMLButtonElement>('refresh-roots').disabled).toBe(true);
  f.ui.setLibraryId('another-library');
  finish({ ok: true, firstRun: 'running', phase: 'syncing' });
  await Promise.resolve(); await Promise.resolve();
  expect(document.body.dataset.firstRun).not.toBe('syncing');
});

test('Later adopts a concurrently started sync instead of claiming sync is off', async () => {
  await mount(async request => request.kind === 'known.firstRun.status' ? { ok: true, firstRun: 'none', phase: 'draft' }
    : request.kind === 'known.firstRun.preview' ? preview('reviewed') : { ok: true, firstRun: 'running', phase: 'syncing' });
  byId('first-run-later').click();
  await vi.waitFor(() => expect(document.body.dataset.firstRun).toBe('syncing'));
  expect(byId('first-run-error').textContent).not.toBe('Sync is off');
});



test('another page admission refreshes authority without reporting this rejected selection as successful', async () => {
  let anotherPageStarted = false;
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.status') return { ok: true,
      firstRun: anotherPageStarted ? 'running' : 'none', phase: anotherPageStarted ? 'syncing' : 'draft',
      ...(request.confirmationId ? { confirmation: { confirmationId: request.confirmationId, state: 'missing' } } : {}) };
    if (request.kind === 'known.firstRun.preview') return preview('reviewed');
    anotherPageStarted = true; return new Promise(() => {});
  });
  vi.useFakeTimers(); byId('first-run-start').click();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(document.body.dataset.firstRun).toBe('syncing');
  expect(byId('first-run-error').textContent).toContain('Another page confirmed a different folder selection');
  expect(f.sendMessage.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toHaveLength(1);
});

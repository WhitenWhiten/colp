// @vitest-environment happy-dom
// Render the actual options markup and exercise the canonical folder selection.
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

async function mount(handle: (request: FirstRunRequest) => Promise<unknown>, initialValues: Record<string, unknown> = {}, initialView = rootView) {
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
  folders.render(initialView);
  await vi.waitFor(() => expect(byId<HTMLButtonElement>('first-run-start').disabled).toBe(false));
  return { ui, folders, sendMessage, values };
}

test('a valid root-only bookmark selection remains startable when every child folder is excluded', async () => {
  let serial = 0;
  const f = await mount(async request => request.kind === 'known.firstRun.status'
    ? { ok: true, firstRun: 'none', phase: 'draft' }
    : request.kind === 'known.firstRun.preview' ? preview(`preview-${++serial}`, request.excludedRefs) : { ok: false });
  input('child').click();
  await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledWith({ kind: 'known.firstRun.preview',
    viewId: 'view', selectedRefs: ['bar'], excludedRefs: ['child'] }));
  await vi.waitFor(() => expect(byId('first-run-totals').textContent).toContain('1 bookmark'));
  expect(syncRootRefs(byId('root-tree'))).toEqual(['bar']);
  expect(excludedFolderRefs(byId('root-tree'))).toEqual(['child']);
  expect(input('bar').indeterminate).toBe(true);
  expect(byId<HTMLButtonElement>('first-run-start').disabled).toBe(false);
});

test('choosing one root after the all-roots default explicitly removes Other from the reviewed boundary', async () => {
  const f = await mount(async request => request.kind === 'known.firstRun.status'
    ? { ok: true, firstRun: 'none', phase: 'draft' }
    : request.kind === 'known.firstRun.preview' ? preview(crypto.randomUUID(), request.excludedRefs) : { ok: false }, {},
  { ...rootView, roots: rootView.roots.map(row => ({ ...row, selected: row.depth === 0 })) });
  expect(syncRootRefs(byId('root-tree')).sort()).toEqual(['bar', 'other']);
  byId('tree-clear-selection').click(); input('bar').click();
  await vi.waitFor(() => expect(f.sendMessage.mock.calls.at(-1)?.[0]).toMatchObject({
    kind: 'known.firstRun.preview', selectedRefs: ['bar'], excludedRefs: [],
  }));
  expect(input('other').checked).toBe(false);
  expect(syncRootRefs(byId('root-tree'))).toEqual(['bar']);
  expect(f.sendMessage.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toEqual([]);
});

test.each(['permission_required', 'tree_unavailable', 'ready'] as const)('an empty %s root view invalidates a reviewed first-run plan until fresh review', async status => {
  let advancedReads = 0;
  const f = await mount(async request => {
    if (request.kind === 'known.firstRun.status') return { ok: true, firstRun: 'none', phase: 'draft' };
    if (request.kind === 'known.firstRun.preview') {
      if (!request.bootstrapMode) return preview('merge-initial');
      const id = `advanced-${++advancedReads}`;
      return { ...preview(id), advanced: { mode: 'upload', treeDigest: id, scopeFingerprint: id,
        remoteSnapshotId: id, remoteRevision: id, remoteCursor: id, destructivePlanDigest: id,
        confirmationProof: id, deletes: [] } };
    }
    if (request.kind === 'known.firstRun.confirm') return { ok: true, firstRun: 'running', phase: 'syncing' };
    throw new Error(`Undeclared message ${request.kind}`);
  });
  const mode = byId<HTMLSelectElement>('first-run-advanced-mode');
  mode.value = 'upload'; mode.dispatchEvent(new Event('change'));
  byId('first-run-advanced-preview').click();
  await vi.waitFor(() => expect(byId('first-run-advanced-confirm').hidden).toBe(false));
  expect(advancedReads).toBe(1);

  // A real folder renderer must forward empty/blocked responses too. Otherwise
  // the onboarding controller retains the former ready view and its authority.
  f.folders.render({ ...rootView, viewId: `empty-${status}`, status, roots: [] });
  expect(byId('first-run-advanced-confirm').hidden).toBe(true);
  expect(byId<HTMLButtonElement>('first-run-advanced-confirm').disabled).toBe(true);
  expect(byId<HTMLButtonElement>('first-run-start').disabled).toBe(true);
  if (status === 'permission_required') {
    expect(byId('first-run-permission-hint').hidden).toBe(false);
    f.ui.onPermissionResult(false);
    expect(byId('first-run-error').textContent).toContain('Permission was not granted');
  }
  if (status === 'ready') expect(byId('first-run-empty').textContent).toContain('No bookmark folders are available');
  else expect(byId('first-run-confirm').hidden).toBe(true);
  byId('first-run-advanced-confirm').click();
  expect(f.sendMessage.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toEqual([]);

  f.folders.render({ ...rootView, viewId: `restored-${status}` });
  expect(byId('first-run-advanced-confirm').hidden).toBe(true);
  expect(advancedReads).toBe(1);
  byId('first-run-advanced-preview').click();
  await vi.waitFor(() => expect(byId('first-run-advanced-confirm').hidden).toBe(false));
  expect(advancedReads).toBe(2);
  expect(f.sendMessage.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toEqual([]);
  byId('first-run-advanced-confirm').click();
  await vi.waitFor(() => expect(document.body.dataset.firstRun).toBe('syncing'));
  expect(f.sendMessage.mock.calls.filter(([request]) => request.kind === 'known.firstRun.confirm')).toEqual([
    [expect.objectContaining({ previewId: 'advanced-2', bootstrapMode: 'upload',
      advancedConfirmation: expect.objectContaining({ confirmationProof: 'advanced-2' }) })],
  ]);
});

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


// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { syncRootRefs, excludedFolderRefs } from '../src/folder-coverage.js';
import { bindFolders } from '../src/sync-folders.js';
import type { PublicRootNode, PublicRootView, RootRequest } from '../src/types.js';

const row = (ref: string, title: string, depth: number, over: Partial<PublicRootNode> = {}): PublicRootNode => ({
  ref, kind: depth === 0 ? 'bookmarks_bar' : 'folder', title, depth, selected: depth === 0,
  privateLocal: false, managed: false, bookmarkCount: 12, folderCount: 0, ...over });
const ready = (roots: PublicRootNode[], status: PublicRootView['status'] = 'ready'): PublicRootView => ({ viewId: 'v1', status, roots });
const tree = () => ready([
  row('bar', 'Bookmarks bar', 0, { bookmarkCount: 0, folderCount: 3 }), row('mkt', 'Marketing', 1, { folderCount: 1 }),
  row('seo', 'SEO', 2), row('prog', 'Programming', 1), row('other', 'Other bookmarks', 0, { kind: 'other', bookmarkCount: 0 }),
]);
const firstRun = { isRangeActive: vi.fn(() => false), onRootsRendered: vi.fn() };
const input = (ref: string) => document.querySelector<HTMLInputElement>(`.root-select input[data-ref="${ref}"]`)!;
const text = (id: string) => document.getElementById(id)!.textContent;
async function mount(response: (message: RootRequest) => unknown = () => ({ ok: true, view: tree() })) {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: RootRequest) => response(message)) } });
  const host = bindFolders({ isConnected: () => true, firstRun: () => firstRun });
  host.onConnection(true);
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  return host;
}
beforeEach(() => { firstRun.onRootsRendered.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('every folder syncs by default, including an empty browser root, and descendants remain editable', async () => {
  await mount();
  for (const ref of ['bar', 'mkt', 'seo', 'prog', 'other']) {
    expect(input(ref).checked).toBe(true); expect(input(ref).disabled).toBe(false);
  }
  expect(text('folder-count')).toBe('5 of 5 folders');
  expect(syncRootRefs(document.getElementById('root-tree')!)).toEqual(['bar', 'other']);
});
test('unticking a folder keeps its subtree on this browser; ticking restores it', async () => {
  await mount();
  input('mkt').click();
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toContain('mkt');
  expect(input('seo').checked).toBe(false); expect(input('seo').disabled).toBe(true);
  expect(input('bar').indeterminate).toBe(true); expect(input('other').checked).toBe(true);
  expect(text('folder-count')).toBe('3 of 5 folders');
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual(['mkt']);
  expect((document.getElementById('cancel-roots') as HTMLButtonElement).disabled).toBe(false);
  input('mkt').click();
  expect(input('seo').checked).toBe(true); expect(input('seo').disabled).toBe(false);
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual([]);
});
test('a mixed parent can include all its descendants again', async () => {
  await mount(); input('seo').click();
  expect(input('mkt').indeterminate).toBe(true); expect(input('bar').indeterminate).toBe(true);
  input('bar').click();
  expect(input('seo').checked).toBe(true);
  expect(input('bar').indeterminate).toBe(false);
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual([]);
});
test('managed folders stay read-only and there is one visible checkbox per editable folder', async () => {
  await mount(() => ({ ok: true, view: ready([row('a', 'Reading', 0), row('m', 'Managed', 0, { managed: true, exclusionReason: 'managed' })]) }));
  expect(document.querySelectorAll('.root-private')).toHaveLength(0);
  expect(input('m').disabled).toBe(true); expect(input('m').checked).toBe(false);
  expect(document.querySelector('.root-row[data-ref="m"] .badge')!.textContent).toBe('Managed');
});
test('bulk checkbox changes update the same explicit exclusion boundaries', async () => {
  await mount(); const rootTree = document.getElementById('root-tree')!, changed = vi.fn();
  rootTree.addEventListener('change', changed);
  document.getElementById('tree-invert')!.click();
  expect(Array.from(document.querySelectorAll<HTMLInputElement>('.root-select input')).every(box => !box.checked)).toBe(true);
  expect(syncRootRefs(rootTree)).toEqual(['bar', 'other']);
  document.getElementById('tree-select-level')!.click();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(text('folder-count')).toBe('5 of 5 folders');
  expect(excludedFolderRefs(rootTree)).toEqual([]);
});
test('collapsing the tree preserves unsaved exclusions', async () => {
  await mount(); input('seo').click();
  document.querySelector<HTMLButtonElement>('.root-row[data-ref="mkt"] .tree-toggle')!.click();
  expect(document.querySelector('.root-row[data-ref="seo"]')!.classList.contains('is-collapsed-child')).toBe(true);
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toContain('seo');
});
test('missing permission and failed loads retain their existing actionable alerts', async () => {
  await mount(() => ({ ok: true, view: ready([], 'permission_required') }));
  expect(document.getElementById('root-alert')!.hidden).toBe(false);
  expect(text('root-alert-copy')).toMatch(/Bookmark permission is required/);
  expect((document.getElementById('request-bookmark-permission') as HTMLButtonElement).hidden).toBe(false);
  expect(document.getElementById('folder-card')!.dataset.roots).toBe('blocked');
  await mount(() => ({ ok: false, error: 'request_invalid' }));
  expect(document.getElementById('root-alert')!.dataset.tone).toBe('danger');
  expect((document.getElementById('root-retry') as HTMLButtonElement).hidden).toBe(false);
  expect(document.body.textContent).not.toMatch(/undefined|request_invalid/u);
});
test('a deep link highlights an excluded folder without changing its sync choice', async () => {
  await mount(() => ({ ok: true, view: ready([row('a', 'Reading', 0), row('b', 'Work', 0, { privateLocal: true, preselected: true })]) }));
  expect(document.activeElement).toBe(input('b'));
  expect(input('b').checked).toBe(false);
  expect(text('root-feedback')).toContain('Work is highlighted.');
  expect(firstRun.onRootsRendered).toHaveBeenCalled();
});

test('restoring an excluded parent retains the child’s explicit exclusion', async () => {
  await mount(() => ({ ok: true, view: ready([
    row('bar', 'Bookmarks bar', 0), row('mkt', 'Marketing', 1, { privateLocal: true }),
    row('seo', 'SEO', 2, { privateLocal: true }),
  ]) }));
  input('mkt').click();
  expect(excludedFolderRefs(document.getElementById('root-tree')!)).toEqual(['seo']);
  expect(input('mkt').disabled).toBe(false);
  expect(input('seo').disabled).toBe(false);
});

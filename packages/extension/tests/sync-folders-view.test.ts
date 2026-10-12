// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { checkedRootRefs } from '../src/folder-coverage.js';
import { bindFolders } from '../src/sync-folders.js';
import type { PublicRootNode, PublicRootView, RootRequest } from '../src/types.js';

const row = (ref: string, title: string, depth: number, selected: boolean, over: Partial<PublicRootNode> = {}): PublicRootNode => ({
  ref, kind: depth === 0 ? 'bookmarks_bar' : 'folder', title, depth, selected, privateLocal: false, managed: false,
  bookmarkCount: 12, folderCount: 0, ...over });
const ready = (roots: PublicRootNode[], status: PublicRootView['status'] = 'ready'): PublicRootView => ({ viewId: 'v1', status, roots });
const tree = () => ready([
  row('bar', 'Bookmarks bar', 0, false, { bookmarkCount: 0, folderCount: 3 }), row('mkt', 'Marketing', 1, true, { folderCount: 1 }),
  row('seo', 'SEO', 2, true), row('prog', 'Programming', 1, true), row('other', 'Other bookmarks', 0, false, { kind: 'other' })]);

let host: ReturnType<typeof bindFolders>;
const firstRun = { isRangeActive: vi.fn(() => false), onRootsRendered: vi.fn() };
const input = (ref: string, kind: 'select' | 'private' = 'select') =>
  document.querySelector<HTMLInputElement>(`.root-${kind} input[data-ref="${ref}"]`)!;
const text = (id: string) => document.getElementById(id)!.textContent;

async function mount(response: (message: RootRequest) => unknown = () => ({ ok: true, view: tree() })) {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async (message: RootRequest) => response(message)) } });
  host = bindFolders({ isConnected: () => true, firstRun: () => firstRun });
  host.onConnection(true);
  await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
}
beforeEach(() => { firstRun.onRootsRendered.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('a parent shows a dash while only part of what is inside it is checked, and the line counts checked folders', async () => {
  await mount();
  expect(input('bar').indeterminate).toBe(true);
  expect(input('mkt').indeterminate).toBe(false);
  expect(input('other').indeterminate).toBe(false);
  expect(text('folder-count')).toBe('3 of 5 folders');
  input('prog').click();
  expect(text('folder-count')).toBe('2 of 5 folders');
  input('mkt').click();
  expect(input('bar').indeterminate).toBe(false);
  expect(text('folder-count')).toBe('0 of 5 folders');
  input('bar').click();
  expect(input('bar').checked).toBe(true);
  expect(input('bar').indeterminate).toBe(false);
});

test('checking a folder checks the folders inside it, and unchecking it clears them again', async () => {
  await mount();
  // SEO sits inside the checked Marketing: ticked, locked, and saying why.
  expect(input('seo').checked).toBe(true);
  expect(input('seo').disabled).toBe(true);
  expect((input('seo').closest('label') as HTMLElement).title).toBe('Syncs with Marketing. To leave it out, choose No Know-N sync.');
  input('bar').click();
  expect(['mkt', 'seo', 'prog'].map((ref) => [input(ref).checked, input(ref).disabled])).toEqual([[true, true], [true, true], [true, true]]);
  expect((input('mkt').closest('label') as HTMLElement).title).toBe('Syncs with Bookmarks bar. To leave it out, choose No Know-N sync.');
  expect(text('folder-count')).toBe('4 of 5 folders');
  input('bar').click();
  expect(['mkt', 'seo', 'prog'].map((ref) => [input(ref).checked, input(ref).disabled])).toEqual([[false, false], [false, false], [false, false]]);
  expect(text('folder-count')).toBe('0 of 5 folders');
  expect(input('seo').closest('label')!.hasAttribute('title')).toBe(false);
});

test('only the folders the user checked are sent, so a preview never lists a folder twice', async () => {
  await mount();
  expect(checkedRootRefs(document.getElementById('root-tree')!)).toEqual(['mkt', 'prog']);
  input('bar').click();
  expect(checkedRootRefs(document.getElementById('root-tree')!)).toEqual(['bar']);
});

test('No Know-N sync keeps a folder out of its parent', async () => {
  await mount();
  input('seo', 'private').click();
  expect(input('seo').checked).toBe(false);
  expect(input('seo').disabled).toBe(true);
  expect((input('seo').closest('label') as HTMLElement).title).toBe('Kept out of sync with No Know-N sync.');
  expect(text('folder-count')).toBe('2 of 5 folders');
  expect(checkedRootRefs(document.getElementById('root-tree')!, 'private')).toEqual(['seo']);
});

test('Cancel is live only while the tree differs from what was loaded, and puts it back', async () => {
  await mount();
  const cancel = document.getElementById('cancel-roots') as HTMLButtonElement;
  expect(cancel.disabled).toBe(true);
  input('prog').click();
  expect(cancel.disabled).toBe(false);
  cancel.click();
  expect(input('prog').checked).toBe(true);
  expect((document.getElementById('cancel-roots') as HTMLButtonElement).disabled).toBe(true);
});

test('every folder keeps its No Know-N sync box, and the managed one is disabled with a badge', async () => {
  await mount(() => ({ ok: true, view: ready([row('a', 'Reading', 0, true), row('m', 'Mobile bookmarks', 0, false, { managed: true, exclusionReason: 'managed' })]) }));
  expect(document.querySelectorAll('.root-private input')).toHaveLength(2);
  expect(document.querySelector('.root-private')!.textContent).toBe('No Know-N sync');
  expect(input('m').disabled).toBe(true);
  expect(document.querySelector('.root-row[data-ref="m"] .badge')!.textContent).toBe('Managed');
  input('a', 'private').click();
  expect(input('a', 'private').checked).toBe(true);
  expect((document.getElementById('cancel-roots') as HTMLButtonElement).disabled).toBe(false);
});

test('Select all and Invert tell the page, so a first-sync preview and the dashes follow', async () => {
  await mount();
  const changed = vi.fn();
  document.getElementById('root-tree')!.addEventListener('change', changed);
  (document.getElementById('tree-select-level') as HTMLButtonElement).click();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(Array.from(document.querySelectorAll<HTMLInputElement>('.root-select input')).every((box) => box.checked)).toBe(true);
  expect(text('folder-count')).toBe('5 of 5 folders');
  (document.getElementById('tree-invert') as HTMLButtonElement).click();
  expect(Array.from(document.querySelectorAll<HTMLInputElement>('.root-select input')).some((box) => box.checked)).toBe(false);
});

test('folding a folder hides what is inside it without discarding unsaved ticks', async () => {
  await mount();
  input('prog').click();
  document.querySelector<HTMLButtonElement>('.root-row[data-ref="mkt"] .tree-toggle')!.click();
  expect(document.querySelector('.root-row[data-ref="seo"]')!.classList.contains('is-collapsed-child')).toBe(true);
  expect(document.querySelector('.root-row[data-ref="mkt"] .tree-toggle')!.getAttribute('aria-expanded')).toBe('false');
  expect(input('prog').checked).toBe(false);
  // A folded row is skipped by Select all, so it cannot be changed unseen; it is checked only as part of its parent.
  (document.getElementById('tree-select-level') as HTMLButtonElement).click();
  expect(input('seo').checked).toBe(true);
  expect(input('seo').dataset.inherited).toBe('');
});

test('a missing permission is one alert with Allow and no list card; a failed load is one danger alert with Retry', async () => {
  await mount(() => ({ ok: true, view: ready([], 'permission_required') }));
  const alert = document.getElementById('root-alert')!;
  expect(alert.hidden).toBe(false);
  expect(text('root-alert-copy')).toMatch(/Bookmark permission is required/);
  expect((document.getElementById('request-bookmark-permission') as HTMLButtonElement).hidden).toBe(false);
  expect(document.getElementById('folder-card')!.dataset.roots).toBe('blocked');
  expect((document.getElementById('save-roots') as HTMLButtonElement).hidden).toBe(true);

  await mount(() => ({ ok: false, error: 'request_invalid' }));
  expect(document.getElementById('root-alert')!.dataset.tone).toBe('danger');
  expect(text('root-alert-copy')).toBe('Folder settings could not be loaded. Try again.');
  expect((document.getElementById('root-retry') as HTMLButtonElement).hidden).toBe(false);
  expect(document.body.textContent).not.toMatch(/undefined|request_invalid/u);
});

test('the deep-linked folder arrives checked and says what to do next', async () => {
  await mount((message) => ({ ok: true, view: ready([row('a', 'Reading', 0, false), row('b', 'Work', 0, true, { preselected: true })]), seen: message }));
  expect(text('root-feedback')).toBe('Work is checked — choose Review changes to start syncing it.');
  expect(firstRun.onRootsRendered).toHaveBeenCalled();
});

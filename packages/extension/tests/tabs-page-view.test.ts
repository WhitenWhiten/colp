// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, over: Record<string, unknown> = {}) => ({ itemId: uuid(n), commandId: uuid(100 + n), tabIds: [n], title: `Tab ${n}`, url: `https://site${n}.example/x`,
  reason: null, existence: null, captureId: null, ...over });
const batch = (items: unknown[], over: Record<string, unknown> = {}) => ({ batchId: uuid(900), scope: {}, windowId: 1, selection: 'all', tabsPermission: true, createdAt: 1,
  confirmed: false, selectedIds: [], saveAnotherIds: [], targetNativeId: null, items, ...over });
const exact = [{ nativeId: 'n-1', nodeId: null, collectionId: null, collectionTitle: null, path: ['Bookmarks bar'], writable: true, url: 'https://site3.example/x' }];

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.replaceChildren(); });

async function mount(current: unknown, { bookmarks = true, tasks = [] as unknown[], folders = undefined as ReturnType<typeof workspaceFolderTree> | undefined } = {}) {
  const markup = await readFile('capture-tabs.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const send = vi.fn(async (message: { kind: string }) => message.kind.startsWith('known.capture.batch.') ? { ok: true, batch: current, tasks } : { defaultFolderId: 'f2' });
  const node = (id: string, title: string, children?: unknown[]) => ({ id, title, parentId: id === '0' ? undefined : '0', children });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send, getURL: (path: string) => `chrome-extension://x/${path.replace(/^\//u, '')}`, getManifest: () => ({ version: '1' }) },
    permissions: { contains: vi.fn(async () => bookmarks), request: vi.fn(async () => true) },
    bookmarks: { getTree: vi.fn(async () => folders ?? [node('0', '', [{ ...node('f1', 'Bookmarks bar', [node('f2', 'Reading')]), folderType: 'bookmarks-bar' }])]) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined), onChanged: { addListener: vi.fn() } }, onChanged: { addListener: vi.fn() } },
    i18n: { getMessage: () => '', getUILanguage: () => 'en' } });
  await import('../src/capture/tabs-page.js');

  await vi.waitFor(() => expect(document.querySelectorAll('.tabs-row').length).toBeGreaterThan(0));
}
const byId = (id: string) => document.getElementById(id)!;

test('batch destinations exclude browser workspace containers while keeping ordinary same-name folders', async () => {
  await mount(batch([item(1)]), { folders: workspaceFolderTree() });
  const target = byId('tabs-target') as HTMLSelectElement;
  expect(Array.from(target.options, option => option.value)).toEqual(['1', 'a', 'user-workspace', '2', 'b']);
});

test('each tab is a list row with its title and address; the foot counts and names the save', async () => {
  await mount(batch([item(1), item(2), item(3, { existence: { kind: 'local', exact, similar: [], coverage: {} } }), item(4, { reason: 'unsupported', url: 'chrome://extensions/' })]));
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.list-row.tabs-row'));
  expect(rows).toHaveLength(4);
  expect(rows[0]!.querySelector('.tabs-row-title')!.textContent).toBe('Tab 1');
  expect(rows[0]!.querySelector('.tabs-row-detail')!.textContent).toBe('site1.example');
  expect(byId('tabs-count').textContent).toBe('2 of 3 tabs selected');
  expect(byId('tabs-confirm').textContent).toBe('Save 2 tabs');
  expect(byId('tabs-target')).toBeInstanceOf(HTMLSelectElement);
  expect((byId('tabs-target') as HTMLSelectElement).value).toBe('f2');
  // An already-saved tab starts unchecked and offers another copy; an unsupported one cannot be picked.
  expect(rows[2]!.querySelector<HTMLInputElement>('.tabs-pick input')!.checked).toBe(false);
  expect(rows[2]!.querySelector('.tabs-another')!.textContent).toMatch(/Save another copy/);
  expect(rows[3]!.querySelector<HTMLInputElement>('.tabs-pick input')!.disabled).toBe(true);
  expect(rows[3]!.dataset.state).toBe('unavailable');
});

test('Invert and Select all move the count; the filter hides rows without losing the choice', async () => {
  await mount(batch([item(1), item(2), item(3)]));
  byId('tabs-invert').click();
  expect(byId('tabs-count').textContent).toBe('0 of 3 tabs selected');
  expect((byId('tabs-confirm') as HTMLButtonElement).disabled).toBe(true);
  byId('tabs-all').click();
  expect(byId('tabs-count').textContent).toBe('3 of 3 tabs selected');
  const search = byId('tabs-search') as HTMLInputElement;
  search.value = 'tab 2'; search.dispatchEvent(new Event('input'));
  expect(document.querySelectorAll('.tabs-row')).toHaveLength(1);
  expect(byId('tabs-count').textContent).toBe('3 of 3 tabs selected');
});

test('missing tab access is one alert with Allow, and the status line stays quiet', async () => {
  await mount(batch([item(1)], { tabsPermission: false }));
  expect(byId('tabs-tab-alert').hidden).toBe(false);
  expect(byId('tabs-bookmark-alert').hidden).toBe(true);
  // The lede already says what to do, so the status line stays empty until a save is running.
  expect(byId('tabs-status').textContent).toBe('');
});

test('missing bookmark access is one alert with Allow', async () => {
  await mount(batch([item(1)]), { bookmarks: false });
  expect(byId('tabs-bookmark-alert').hidden).toBe(false);
  expect(byId('tabs-bookmark-grant').textContent).toBe('Allow bookmark access');
});

test('a confirmed batch shows the saved state in words and offers to resume', async () => {
  const task = { captureId: uuid(500), save: 'local-saved', sync: 'pending', disposition: 'created', localLocation: { path: ['Bookmarks bar', 'Reading'] } };
  await mount(batch([item(1, { captureId: uuid(500) }), item(2)], { confirmed: true, selectedIds: [uuid(1)] }), { tasks: [task] });
  expect(byId('tabs-resume').hidden).toBe(false);
  expect(byId('tabs-confirm').hidden).toBe(true);
  expect(document.querySelector('.tabs-row-detail')!.textContent).not.toMatch(/local-saved|pending/u);
  expect(document.querySelector<HTMLAnchorElement>('.tabs-extras a')!.getAttribute('href')).toBe(`options.html#history?task=${uuid(500)}`);
  expect(byId('tabs-status').textContent).toMatch(/Saving in the background/);
});

test('the page has no sidebar and goes back to Bookmarks', async () => {
  await mount(batch([item(1)]));
  expect(document.querySelector('.side, .topbar')).toBeNull();
  expect(byId('tabs-back').getAttribute('href')).toBe('options.html#bookmarks');
});

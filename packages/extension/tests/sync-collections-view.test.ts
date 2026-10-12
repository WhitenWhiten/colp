// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindCollections, COLLECTION_BINDING } from '../src/sync-collections.js';
import type { ExtensionRequest } from '../src/types.js';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); delete document.body.dataset.collection; });

type StorageListener = (changes: Record<string, { newValue?: unknown; oldValue?: unknown }>, area: string) => void;
const listeners: StorageListener[] = [];
afterEach(() => { listeners.length = 0; });

async function mount(list: unknown, bound: string | undefined = 'col-a') {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const store: Record<string, unknown> = bound ? { [COLLECTION_BINDING]: bound } : {};
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: (listener: StorageListener) => { listeners.push(listener); } }, local: { get: async (key: string) => ({ [key]: store[key] }), set: async (patch: Record<string, unknown>) => { Object.assign(store, patch); } } },
    runtime: { sendMessage: vi.fn(async () => list) }, tabs: { create: vi.fn(async () => ({})) },
  });
  const request = vi.fn(async (message: ExtensionRequest) => {
    if (message.kind === 'known.collection.select') store[COLLECTION_BINDING] = message.collectionId;
    return { ok: true, state: { status: 'connected' } } as never;
  });
  const titles: string[] = [];
  const picked: string[] = [];
  const opened: string[] = [];
  const view = bindCollections({ isConnected: () => true, accountLabel: () => 'whiten', request, serverOrigin: () => 'https://know-n.test',
    emptyCopy: () => 'Name the collection this device will sync.', onSelected: (id) => picked.push(id), onTitle: (title) => titles.push(title),
    showAccount: () => undefined, openFolders: () => { opened.push('folders'); } });
  document.body.dataset.state = 'connected';
  await view.load(true);
  return { view, request, titles, picked, opened };
}
const two = { ok: true, collections: [{ id: 'col-a', title: 'Reading list', kind: 'bookmarks' }, { id: 'col-b', title: 'Work', kind: 'bookmarks' }] };

test('the chosen collection says Syncing here and every other row offers one button', async () => {
  const f = await mount(two);
  const rows = Array.from(document.querySelectorAll<HTMLElement>('.collection-row'));
  expect(rows.map((row) => row.querySelector('.set-row-title')!.textContent)).toEqual(['Reading list', 'Work']);
  expect(rows[0]!.getAttribute('aria-current')).toBe('true');
  expect(rows[0]!.querySelector<HTMLElement>('[data-role="here"]')!.hidden).toBe(false);
  expect(rows[0]!.querySelector<HTMLElement>('.collection-choice')!.hidden).toBe(true);
  expect(rows[1]!.querySelector<HTMLElement>('.collection-choice')!.textContent).toBe('Use this collection');
  expect(rows[1]!.hasAttribute('aria-current')).toBe(false);
  expect(rows[0]!.querySelector('.avatar')!.textContent).toBe('R');
  expect(f.titles.at(-1)).toBe('Reading list');
  expect(document.body.dataset.collection).toBe('ready');
  expect(document.body.textContent).not.toMatch(/Saves go here|Not selected/u);
});

test('Use this collection selects it, says so and moves the mark', async () => {
  const f = await mount(two);
  document.querySelector<HTMLButtonElement>('.collection-choice[data-id="col-b"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
  expect(document.querySelector('dialog')!.textContent).toContain('Tags, notes and folder descriptions you add in this browser can sync');
  expect(document.querySelector('dialog')!.textContent).not.toContain('0 tag assignments');
  Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent === 'Keep metadata local')!.click();
  await vi.waitFor(() => expect(document.getElementById('collection-feedback')!.textContent).toBe('Collection selected.'));
  expect(f.request).toHaveBeenCalledWith({ kind: 'known.collection.select', collectionId: 'col-b', userGesture: true });
  expect(f.picked).toEqual(['col-b']);
  await vi.waitFor(() => expect(document.querySelector('.collection-row[data-id="col-b"]')!.getAttribute('aria-current')).toBe('true'));
  expect(document.querySelector('.collection-row[data-id="col-a"]')!.hasAttribute('aria-current')).toBe(false);
});

test('before the first sync the chosen row says Selected, and choosing continues to Folders', async () => {
  const f = await mount(two);
  vi.mocked(chrome.runtime.sendMessage).mockImplementation((async (message: { kind: string }) =>
    message.kind === 'known.firstRun.status' ? { ok: true, firstRun: 'none', phase: 'draft' } : two) as never);
  await f.view.renderSelected();
  expect(document.querySelector('.collection-row[data-id="col-a"] [data-role="here-label"]')!.textContent).toBe('Selected');
  document.querySelector<HTMLButtonElement>('.collection-choice[data-id="col-b"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
  Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent === 'Keep metadata local')!.click();
  await vi.waitFor(() => expect(f.opened).toEqual(['folders']));
});

test('a disconnect clears the earlier selection message', async () => {
  await mount(two);
  document.querySelector<HTMLButtonElement>('.collection-choice[data-id="col-b"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('dialog[open]')).not.toBeNull());
  Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent === 'Keep metadata local')!.click();
  await vi.waitFor(() => expect(document.getElementById('collection-feedback')!.textContent).toBe('Collection selected.'));
  for (const listener of listeners) listener({ [COLLECTION_BINDING]: { oldValue: 'col-b' } }, 'local');
  expect(document.getElementById('collection-feedback')!.textContent).toBe('');
});

test('a new collection opens an inline form that Cancel closes again', async () => {
  await mount(two);
  const form = document.getElementById('library-create') as HTMLFormElement;
  const fresh = document.getElementById('library-new')!;
  expect(form.hidden).toBe(true);
  document.getElementById('library-create-open')!.click();
  expect(form.hidden).toBe(false);
  expect(document.activeElement?.id).toBe('library-create-title');
  document.getElementById('library-create-cancel')!.click();
  expect(form.hidden).toBe(true);
  expect(fresh.hidden).toBe(false);
});

test('with no collections the list is one empty line and the create form leads', async () => {
  await mount({ ok: true, collections: [] }, '');
  expect(document.getElementById('collection-grid')!.hidden).toBe(true);
  expect(document.getElementById('collection-empty-copy')!.textContent).toBe('Name the collection this device will sync.');
  expect(document.body.dataset.collection ?? '').toBe('');
  expect((document.getElementById('goto-folders') as HTMLButtonElement).hidden).toBe(true);
});

test('a failed list is a plain sentence, never a code', async () => {
  await mount({ ok: false, error: 'collections_unavailable' });
  expect(document.getElementById('collection-empty')!.hidden).toBe(false);
  expect(document.getElementById('collection-empty-copy')!.textContent).toBe('Collections could not be loaded. Refresh the list to try again.');
});

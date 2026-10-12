// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { createCaptureControlView } from '../src/capture/control-view.js';
import { workspaceFolderTree } from './fixtures/workspace-folders.js';

vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set<string>() }));

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

const view = (over: Record<string, unknown> = {}) => ({ ok: true, scopeKey: 's', mode: 'automatic', pending: false, state: 'automatic', permission: true, signedIn: true, local: false,
  control: { paused: false, generation: 1, lastCommand: null, consent: null }, classificationState: 'automatic', targetError: null,
  target: { nativeId: 'f', path: ['Programming'], inRange: true, collectionId: 'c', collectionTitle: 'Reading list' },
  counts: { resumable: 2, suggestions: 1, checking: 0, manual: 0 }, ...over });

async function mount(response: unknown) {
  document.body.innerHTML = '<div data-capture-controls></div><div data-capture-authorization></div><div data-capture-default-target></div>';
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => response) }, storage: { local: { get: async () => ({}), set: async () => undefined, remove: async () => undefined }, onChanged: { addListener() {} } } });
  const controls = createCaptureControlView(document.body);
  await controls.activate();
  return document.querySelector<HTMLElement>('[data-capture-controls]')!;
}
const rows = (card: HTMLElement) => Array.from(card.querySelectorAll<HTMLElement>('.set-row')).filter((row) => !row.hidden);

test('History starts with two rows: where saves go, and folder suggestions with what is waiting', async () => {
  const card = await mount(view());
  const [saves, suggestions] = rows(card);
  expect(rows(card)).toHaveLength(2);
  expect(saves!.querySelector('.set-row-title')?.textContent).toBe('Saves go to');
  expect(saves!.querySelector('.set-row-value')?.textContent).toBe('Reading list › Programming');
  expect(saves!.querySelector('a')?.textContent).toBe('Change');
  expect(saves!.querySelector('.set-row-hint')?.hasAttribute('hidden')).toBe(true);
  expect(suggestions!.querySelector('.set-row-title')?.textContent).toBe('Folder suggestions');
  expect(suggestions!.querySelector('.set-row-hint')?.textContent).toBe('2 waiting · 1 to review');
  expect(Array.from(suggestions!.querySelectorAll('.set-row-control > *:not([hidden])')).map((node) => node.textContent)).toEqual(['Review', 'Pause']);
  expect(card.textContent).not.toMatch(/This browser|updated|undefined/u);
});

test('paused suggestions say so and offer Resume instead of Pause', async () => {
  const card = await mount(view({ control: { paused: true, generation: 1, lastCommand: null, consent: null }, counts: { resumable: 0, suggestions: 0, checking: 0, manual: 0 } }));
  const suggestions = rows(card)[1]!;
  expect(suggestions.querySelector('.set-row-hint')?.textContent).toBe('Paused');
  expect(Array.from(suggestions.querySelectorAll('.set-row-control > *:not([hidden])')).map((node) => node.textContent)).toEqual(['Resume']);
});

test('in manual mode there is only the destination row', async () => {
  const card = await mount(view({ mode: 'manual', state: 'manual' }));
  expect(rows(card)).toHaveLength(1);
});

test('the default-folder editor omits workspace containers and their descendants', async () => {
  await mount(view());
  Object.assign(chrome, { bookmarks: { getTree: async () => workspaceFolderTree() } });
  const change = document.querySelector<HTMLButtonElement>('[data-capture-default-target] button');
  expect(change).toBeDefined(); change!.click();
  await vi.waitFor(() => expect(document.getElementById('capture-default-folder')).not.toBeNull());
  const select = document.getElementById('capture-default-folder') as HTMLSelectElement;
  await vi.waitFor(() => expect(select.options.length).toBe(5));
  expect(Array.from(select.options, option => option.value)).toEqual(['1', 'a', 'user-workspace', '2', 'b']);
});

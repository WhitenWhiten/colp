// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { showManualCaptureExistence } from '../src/capture/manual-existence.js';
import { setAnnotationStore, type AnnotationStore } from '../src/popup-annotations.js';
import { bindEditExisting } from '../src/popup-edit-existing.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';

const URL_A = 'https://example.org/a';
type Node = { id: string; title: string; url?: string; parentId?: string; dateAdded?: number };
const nodes: Record<string, Node> = {
  bm: { id: 'bm', title: 'Saved name', url: URL_A, parentId: 'reading', dateAdded: Date.UTC(2026, 8, 28, 12) },
  reading: { id: 'reading', title: 'Reading', parentId: '1' },
  work: { id: 'work', title: 'Work', parentId: '1' },
};
const native = (writable = true) => ({ nativeId: 'bm', nodeId: null, collectionId: null, collectionTitle: null,
  path: ['Bookmarks bar', 'Reading'], writable, url: URL_A });

function stubChrome(exact: unknown[]) {
  const api = {
    get: vi.fn(async (id: string) => (nodes[id] ? [nodes[id]] : [])),
    update: vi.fn(async () => undefined), move: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
  };
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => ({ ok: true, existence: { exact } })) },
    bookmarks: api,
    storage: { session: { remove: vi.fn(async () => undefined), get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
  });
  return api;
}

function fakeStore(saved: { tags: string[]; note: string | null } | null = null) {
  const store = { get: vi.fn(async () => saved && { nativeId: 'bm', url: URL_A, tags: saved.tags, note: saved.note, updatedAt: 1, version: 1 }),
    save: vi.fn(async () => null), tagCounts: vi.fn(async () => []), close: vi.fn() };
  setAnnotationStore(store as unknown as AnnotationStore);
  return store;
}

function mount(opts: { picked?: boolean; touched?: boolean } = {}) {
  mountPopupShell();
  const folders = { chosen: 'other', adopt: vi.fn(async (id: string) => { folders.chosen = id; }),
    userPicked: () => opts.picked === true, chosenFolderId: () => folders.chosen, setParentVisible: vi.fn() };
  const commitFolder = vi.fn(async () => undefined);
  const setFeedback = vi.fn();
  const fields = { tags: [] as string[], note: '' };
  const annotation = { read: () => ({ tags: fields.tags, note: fields.note }),
    write: vi.fn((next: { tags: readonly string[]; note: string }) => { fields.tags = [...next.tags]; fields.note = next.note; }),
    touched: () => opts.touched === true };
  const title = byId<HTMLTextAreaElement>('tab-title');
  title.value = 'Tab title';
  const save = byId<HTMLButtonElement>('save');
  save.disabled = false;
  const edit = bindEditExisting({ titleInput: title, tabTitle: () => 'Tab title', save, remove: byId<HTMLButtonElement>('remove-bookmark'),
    folders, commitFolder, setFeedback, annotation });
  const close = vi.spyOn(window, 'close').mockImplementation(() => undefined);
  return { edit, folders, commitFolder, setFeedback, close, fields, annotation, title, save,
    remove: byId<HTMLButtonElement>('remove-bookmark'), footer: byId('popup-foot'), status: byId('capture-status') };
}

afterEach(() => {
  setAnnotationStore(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete document.body.dataset.existing;
});

test('one writable saved copy opens the native edit mode: its name, folder, tags and note, Remove · Done', async () => {
  stubChrome([native()]);
  fakeStore({ tags: ['mcp'], note: 'Compare later' });
  const { folders, title, remove, save, footer, status, fields } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(folders.adopt).toHaveBeenCalledWith('reading'));
  expect(title.value).toBe('Saved name');
  expect(remove.hidden).toBe(false);
  expect(save.textContent).toBe('Done');
  expect(save.getAttribute('aria-disabled')).not.toBe('true');
  expect(footer.dataset.mode).toBe('existing');
  expect(document.body.dataset.existing).toBe('edit');
  expect(status.hidden).toBe(false);
  expect(byId('capture-status-text').textContent).toBe('Already saved');
  expect(byId('capture-status-meta').textContent).not.toBe('');
  expect(folders.setParentVisible).toHaveBeenLastCalledWith(true);
  expect(fields).toEqual({ tags: ['mcp'], note: 'Compare later' });
});

test('a typed title, a picked folder and typed tags are never overwritten', async () => {
  stubChrome([native()]);
  fakeStore({ tags: ['saved'], note: 'Saved note' });
  const { folders, title, annotation } = mount({ picked: true, touched: true });
  title.value = 'My own words';
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(document.getElementById('capture-existing-locations')?.dataset.editNativeId).toBe('bm'));
  expect(title.value).toBe('My own words');
  expect(folders.adopt).not.toHaveBeenCalled();
  expect(annotation.write).not.toHaveBeenCalled();
});

test.each([
  ['several copies', [native(), { ...native(), nativeId: 'bm2' }]],
  ['a cloud-only copy', [{ ...native(), nativeId: null, nodeId: 'n1', collectionId: 'c' }]],
  ['a managed copy', [native(false)]],
])('%s only reports where it is saved: no Remove, Done just closes', async (_label, exact) => {
  stubChrome(exact);
  fakeStore();
  const { remove, save, edit, footer, close } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(document.body.dataset.existing).toBe('view'));
  expect(remove.hidden).toBe(true);
  expect(save.textContent).toBe('Done');
  expect(footer.dataset.mode).toBe('existing');
  expect(await edit.submit('Saved name', URL_A)).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

test('Done renames and moves the existing bookmark through native calls and keeps changed tags and note', async () => {
  const api = stubChrome([native()]);
  const store = fakeStore({ tags: ['mcp'], note: 'old' });
  const { edit, folders, commitFolder, close, fields } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(folders.adopt).toHaveBeenCalled());
  folders.chosen = 'work';
  fields.tags = ['mcp', 'agents']; fields.note = 'new note';
  expect(await edit.submit('Renamed', URL_A)).toBe(true);
  expect(api.update).toHaveBeenCalledWith('bm', { title: 'Renamed' });
  expect(api.move).toHaveBeenCalledWith('bm', { parentId: 'work' });
  expect(commitFolder).toHaveBeenCalledOnce();
  expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'bm', url: URL_A, dateAdded: nodes.bm!.dateAdded }),
    { tags: ['mcp', 'agents'], note: 'new note' }, { preserveTags: true, base: { tags: ['mcp'], note: 'old' } });
  expect(close).toHaveBeenCalledOnce();
});

test('Done with nothing changed makes no bookmark or store calls', async () => {
  const api = stubChrome([native()]);
  const store = fakeStore({ tags: ['mcp'], note: 'note' });
  const { edit, folders, close } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(folders.adopt).toHaveBeenCalled());
  expect(await edit.submit('Saved name', URL_A)).toBe(true);
  expect(api.update).not.toHaveBeenCalled();
  expect(api.move).not.toHaveBeenCalled();
  expect(store.save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test('Done that cannot keep the tags says so and stays open', async () => {
  stubChrome([native()]);
  const store = fakeStore({ tags: [], note: null });
  store.save.mockRejectedValue(new Error('quota'));
  const { edit, folders, close, fields, setFeedback } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(folders.adopt).toHaveBeenCalled());
  fields.tags = ['agents'];
  await edit.submit('Saved name', URL_A);
  expect(setFeedback).toHaveBeenCalledWith("Couldn't save the changes. Try again.", 'error');
  expect(close).not.toHaveBeenCalled();
});

test('an edited URL or "Save another copy" falls back to an ordinary save', async () => {
  stubChrome([native()]);
  fakeStore();
  const { edit, folders, remove, save, footer } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(folders.adopt).toHaveBeenCalled());
  expect(await edit.submit('Saved name', 'https://example.org/b')).toBe(false);
  const another = document.getElementById('capture-save-another') as HTMLInputElement;
  another.checked = true;
  another.dispatchEvent(new Event('change', { bubbles: true }));
  expect(remove.hidden).toBe(true);
  expect(save.textContent).toBe('Save');
  expect(footer.dataset.mode).toBe('manual');
  expect(document.body.dataset.existing).toBe('copy');
  expect(await edit.submit('Saved name', URL_A)).toBe(false);
});

test('Remove uses the durable manager journal and offers Undo without closing', async () => {
  const api = stubChrome([native()]); fakeStore();
  const { folders, remove, close, setFeedback } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(folders.adopt).toHaveBeenCalled());
  const send = vi.mocked(chrome.runtime.sendMessage);
  send.mockResolvedValueOnce({ ok: true, preview: { digest: 'digest' } });
  send.mockResolvedValueOnce({ ok: true, status: { planId: 'plan', commandId: 'delete-command', applied: 1 } });
  remove.click(); await vi.waitFor(() => expect(remove.textContent).toBe('Undo'));
  expect(api.remove).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.batch.confirm', nativeIds: ['bm'], previewDigest: 'digest' }));
  send.mockResolvedValueOnce({ ok: false, error: 'undo_failed' }); remove.click();
  await vi.waitFor(() => expect(setFeedback).toHaveBeenCalledWith("Couldn't remove the bookmark. Try again.", 'error'));
  expect(close).not.toHaveBeenCalled();
  send.mockResolvedValueOnce({ ok: true, status: { undone: 1 } }); remove.click();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.batch.undo', planId: 'plan', commandId: 'delete-command' }));
});

test('when the page stops being saved the status and footer go back to a new save', async () => {
  stubChrome([native()]);
  fakeStore();
  const { folders, footer, status, remove } = mount();
  await showManualCaptureExistence(URL_A);
  await vi.waitFor(() => expect(folders.adopt).toHaveBeenCalled());
  chrome.runtime.sendMessage = vi.fn(async () => ({ ok: true, existence: { exact: [] } })) as never;
  await showManualCaptureExistence(URL_A);
  expect(footer.dataset.mode).toBe('manual');
  expect(status.hidden).toBe(true);
  expect(remove.hidden).toBe(true);
  expect(document.body.dataset.existing).toBeUndefined();
});

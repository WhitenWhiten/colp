import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openFolderEditor } from '../src/bookmark-manager-editor.js';
import { createFolderDescriptionStore } from '../src/folder-description-store.js';
import { createManagerNode } from '../src/bookmark-manager-create.js';

let window: Window;
beforeEach(() => {
  window = new Window(); vi.stubGlobal('document', window.document); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => { throw new Error('offline'); }) } });
});
afterEach(async () => { await window.happyDOM.close(); vi.unstubAllGlobals(); });

test('a signed-out offline user edits the existing folder description without a native title change', async () => {
  const node = { id: '10', title: 'Tools', dateAdded: 100 }, store = createFolderDescriptionStore();
  try {
    await store.save(node, 'Before');
    const update = vi.fn(), refresh = vi.fn(async () => undefined), feedback = vi.fn();
    openFolderEditor(node, { api: { get: async () => [node], update } as never, annotations: {} as never, root: () => undefined, excluded: async () => new Set(), refresh, feedback });
    const dialog = document.querySelector('dialog.mgr-editor')!;
    const description = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    await vi.waitFor(() => expect(description.disabled).toBe(false)); expect(description.value).toBe('Before');
    description.value = 'Developer tools and documentation';
    dialog.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(update).not.toHaveBeenCalled();
    expect((await store.get(node))?.description).toBe('Developer tools and documentation');
    expect(feedback).toHaveBeenCalledWith('Folder saved.', 'ok');
  } finally { store.close(); }
});

test('new folder descriptions are saved locally before a best-effort sync notice', async () => {
  const node = { id: '20', title: 'Tools', dateAdded: 200 }, create = vi.fn(async () => node);
  await createManagerNode({ create }, '1', node.title, undefined, 'Developer tools');
  const store = createFolderDescriptionStore();
  try { expect((await store.get(node))?.description).toBe('Developer tools'); }
  finally { store.close(); }
  expect(create).toHaveBeenCalledWith({ parentId: '1', title: 'Tools' });
});

// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindLocalImportView } from '../src/local-import/view.js';
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: async () => new Set(['subscription']) }));
const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).forEach(fn => fn()); document.body.replaceChildren(); vi.unstubAllGlobals(); });

const tree = () => [{ id: '0', title: '', children: [
  { id: 'bar', parentId: '0', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
    { id: 'subscription', parentId: 'bar', title: 'Read-only subscription', children: [] },
    { id: 'managed', parentId: 'bar', title: 'Managed', unmodifiable: 'managed', children: [] },
  ] },
  { id: 'workspace', parentId: '0', title: 'Workspaces', children: [{ id: 'project', title: 'Project', children: [] }] },
] }];

function mount() {
  document.body.innerHTML = '<div id="local-import" hidden></div><button id="manager-import" type="button">Import</button>';
  return document.getElementById('local-import')!;
}

test('a guest previews an HTML file and selects a personal browser folder before any import', async () => {
  const send = vi.fn(async (request: { kind: string }) => request.kind === 'known.localImport.preview'
    ? { ok: true, preview: { digest: 'digest', creates: 3, roots: ['Page'], warnings: [] } }
    : { ok: true, status: null });
  vi.stubGlobal('chrome', { runtime: { sendMessage: send }, permissions: { contains: async () => true }, bookmarks: { getTree: async () => tree() } });
  dispose.push(bindLocalImportView(mount()).dispose);
  document.getElementById('manager-import')!.click();
  const dialog = document.querySelector<HTMLDialogElement>('dialog#local-import-dialog')!;
  expect(dialog.classList.contains('capture-dialog')).toBe(true);
  // The folder choices skip read-only subscriptions and managed folders.
  await vi.waitFor(() => expect(dialog.querySelector('#local-import-target')).not.toBeNull());
  dialog.querySelector<HTMLButtonElement>('#local-import-target')!.click();
  const choices = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.folder-opt'));
  // A folder that is not a choice stays listed (it can still open onto its subfolders) but reads aria-disabled.
  const offered = (choice: HTMLButtonElement) => choice.getAttribute('aria-disabled') !== 'true';
  expect(choices.filter(offered).map((choice) => choice.dataset.folderId)).toContain('bar');
  expect(choices.some((choice) => choice.dataset.folderId === 'subscription' && offered(choice))).toBe(false);
  expect(choices.some((choice) => choice.dataset.folderId === 'managed' && offered(choice))).toBe(false);
  expect(choices.some((choice) => ['workspace', 'project'].includes(choice.dataset.folderId ?? ''))).toBe(false);

  const file = dialog.querySelector<HTMLInputElement>('#local-import-file')!;
  Object.defineProperty(file, 'files', { value: [new File(['<DL><DT><A HREF="https://example.org">Page</A></DL>'], 'bookmarks.html', { type: 'text/html' })] });
  file.dispatchEvent(new Event('change'));
  const commit = dialog.querySelector<HTMLButtonElement>('#local-import-commit')!;
  await vi.waitFor(() => expect(dialog.querySelector('.file-chosen')?.hasAttribute('hidden')).toBe(false));
  // Nothing is sent to the worker beyond the preview until the user imports.
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.localImport.commit' }));
  expect(dialog.textContent).toContain('bookmarks.html');
  expect(dialog.textContent).toContain('2 items');
  await vi.waitFor(() => expect(commit.disabled).toBe(false));
  commit.click();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ kind: 'known.localImport.commit',
    digest: 'digest', targetNativeId: 'bar', folderTitle: 'Imported bookmarks', userGesture: true })));
});

test('an interrupted import stays visible on the page, and reopens with an explicit resume action', async () => {
  const commandId = crypto.randomUUID();
  const send = vi.fn(async () => ({ ok: true, status: { commandId, digest: 'd', targetNativeId: 'bar', folderTitle: 'Imported',
    total: 10, next: 2, state: 'attention', reason: 'permission_required' } }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send }, permissions: { contains: async () => false } });
  const reminder = mount();
  const view = bindLocalImportView(reminder); dispose.push(view.dispose); await view.refresh();
  expect(reminder.hidden).toBe(false);
  expect(reminder.textContent).not.toMatch(/undefined|permission_required/u);
  reminder.querySelector<HTMLButtonElement>('button')!.click();
  const dialog = document.querySelector<HTMLDialogElement>('dialog#local-import-dialog')!;
  await vi.waitFor(() => expect(dialog.querySelector<HTMLButtonElement>('#local-import-resume')?.hidden).toBe(false));
  expect(dialog.querySelector<HTMLButtonElement>('#local-import-commit')?.disabled).toBe(true);
  dialog.querySelector<HTMLButtonElement>('#local-import-resume')!.click();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ kind: 'known.localImport.resume', commandId, userGesture: true }));
});

test('with no import in flight the page shows no reminder', async () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, status: null })) }, permissions: { contains: async () => true } });
  const reminder = mount();
  const view = bindLocalImportView(reminder); dispose.push(view.dispose); await view.refresh();
  expect(reminder.hidden).toBe(true);
});

test('without bookmark access the dialog asks for it instead of offering folders', async () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, status: null })) }, permissions: { contains: async () => false } });
  dispose.push(bindLocalImportView(mount()).dispose);
  document.getElementById('manager-import')!.click();
  const dialog = document.querySelector<HTMLDialogElement>('dialog#local-import-dialog')!;
  await vi.waitFor(() => expect(dialog.querySelector<HTMLButtonElement>('#local-import-grant')?.hidden).toBe(false));
  expect(dialog.querySelector('#local-import-target')).toBeNull();
});

test('reopening before the previous close event arrives retains the new dialog', () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ ok: true, status: null })) }, permissions: { contains: async () => false } });
  const view = bindLocalImportView(mount()); dispose.push(view.dispose);
  view.open();
  const previous = document.querySelector<HTMLDialogElement>('#local-import-dialog')!;
  // Native close() removes `open` synchronously but queues the close event.
  previous.removeAttribute('open');
  view.open();
  const reopened = document.querySelector<HTMLDialogElement>('#local-import-dialog[open]');
  expect(reopened).not.toBeNull();
  expect(reopened).not.toBe(previous);
  expect(previous.isConnected).toBe(false);
  previous.dispatchEvent(new Event('close'));
  // The old close event must not clear the new dialog's ownership.
  view.open();
  expect(document.querySelectorAll('#local-import-dialog')).toHaveLength(1);
  expect(document.querySelector('#local-import-dialog')).toBe(reopened);
});

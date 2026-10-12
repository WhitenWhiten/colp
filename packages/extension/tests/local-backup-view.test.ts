// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindBackupView } from '../src/local-backup/view.js';

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

function mount() {
  document.body.innerHTML = '<div id="local-backup"></div><button id="manager-export" type="button">Export</button>';
  const host = document.getElementById('local-backup')!;
  bindBackupView(host);
  return host;
}

test('Export opens a dialog with HTML or a Know-N backup, HTML first, and the host stays hidden', () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() } });
  const host = mount();
  expect(host.hidden).toBe(true);
  document.getElementById('manager-export')!.click();
  const dialog = document.querySelector<HTMLDialogElement>('dialog#local-backup-dialog')!;
  expect(dialog.classList.contains('capture-dialog')).toBe(true);
  const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[name="export-format"]'));
  expect(inputs.map((input) => [input.value, input.checked])).toEqual([['html', true], ['json', false]]);
  expect(dialog.textContent).toContain('AI connections with URL queries or fragments, or invalid settings, are skipped');
  expect(dialog.textContent).toContain('set them up again after restoring');
  // A second click does not stack a second dialog.
  document.getElementById('manager-export')!.click();
  expect(document.querySelectorAll('dialog#local-backup-dialog')).toHaveLength(1);
});

test('the chosen format is requested from the worker and a failure keeps the dialog open with plain words', async () => {
  const send = vi.fn(async () => ({ ok: false, error: 'permission_required' }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  mount();
  document.getElementById('manager-export')!.click();
  const dialog = document.querySelector<HTMLDialogElement>('dialog#local-backup-dialog')!;
  dialog.querySelector<HTMLInputElement>('input[value="json"]')!.checked = true;
  dialog.querySelector<HTMLButtonElement>('#local-backup-export')!.click();
  await vi.waitFor(() => expect(dialog.querySelector('.mgr-status')?.textContent).toContain('Allow bookmark access'));
  expect(send).toHaveBeenCalledWith({ kind: 'known.localBackup.export', format: 'json' });
  expect(dialog.isConnected).toBe(true);
  expect(dialog.querySelector<HTMLButtonElement>('#local-backup-export')!.disabled).toBe(false);
  expect(dialog.textContent).not.toMatch(/undefined|permission_required/u);
});

test('a successful export downloads the file and closes the dialog', async () => {
  const send = vi.fn(async () => ({ ok: true, content: '<DL></DL>', filename: 'bookmarks.html', mime: 'text/html' }));
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  const create = vi.fn(() => 'blob:test'); const revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  mount();
  document.getElementById('manager-export')!.click();
  const dialog = document.querySelector<HTMLDialogElement>('dialog#local-backup-dialog')!;
  dialog.querySelector<HTMLButtonElement>('#local-backup-export')!.click();
  await vi.waitFor(() => expect(document.querySelector('dialog#local-backup-dialog')).toBeNull());
  expect(create).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith({ kind: 'known.localBackup.export', format: 'html' });
});

test('General › Your data opens the same dialog with the Know-N backup chosen', () => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() } });
  mount();
  const general = document.createElement('button'); general.id = 'general-export'; document.body.append(general);
  bindBackupView(document.getElementById('local-backup')!);
  general.click();
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('dialog#local-backup-dialog input[name="export-format"]'));
  expect(inputs.map((input) => [input.value, input.checked])).toEqual([['html', false], ['json', true]]);
});

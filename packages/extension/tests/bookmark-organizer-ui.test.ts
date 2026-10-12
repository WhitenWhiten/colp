// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bindBookmarkOrganizer } from '../src/bookmark-organizer-ui.js';
import type { OrganizeResponse } from '../src/bookmark-organizer.js';

vi.mock('../src/toast.js', () => ({ showToast: vi.fn() }));
const send = vi.fn();
const applied = vi.fn(async () => undefined);
const choices = [
  { nativeId: '1', title: 'Bookmarks bar', rootTitle: 'Bookmarks bar', recursive: false },
  { nativeId: 'a', title: 'Design', rootTitle: 'Bookmarks bar', recursive: true },
  { nativeId: 'b', title: 'Reading', rootTitle: 'Bookmarks bar', recursive: true },
];
const open = async () => {
  document.querySelector<HTMLButtonElement>('#manager-organize')!.click();
  await vi.waitFor(() => expect(document.querySelectorAll('#manager-organize-paths input')).toHaveLength(3));
  return document.querySelector<HTMLDialogElement>('#manager-organize-dialog')!;
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', { runtime: { sendMessage: send } });
  send.mockImplementation(async request => request.kind.endsWith('preview') ? { ok: true, choices } : { ok: true, moved: 2 });
  document.body.innerHTML = '<button id="manager-organize" class="btn btn-secondary btn-sm">Organize</button>';
  bindBookmarkOrganizer(applied);
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('defaults every offered path to checked and uses existing dialog, button and checkbox recipes', async () => {
  const dialog = await open();
  expect(dialog.className).toBe('capture-dialog mgr-batch');
  expect(dialog.querySelector('.capture-dialog-body .mgr-batch-items')).not.toBeNull();
  expect(dialog.querySelectorAll('label.check-row')).toHaveLength(3);
  expect(Array.from(dialog.querySelectorAll<HTMLInputElement>('input')).every(box => box.checked)).toBe(true);
  expect(dialog.querySelector('#manager-organize-apply')?.className).toBe('btn btn-primary');
  expect(dialog.querySelector('input[value="1"]')?.getAttribute('aria-label')).toBe('Bookmarks bar · Root path');
  expect(dialog.querySelector('input[value="a"]')?.getAttribute('aria-label')).toBe('Bookmarks bar / Design');
});

test('applies only final selections and refreshes after the dialog closes', async () => {
  const dialog = await open();
  dialog.querySelector<HTMLInputElement>('input[value="1"]')!.click();
  dialog.querySelector<HTMLInputElement>('input[value="b"]')!.click();
  dialog.querySelector<HTMLButtonElement>('#manager-organize-apply')!.click();
  await vi.waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenLastCalledWith({ kind: 'known.bookmarks.organize.apply', userGesture: true, nativeIds: ['a'] });
  expect(dialog.isConnected).toBe(false);
  expect(document.activeElement?.id).toBe('manager-organize');
});

test('empty selection disables apply and cancel never writes', async () => {
  const dialog = await open();
  for (const box of Array.from(dialog.querySelectorAll<HTMLInputElement>('input'))) box.click();
  expect(dialog.querySelector<HTMLButtonElement>('#manager-organize-apply')!.disabled).toBe(true);
  const cancel = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Cancel')!;
  cancel.click();
  expect(send).toHaveBeenCalledTimes(1); expect(applied).not.toHaveBeenCalled();
});

test('prevents duplicate submissions and shows honest partial failure without losing selection', async () => {
  let release!: (value: OrganizeResponse) => void;
  send.mockImplementation(request => request.kind.endsWith('preview') ? Promise.resolve({ ok: true, choices })
    : new Promise<OrganizeResponse>(resolve => { release = resolve; }));
  const dialog = await open();
  const apply = dialog.querySelector<HTMLButtonElement>('#manager-organize-apply')!;
  apply.click(); apply.click();
  expect(send).toHaveBeenCalledTimes(2);
  expect(Array.from(dialog.querySelectorAll<HTMLInputElement>('input')).every(box => box.disabled)).toBe(true);
  const escape = new Event('cancel', { cancelable: true }); dialog.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  release({ ok: false, error: 'organize_failed', moved: 2 });
  await vi.waitFor(() => expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('2 folder moves completed'));
  expect(apply.disabled).toBe(false);
  expect(Array.from(dialog.querySelectorAll<HTMLInputElement>('input')).every(box => box.checked && !box.disabled)).toBe(true);
  expect(applied).not.toHaveBeenCalled();
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openRuleEditor } from '../src/automation/rule-editor-dialog.js';

const exclusions = vi.hoisted(() => vi.fn());
vi.mock('../src/bookmark-subscriptions/guards.js', () => ({ exclusionIds: exclusions }));

beforeEach(() => {
  exclusions.mockReset().mockResolvedValue(new Set(['subscription']));
  HTMLDialogElement.prototype.showModal ??= function showModal() { this.open = true; };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test.each(['initial tree', 'exclusions', 'after permission grant'])('%s load failure offers a working retry', async (failure) => {
  let granted = failure !== 'after permission grant';
  const getTree = vi.fn().mockResolvedValue([{ id: '0', title: '', children: [{ id: '1', title: 'Bar',
    children: [{ id: 'subscription', title: 'Hidden subscription', children: [] }] }] }]);
  if (failure === 'exclusions') exclusions.mockRejectedValueOnce(new Error('subscription_database_unavailable'));
  else getTree.mockRejectedValueOnce(new Error('bookmarks_unavailable'));
  vi.stubGlobal('chrome', {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: vi.fn().mockResolvedValue({ ok: true }) },
    permissions: { contains: async () => granted, request: async () => { granted = true; return true; } },
    bookmarks: { getTree },
  });
  openRuleEditor(null);
  const dialog = document.querySelector<HTMLDialogElement>('dialog.automation-rule-editor')!;
  const buttonNamed = (name: string) => Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
    .find(button => button.textContent === name);
  if (failure === 'after permission grant') {
    await vi.waitFor(() => expect(buttonNamed('Allow bookmark access')).toBeDefined());
    buttonNamed('Allow bookmark access')!.click();
  }
  await vi.waitFor(() => expect(buttonNamed('Try again')).toBeDefined());
  expect(dialog.textContent).toContain('Couldn’t read automations in this browser.');
  expect(dialog.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.disabled).toBe(true);
  buttonNamed('Try again')!.click();
  await vi.waitFor(() => expect(dialog.querySelectorAll('.folder-opt').length).toBe(1));
  expect(dialog.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.disabled).toBe(false);
  expect(dialog.querySelector('.folder-list')?.textContent).toContain('Bar');
  expect(dialog.querySelector('.folder-list')?.textContent).not.toContain('Hidden subscription');
  expect(getTree).toHaveBeenCalledTimes(2);
});

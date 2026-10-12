// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { createShortcutsView } from '../src/capture/shortcuts-view.js';

afterEach(() => vi.unstubAllGlobals());

it('lists the manifest shortcuts as keys and marks unbound commands', async () => {
  const create = vi.fn(async () => ({}));
  vi.stubGlobal('chrome', { commands: { getAll: vi.fn(async () => [
    { name: '_execute_action', shortcut: 'Alt+S' }, { name: 'save-window-tabs', shortcut: '' }, { name: 'unknown-command', shortcut: 'Alt+X' },
  ]) }, tabs: { create } });
  const host = document.createElement('div'); host.hidden = true;
  await createShortcutsView(host).activate();
  expect(host.hidden).toBe(false);
  const rows = Array.from(host.querySelectorAll('.set-row'));
  expect(rows.map(row => row.querySelector('.set-row-title')?.textContent)).toEqual(['Save this page', 'Save all tabs in this window', 'Change shortcuts']);
  expect(Array.from(rows[0]!.querySelectorAll('kbd')).map(key => key.textContent)).toEqual(['Alt', 'S']);
  expect(rows[1]!.querySelector('.set-row-value')?.textContent).toBe('Not set');
  host.querySelector<HTMLButtonElement>('.set-row button')!.click();
  expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
});

// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { initializeSettingsSection } from '../src/settings-section.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('a failing section shows a recovery action and leaves another section functional', () => {
  document.body.innerHTML = '<section id="broken"><button>Write settings</button></section><section id="working"><button>Save</button></section>';
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), reload = vi.fn(), bindWorking = vi.fn();
  vi.stubGlobal('location', { reload });
  initializeSettingsSection('broken', () => { throw new Error('private-input-must-not-be-logged'); });
  initializeSettingsSection('working', bindWorking);
  const broken = document.getElementById('broken')!;
  expect(broken.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  expect(broken.querySelector('[role="alert"]')!.textContent).toContain('This section could not load');
  expect(document.querySelector<HTMLButtonElement>('#working button')!.disabled).toBe(false); expect(bindWorking).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-input');
  broken.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); expect(reload).toHaveBeenCalledOnce();
});
test('a rejected asynchronous initializer uses the same section recovery and absent features are skipped', async () => {
  document.body.innerHTML = '<section id="async"></section>';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const missing = vi.fn(); initializeSettingsSection('absent', missing); expect(missing).not.toHaveBeenCalled();
  initializeSettingsSection('async', async () => { throw new Error('startup'); });
  await vi.waitFor(() => expect(document.querySelector('#async [role="alert"]')).not.toBeNull());
});

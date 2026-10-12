// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindManualClassificationOptions } from '../src/manual-classification-options.js';
import { MANUAL_CLASSIFICATION_AUTO } from '../src/manual-classification.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function options(enabled = false) {
  document.body.innerHTML = '<button id="capture-manual-suggestions" class="toggle" type="button" role="switch" aria-checked="false"></button>';
  const values: Record<string, unknown> = { [MANUAL_CLASSIFICATION_AUTO]: enabled };
  const set = vi.fn(async (patch: Record<string, unknown>) => { Object.assign(values, patch); });
  vi.stubGlobal('__KNOWN_EXTENSION_CLASSIFICATION_LOCAL__', true);
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: values[key] }), set } } });
  bindManualClassificationOptions();
  return { control: document.getElementById('capture-manual-suggestions') as HTMLButtonElement, values, set };
}

const on = (control: HTMLElement) => control.getAttribute('aria-checked') === 'true';

test('persists the browser switch and restores it when settings reopen', async () => {
  const f = options(); await vi.waitFor(() => expect(f.control.disabled).toBe(false));
  expect(on(f.control)).toBe(false);
  f.control.click();
  await vi.waitFor(() => expect(f.control.disabled).toBe(false));
  expect(f.values[MANUAL_CLASSIFICATION_AUTO]).toBe(true);
  bindManualClassificationOptions(); await vi.waitFor(() => expect(on(f.control)).toBe(true));
});

test('failed writes restore the effective switch and show the error', async () => {
  const f = options(true); await vi.waitFor(() => expect(f.control.disabled).toBe(false));
  f.set.mockRejectedValueOnce(new Error('storage unavailable'));
  expect(on(f.control)).toBe(true);
  f.control.click();
  await vi.waitFor(() => expect(f.control.disabled).toBe(false));
  expect(on(f.control)).toBe(true);
  expect(document.body.textContent).toContain('Could not save automatic suggestions');
});

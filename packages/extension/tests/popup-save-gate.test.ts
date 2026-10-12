// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { showManualCaptureExistence } from '../src/capture/manual-existence.js';
import { paintPermissionGate } from '../src/popup-dom.js';
import { byId, mountPopupShell } from './fixtures/popup-shell.js';

function mountPopup(permissionMissing: boolean): { save: HTMLButtonElement; allow: HTMLButtonElement } {
  mountPopupShell();
  byId('permission-note').hidden = !permissionMissing;
  return { save: byId<HTMLButtonElement>('save'), allow: byId<HTMLButtonElement>('permission-grant') };
}

function stubExistence(exact: unknown[]): void {
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: vi.fn(async () => ({ ok: true, existence: { exact } })) },
  });
}

const savedLocation = { path: ['Reading'], collectionTitle: 'Mine', nodeId: 'n1', nativeId: null };

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

test('with bookmark access, Save is the primary action and the alert is hidden', () => {
  const { save } = mountPopup(false);
  paintPermissionGate();
  expect(save.getAttribute('aria-disabled')).toBe('false');
  expect(save.classList.contains('btn-primary')).toBe(true);
  expect(byId('permission-note').hidden).toBe(true);
});

test('missing bookmark access disables Save, while Allow stays a secondary action', () => {
  const { save, allow } = mountPopup(true);
  paintPermissionGate();
  expect(save.getAttribute('aria-disabled')).toBe('true');
  expect(save.classList.contains('btn-secondary')).toBe(true);
  expect(save.classList.contains('btn-primary')).toBe(false);
  expect(allow.classList.contains('btn-secondary')).toBe(true);
  expect(allow.classList.contains('btn-primary')).toBe(false);
  // The alert is the kit's, with the permission sentence and the Allow action inside it.
  const alert = byId('permission-note');
  expect(alert.classList.contains('inline-alert')).toBe(true);
  expect(alert.contains(allow)).toBe(true);
});

test('granting access puts the primary look back on Save and Allow never turns primary', () => {
  const { save, allow } = mountPopup(true);
  paintPermissionGate();
  byId('permission-note').hidden = true;
  paintPermissionGate();
  expect(save.getAttribute('aria-disabled')).toBe('false');
  expect(save.classList.contains('btn-primary')).toBe(true);
  expect(allow.classList.contains('btn-secondary')).toBe(true);
});

test('an already-saved page lists its copies and offers "Save another copy" without touching the permission gate', async () => {
  const { save } = mountPopup(false);
  stubExistence([savedLocation, { ...savedLocation, nodeId: 'n2' }]);
  await showManualCaptureExistence('https://example.org/a');
  expect(byId('capture-existing-locations').querySelectorAll('.existence-path')).toHaveLength(2);
  expect(byId('capture-existing-locations').querySelector('label.check-line #capture-save-another')).not.toBeNull();
  // Locating the existing copies is not the Save button's business any more.
  expect(save.textContent).toBe('Save');
  paintPermissionGate();
  expect(save.getAttribute('aria-disabled')).toBe('false');
});

test('ticking Save another copy does not lift a missing bookmark permission', async () => {
  const { save, allow } = mountPopup(true);
  paintPermissionGate();
  stubExistence([savedLocation]);
  await showManualCaptureExistence('https://example.org/a');
  const another = byId<HTMLInputElement>('capture-save-another');
  another.checked = true;
  another.dispatchEvent(new Event('change', { bubbles: true }));
  paintPermissionGate();
  expect(save.getAttribute('aria-disabled')).toBe('true');
  expect(save.classList.contains('btn-secondary')).toBe(true);
  expect(allow.classList.contains('btn-secondary')).toBe(true);
});

test('removing the existence card announces it and keeps the permission gate', async () => {
  const { save } = mountPopup(true);
  stubExistence([savedLocation]);
  await showManualCaptureExistence('https://example.org/a');
  const cleared = vi.fn(() => paintPermissionGate());
  document.addEventListener('known:existence-cleared', cleared);

  stubExistence([]);
  await showManualCaptureExistence('https://example.org/b');
  document.removeEventListener('known:existence-cleared', cleared);
  expect(cleared).toHaveBeenCalledTimes(1);
  expect(document.getElementById('capture-existing-locations')).toBeNull();
  expect(save.getAttribute('aria-disabled')).toBe('true');
});

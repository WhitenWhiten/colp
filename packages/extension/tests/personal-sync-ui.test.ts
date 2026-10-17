// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { bindPersonalSyncControls } from '../src/personal-sync-ui.js';
import { dismissToast } from '../src/toast.js';

afterEach(() => {
  dismissToast();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test('a failed reconnect uses the shared accessible error toast outside the settings card', async () => {
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: vi.fn() } },
    runtime: { sendMessage: vi.fn(async ({ kind }: { kind: string }) => {
      if (kind === 'known.personalSync.status') return { ok: true, policy: { mode: 'disconnected', revision: 'one' } };
      if (kind === 'known.personalSync.preview') return { ok: false, error: 'personal_sync_preview_stale' };
      return { ok: false };
    }) },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const controls = bindPersonalSyncControls(host);
  await controls.refresh();
  document.querySelector<HTMLButtonElement>('#personal-sync-toggle')!.click();
  await vi.waitFor(() => expect(document.querySelector('.toast--error')).not.toBeNull());
  const toast = document.querySelector('.toast--error')!;
  expect(toast.parentElement).toBe(document.body);
  expect(toast.getAttribute('role')).toBe('alert');
  expect(toast.getAttribute('aria-live')).toBe('assertive');
  expect(toast.textContent).toContain('The change could not be completed.');
  expect(host.querySelector('.feedback')).toBeNull();
  expect(document.querySelector('#personal-sync-status')!.textContent).toBe('Personal sync is disconnected');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#personal-sync-toggle')!.disabled).toBe(false));
});

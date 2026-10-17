// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { bindRemoteDeleteSettings } from '../src/remote-delete-ui.js';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('a failed read clears once a later read succeeds, and never asks a signed-in user to sign in', async () => {
  const markup = await readFile('options.html', 'utf8');
  document.body.innerHTML = markup.match(/<body[^>]*>([\s\S]*)<\/body>/u)![1]!.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gu, '');
  const replies: unknown[] = [
    { ok: false, error: 'not_connected' },
    { ok: true, policy: 'sync', casVersion: 1, pending: [], pendingCount: 0, conflictPending: false, conflictHref: 'https://know-n.test/conflicts' },
  ];
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => replies.length > 1 ? replies.shift() : replies[0]) } });
  bindRemoteDeleteSettings();
  const feedback = document.getElementById('remote-delete-feedback')!;
  await vi.waitFor(() => expect(feedback.hidden).toBe(false));
  expect(feedback.textContent).toBe('Start syncing to change how cloud deletions are applied here.');
  location.hash = '#sync/center';
  window.dispatchEvent(new Event('hashchange'));
  await vi.waitFor(() => expect(feedback.hidden).toBe(true));
});

// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test, vi } from 'vitest';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';

afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

test('the actual Status markup shows a recovery failure, retries, and copies its reason', async () => {
  vi.useFakeTimers();
  const sendMessage = vi.fn(async (message: { kind: string }) => {
    if (message.kind === 'known.sync.attention.get') return { ok: true, attention: {
      phase: 'error', recoveryFrozen: true, queueProjection: 'idle', rejectedPending: false,
      conflictPending: false, nativeWaitPending: false, waitCount: 0, lastError: 'bounded_string_invalid',
      terminal: false, retryAutomatic: false,
    } };
    if (message.kind === 'known.sync.engine.retry') return { ok: true };
    return { ok: false, error: 'not_connected' };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(writeText);
  const markup = await readFile('options.html', 'utf8');
  const start = markup.indexOf('<section id="sync-attention-settings"');
  const end = markup.indexOf('<section id="native-wait-settings"', start);
  document.body.innerHTML = markup.slice(start, end);
  document.body.dataset.pane = 'sync';
  bindSyncAttentionSettings();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(document.getElementById('sync-attention-settings')!.hidden, false);
  assert.equal(document.getElementById('sync-attention-settings-recovery')!.hidden, false);
  assert.equal(document.getElementById('sync-attention-settings-terminal')!.hidden, true);
  assert.match(document.getElementById('sync-attention-settings-recovery-copy')!.textContent!, /Retry sync/);
  document.getElementById('sync-attention-settings-retry')!.click();
  await vi.advanceTimersByTimeAsync(0);
  assert.ok(sendMessage.mock.calls.some(([message]) => message.kind === 'known.sync.engine.retry'));
  document.getElementById('sync-attention-settings-recovery-diagnostics')!.click();
  await vi.advanceTimersByTimeAsync(0);
  assert.match(writeText.mock.calls[0]![0], /lastError: bounded_string_invalid/);
  assert.equal(document.getElementById('sync-attention-settings-feedback')!.hidden, false);
  vi.restoreAllMocks();
});

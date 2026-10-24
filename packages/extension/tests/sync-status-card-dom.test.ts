// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test, vi } from 'vitest';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';

/**
 * The real Status markup, bound to a worker that answers as scripted:
 * lost bookmark access (C-05) and a status that cannot be read (C-09).
 */
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const calm = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
  nativeWaitPending: false, waitCount: 0, terminal: false };
const byId = (id: string) => document.getElementById(`sync-attention-settings${id}`)!;

async function mount(reads: Array<() => unknown>) {
  vi.useFakeTimers();
  let index = 0;
  const sendMessage = vi.fn(async (message: { kind: string }) => {
    if (message.kind === 'known.sync.attention.get') return reads[Math.min(index++, reads.length - 1)]!();
    return { ok: false, error: 'not_connected' };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const markup = await readFile('options.html', 'utf8');
  const start = markup.indexOf('<section id="sync-attention-settings"');
  const end = markup.indexOf('<section id="native-wait-settings"', start);
  document.body.innerHTML = markup.slice(start, end);
  document.body.dataset.pane = 'sync';
  bindSyncAttentionSettings();
  await vi.advanceTimersByTimeAsync(0);
  return { next: async () => { await vi.advanceTimersByTimeAsync(8_000); } };
}

test('lost bookmark access shows where to allow it, and no Retry that cannot help (C-05)', async () => {
  await mount([() => ({ ok: true, attention: { ...calm, permissionRequired: true, retryAutomatic: true } })]);
  assert.equal(byId('').hidden, false);
  assert.equal(byId('-recovery').hidden, false);
  assert.match(byId('-recovery-copy').textContent!, /needs permission to read and change your bookmarks/u);
  assert.equal(byId('-retry').hidden, true);
  const folders = byId('-recovery-folders') as HTMLAnchorElement;
  assert.equal(folders.hidden, false);
  assert.equal(folders.getAttribute('href'), '#sync/folders');
  assert.equal(folders.textContent, 'Open Folders');
});

test('a failed read keeps the last reading on the card and says it may be out of date (C-09)', async () => {
  const { next } = await mount([
    () => ({ ok: true, attention: { ...calm, retryAutomatic: false, phase: 'error', lastError: 'queue_state_invalid' } }),
    () => ({ ok: false, error: 'state_unavailable' }),
    () => ({ ok: true, attention: { ...calm, retryAutomatic: false, phase: 'error', lastError: 'queue_state_invalid' } }),
  ]);
  assert.equal(byId('-recovery').hidden, false);
  assert.equal(byId('-unreadable').hidden, true);
  const copy = byId('-recovery-copy').textContent;
  await next();
  assert.equal(byId('').hidden, false, 'the card stays');
  assert.equal(byId('-recovery').hidden, false);
  assert.equal(byId('-recovery-copy').textContent, copy);
  assert.equal(byId('-unreadable').hidden, false);
  assert.match(byId('-unreadable').textContent!, /Couldn’t read sync status \(state_unavailable\)\. What is shown may be out of date\./u);
  await next();
  assert.equal(byId('-unreadable').hidden, true, 'the next good reading clears it');
});

test('a first read that fails still says so, instead of an empty page (C-09)', async () => {
  await mount([() => undefined]);
  assert.equal(byId('').hidden, false);
  assert.equal(byId('-unreadable').hidden, false);
  assert.match(byId('-unreadable').textContent!, /Couldn’t read sync status \(status_unreachable\)\. Try again in a moment\./u);
  assert.equal(byId('-recovery').hidden, true);
});

test('a worker that is not connected is a quiet card, not an error (C-09)', async () => {
  await mount([() => ({ ok: false, error: 'not_connected' })]);
  assert.equal(byId('-unreadable').hidden, true);
  assert.equal(byId('').hidden, true);
});

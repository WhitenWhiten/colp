// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, test, vi } from 'vitest';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';
import { clockSkewCopy, describeSyncAttention, syncAttentionInput } from '../src/sync-attention-view.js';
import { projectReplicaHealth } from '../src/sw/replica-health-report.js';
import { handleSyncAttentionRequest } from '../src/sw/sync-attention.js';
import type { PublicSyncAttention } from '../src/types.js';
import { setup } from './replica-rebuild-harness.js';

/**
 * K4 and W2B-P2-1 on the Status card. A clock that is off is a note (sync keeps working: every expiry is judged in the
 * server's time); a site access that was turned off says so and offers the one click that puts it back.
 */
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const MINUTE = 60_000;
const calm: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
  nativeWaitPending: false, waitCount: 0, terminal: false, retryAutomatic: true, phase: 'sleeping' };

describe('a clock that is off is a note, not a stop', () => {
  test('says which way and by how many minutes, and that sync keeps working', () => {
    assert.equal(clockSkewCopy(5 * MINUTE),
      'Your computer’s clock is 5 minutes ahead of the server’s. Sync keeps working, but set your clock to automatic time so sign-in and expiry checks stay reliable.');
    assert.equal(clockSkewCopy(-20 * MINUTE),
      'Your computer’s clock is 20 minutes behind the server’s. Sync keeps working, but set your clock to automatic time so sign-in and expiry checks stay reliable.');
    // Just past the two-minute threshold still reads as two, never "1 minutes" or "0 minutes".
    assert.match(clockSkewCopy(2 * MINUTE + 1), /^Your computer’s clock is 2 minutes ahead/u);
    assert.match(clockSkewCopy(-(2 * MINUTE + 1)), /^Your computer’s clock is 2 minutes behind/u);
  });

  test('it is a line beside the card; the card itself is not an alert, and the details carry the number', () => {
    const view = describeSyncAttention(syncAttentionInput({ ...calm, clockSkewMilliseconds: 5 * MINUTE }, undefined));
    assert.equal(view.notes.show, true);
    assert.deepEqual(view.notes.lines, [clockSkewCopy(5 * MINUTE)]);
    assert.equal(view.recovery.show, false);
    assert.equal(view.terminal.show, false);
    const quiet = describeSyncAttention(syncAttentionInput(calm, undefined));
    assert.deepEqual(quiet.notes.lines, []);
    const off = describeSyncAttention(syncAttentionInput({ ...calm, clockSkewMilliseconds: 5 * MINUTE, lastError: 'queue_state_invalid', retryAutomatic: false }, undefined));
    assert.match(off.recovery.report, /clockSkew: 300000 ms \(this computer minus the server\)/u);
    assert.match(quiet.recovery.report, /clockSkew: \(within two minutes\)/u);
  });

  test('the worker reports it only past two minutes, and the Sync center is told degraded with its code', async () => {
    const f = await setup();
    try {
      const read = async (skew?: number) => {
        const response = await handleSyncAttentionRequest({ scope: async () => f.scope, store: f.store, ...(skew === undefined ? {} : { clockSkew: () => skew }) });
        assert.ok(response.ok); return response.attention;
      };
      assert.equal((await read(5 * MINUTE)).clockSkewMilliseconds, 5 * MINUTE);
      assert.equal((await read(-20 * MINUTE)).clockSkewMilliseconds, -20 * MINUTE);
      assert.equal((await read(2 * MINUTE)).clockSkewMilliseconds, undefined, 'exactly two minutes is not "more than"');
      assert.equal((await read(0)).clockSkewMilliseconds, undefined);
      assert.equal((await read()).clockSkewMilliseconds, undefined, 'nothing measured, nothing said');
    } finally { f.store.close(); }
    assert.deepEqual(projectReplicaHealth({ attention: { ...calm, clockSkewMilliseconds: 5 * MINUTE }, issues: [] }),
      { state: 'degraded', code: 'clock_skew', issues: { total: 0, items: [] }, actions: [] });
    // Anything that stopped sync is reported as that, not as the clock.
    const stopped = projectReplicaHealth({ attention: { ...calm, clockSkewMilliseconds: 5 * MINUTE, terminal: true, retryAutomatic: false,
      terminalCode: 'mapping_identity_conflict', lastError: 'mapping_identity_conflict' }, issues: [] });
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.code, 'mapping_identity_conflict');
    assert.equal(projectReplicaHealth({ attention: calm, issues: [] }).state, 'syncing');
  });
});

describe('a site access that was turned off', () => {
  test('the worker names the server only for that code', async () => {
    const f = await setup();
    try {
      const read = async (lastError?: string) => {
        await f.store.transitionEngine(f.scope, { phase: 'error', recoveryFrozen: false, authorityRefreshRequired: false, updatedAt: 3000, notBefore: 0,
          ...(lastError ? { lastError } : {}) });
        const response = await handleSyncAttentionRequest({ scope: async () => f.scope, store: f.store });
        assert.ok(response.ok); return response.attention;
      };
      assert.equal((await read('server_configuration_failed')).siteAccessOrigin, f.scope.serverOrigin);
      assert.equal((await read('network_unavailable')).siteAccessOrigin, undefined);
    } finally { f.store.close(); }
  });

  test('the card says what happened, what to do, and shows the button only for it', () => {
    const attention = { ...calm, phase: 'error' as const, lastError: 'server_configuration_failed', retryAutomatic: false, siteAccessOrigin: 'https://colp.example' };
    const view = describeSyncAttention(syncAttentionInput(attention, undefined));
    assert.equal(view.recovery.show, true);
    assert.match(view.recovery.copy, /^Know-N can no longer reach the server: this extension's access to the site was turned off\. Allow access to the site \(Chrome: Extensions, Details, Site access\) and sync continues by itself\. Nothing is lost\./u);
    assert.deepEqual(view.recovery.siteAccess, { show: true, origin: 'https://colp.example' });
    assert.doesNotMatch(view.recovery.copy, /Reset sync|sign in again/iu);
    const other = describeSyncAttention(syncAttentionInput({ ...attention, lastError: 'network_unavailable', siteAccessOrigin: undefined } as never, undefined));
    assert.equal(other.recovery.siteAccess.show, false);
  });

  interface Fake { attention: PublicSyncAttention; sent: string[]; request: ReturnType<typeof vi.fn> }
  async function mount(attention: PublicSyncAttention, granted: boolean): Promise<Fake> {
    vi.useFakeTimers();
    const fake: Fake = { attention, sent: [], request: vi.fn(async () => granted) };
    vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage: async (message: { kind: string }) => {
      fake.sent.push(message.kind);
      return message.kind === 'known.sync.attention.get' ? { ok: true, attention: fake.attention } : { ok: false, error: 'not_connected' };
    } }, permissions: { request: fake.request } });
    const markup = await readFile('options.html', 'utf8');
    const start = markup.indexOf('<section id="sync-attention-settings"');
    document.body.innerHTML = markup.slice(start, markup.indexOf('<section id="native-wait-settings"', start));
    document.body.dataset.pane = 'sync';
    bindSyncAttentionSettings();
    await vi.advanceTimersByTimeAsync(0);
    return fake;
  }
  const node = (suffix: string) => document.getElementById(`sync-attention-settings-${suffix}`) as HTMLElement;
  const attention: PublicSyncAttention = { ...calm, phase: 'error', lastError: 'server_configuration_failed', retryAutomatic: false, siteAccessOrigin: 'https://colp.example' };

  test('Allow access asks the browser for exactly that server, in the click, and says what came of it', async () => {
    const fake = await mount(attention, true);
    assert.equal(node('site-access').hidden, false);
    assert.equal(node('site-access').textContent, 'Allow access');
    (node('site-access') as HTMLButtonElement).click();
    assert.deepEqual(fake.request.mock.calls, [[{ origins: ['https://colp.example/*'] }]], 'asked synchronously, before anything was awaited');
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(node('feedback').textContent, 'Access allowed. Sync is trying again.');
    assert.equal((node('site-access') as HTMLButtonElement).disabled, false);
    assert.ok(fake.sent.filter(kind => kind === 'known.sync.attention.get').length >= 2, 'the card was read again');
  });

  test('a refusal is said, and the button stays for another try', async () => {
    const fake = await mount(attention, false);
    (node('site-access') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(node('feedback').textContent, 'Access was not allowed, so sync still cannot reach the server.');
    assert.equal(node('site-access').hidden, false);
    assert.equal(fake.request.mock.calls.length, 1);
  });

  test('another problem has no such button', async () => {
    await mount({ ...attention, lastError: 'network_unavailable', retryAutomatic: true, siteAccessOrigin: undefined } as never, true);
    assert.equal(node('site-access').hidden, true);
  });
});

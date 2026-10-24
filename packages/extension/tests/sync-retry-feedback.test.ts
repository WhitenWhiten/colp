// @vitest-environment happy-dom
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, test, vi } from 'vitest';
import { requestExplicitSyncRetry, takeExplicitSyncRetry } from '../src/sw/explicit-retry.js';
import { runManualRetry, settleManualRetry } from '../src/sw/manual-retry.js';
import { bindSyncAttentionSettings } from '../src/sync-attention-ui.js';
import { retryOutcomeCopy, syncRetryReading } from '../src/sync-attention-view.js';
import type { PublicSyncAttention } from '../src/types.js';

/**
 * C-17a: Retry answers after its pass, and the card says whether anything changed,
 * instead of "Sync retry requested." before anything ran.
 */
afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const calm: PublicSyncAttention = { recoveryFrozen: false, queueProjection: 'idle', rejectedPending: false, conflictPending: false,
  nativeWaitPending: false, waitCount: 0, terminal: false, retryAutomatic: true };
const failing: PublicSyncAttention = { ...calm, retryAutomatic: false, phase: 'error', lastError: 'queue_state_invalid' };

describe('the worker answers after the pass', () => {
  test('settled once the wake finishes, however long after the request', async () => {
    assert.deepEqual(await settleManualRetry(Promise.resolve(), () => 'x'), { ok: true, settled: true });
  });

  test('still running when the pass outlasts the wait; the page is told, not left hanging', async () => {
    vi.useFakeTimers();
    const pass = new Promise<void>(() => undefined);
    const answer = settleManualRetry(pass, () => 'x', 20_000);
    await vi.advanceTimersByTimeAsync(20_000);
    assert.deepEqual(await answer, { ok: true, settled: false });
  });

  test('a pass that throws is a failure with its code, not a success', async () => {
    const response = await settleManualRetry(Promise.reject(new Error('indexeddb_unavailable')), error => (error as Error).message);
    assert.deepEqual(response, { ok: false, error: 'indexeddb_unavailable' });
  });
});

describe('the person\'s Retry is one path: the request, the pass, the answer', () => {
  test('the pass is asked for after the request is recorded, and consumes it exactly once', async () => {
    const order: string[] = [];
    const response = await runManualRetry({
      request: () => { order.push('request'); requestExplicitSyncRetry(); },
      wake: async () => { order.push(`wake:${takeExplicitSyncRetry()}`); },
      describeError: () => 'x',
    });
    assert.deepEqual(order, ['request', 'wake:true']);
    assert.deepEqual(response, { ok: true, settled: true });
    assert.equal(takeExplicitSyncRetry(), false, 'a later automatic manual wake is not the person\'s Retry');
  });

  test('a pass that fails is logged and answered with its code; the request was still recorded', async () => {
    const logged: unknown[] = [];
    const requested = vi.fn();
    const response = await runManualRetry({ request: requested, wake: () => Promise.reject(new Error('indexeddb_unavailable')),
      describeError: error => (error as Error).message, onError: error => logged.push(error) });
    assert.deepEqual(response, { ok: false, error: 'indexeddb_unavailable' });
    assert.equal(requested.mock.calls.length, 1);
    assert.equal(logged.length, 1);
  });

  test('a wake that throws before it returns a promise is answered the same way', async () => {
    const response = await runManualRetry({ request: () => undefined, wake: () => { throw new Error('scope_unavailable'); },
      describeError: error => (error as Error).message });
    assert.deepEqual(response, { ok: false, error: 'scope_unavailable' });
  });

  test('still running when the pass outlasts the wait', async () => {
    vi.useFakeTimers();
    const answer = runManualRetry({ request: () => undefined, wake: () => new Promise<void>(() => undefined), describeError: () => 'x',
      waitMilliseconds: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    assert.deepEqual(await answer, { ok: true, settled: false });
  });
});

describe('the words after Retry', () => {
  test('says what happened: still running, worked, still failing with its code, unreadable', () => {
    assert.match(retryOutcomeCopy(false, undefined), /still running/u);
    assert.equal(retryOutcomeCopy(true, { problem: false }), 'Retried. Sync is running again.');
    assert.equal(retryOutcomeCopy(true, { problem: true, code: 'queue_state_invalid' }),
      'Retried, but sync still reports a problem (queue_state_invalid). Copy details to investigate.');
    assert.match(retryOutcomeCopy(true, undefined), /could not be read afterwards/u);
  });

  test('reads a problem from the attention facts: a stop, a lost permission or a recorded error', () => {
    assert.deepEqual(syncRetryReading(calm), { problem: false });
    assert.deepEqual(syncRetryReading(failing), { problem: true, code: 'queue_state_invalid' });
    assert.equal(syncRetryReading({ ...calm, permissionRequired: true })?.problem, true);
    assert.deepEqual(syncRetryReading({ ...calm, terminal: true, terminalCode: 'payload_too_large' }), { problem: true, code: 'payload_too_large' });
    assert.equal(syncRetryReading(undefined), undefined);
  });
});

describe('the Status card around Retry', () => {
  async function mount(reads: Array<PublicSyncAttention | undefined>, retry: unknown) {
    vi.useFakeTimers();
    let index = 0;
    const sendMessage = vi.fn(async (message: { kind: string }) => {
      if (message.kind === 'known.sync.attention.get') {
        const attention = reads[Math.min(index++, reads.length - 1)];
        return attention ? { ok: true, attention } : { ok: false, error: 'state_unavailable' };
      }
      if (message.kind === 'known.sync.engine.retry') return retry;
      return { ok: false, error: 'not_connected' };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const markup = await readFile('options.html', 'utf8');
    const start = markup.indexOf('<section id="sync-attention-settings"');
    document.body.innerHTML = markup.slice(start, markup.indexOf('<section id="native-wait-settings"', start));
    document.body.dataset.pane = 'sync';
    bindSyncAttentionSettings();
    await vi.advanceTimersByTimeAsync(0);
    return sendMessage;
  }
  const feedback = () => document.getElementById('sync-attention-settings-feedback')!;
  const press = async () => {
    (document.getElementById('sync-attention-settings-retry') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(0);
  };

  test('says it ran and sync is running again, after reading the status once more', async () => {
    const sendMessage = await mount([failing, calm], { ok: true, settled: true });
    assert.equal((document.getElementById('sync-attention-settings-retry') as HTMLButtonElement).hidden, false);
    await press();
    assert.equal(feedback().textContent, 'Retried. Sync is running again.');
    assert.equal(sendMessage.mock.calls.filter(([message]) => message.kind === 'known.sync.attention.get').length, 2);
    assert.equal(document.getElementById('sync-attention-settings-recovery')!.hidden, true, 'the card follows the new reading');
  });

  test('says sync still reports a problem, and which, when Retry changed nothing', async () => {
    await mount([failing, failing], { ok: true, settled: true });
    await press();
    assert.equal(feedback().textContent, 'Retried, but sync still reports a problem (queue_state_invalid). Copy details to investigate.');
  });

  test('says it is still running when the pass has not finished, and that the card will follow', async () => {
    await mount([failing, failing], { ok: true, settled: false });
    await press();
    assert.match(feedback().textContent!, /Retry is still running/u);
  });

  test('says it could not retry, with the code the worker gave', async () => {
    await mount([failing], { ok: false, error: 'indexeddb_unavailable' });
    await press();
    assert.equal(feedback().textContent, 'Could not retry sync. Copy details to investigate. (indexeddb_unavailable)');
  });
});

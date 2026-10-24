import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { repullsOnExplicitRetry } from '../src/sync-failure-class.js';
import { ack, emptyPullPage, json, scope, setup } from './durable-sync-engine-harness.js';

/**
 * W2C-01 / B-01 / C-02: a Pull-time integrity stop keeps its Session active, so authority refresh
 * rethrew the stored code without a request: Retry was a no-op whatever had caused the stop.
 * An explicit user Retry now re-requests from the durable cursor once. Automatic triggers
 * (alarms, captures, boots) still fail closed, and the cursor never moves past the failing page.
 */
async function frozenBy(code: string) {
  const f = await setup({ useRealPullApplier: true }); f.clock.now = Date.now();
  await f.store.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
    authorityRefreshRequired: true, notBefore: 0, lastError: code });
  await f.store.registerScope({ ...(await f.store.getScope(scope))!, lifecycle: 'recovery_required',
    metadata: { recoveryCode: code } });
  f.forcedSessions.push({ state: 'active', snapshotRequired: false, cursor: 'cursor-from-session' });
  return f;
}
const cursorsRequested = (f: Awaited<ReturnType<typeof setup>>) =>
  f.pullRequests.map((url) => new URL(url).searchParams.get('cursor'));

describe('one-shot re-pull for Pull-time integrity stops', () => {
  test('only Pull-time integrity codes are eligible', () => {
    for (const code of ['effect_page_failed', 'pull_page_invalid', 'pull_cursor_chain_invalid', 'refuse_rewind',
      'pull_event_conflict']) assert.equal(repullsOnExplicitRetry(code), true, code);
    // Snapshot-time stops re-run the recovery through their own Session state.
    for (const code of ['snapshot_invalid', 'snapshot_graph_incomplete', 'snapshot_conflict_page_invalid']) {
      assert.equal(repullsOnExplicitRetry(code), false, code);
    }
    for (const code of ['pull_invalid', 'network_unavailable', 'mapping_identity_conflict', undefined]) {
      assert.equal(repullsOnExplicitRetry(code), false, String(code));
    }
  });

  test('alarms and automatic manual wakes stay fail-closed; the user Retry re-pulls from the durable cursor', async () => {
    const f = await frozenBy('effect_page_failed');
    f.pullResponses.push(json(200, emptyPullPage('cursor-0')));
    f.ackResponses.push(json(200, ack('cursor-0')));
    for (const reason of ['alarm', 'manual', 'startup'] as const) {
      f.clock.now += 600_000;
      await f.engine.wake(reason);
    }
    assert.deepEqual(cursorsRequested(f), [], 'no automatic trigger re-pulls an integrity stop');
    assert.equal((await f.store.getEngineState(scope))?.lastError, 'effect_page_failed');

    f.clock.now += 600_000;
    const recovered = await f.engine.wake('manual', { explicitRetry: true });
    assert.deepEqual(cursorsRequested(f), ['cursor-0'], 'the durable cursor is requested, not the Session cursor');
    assert.equal(recovered?.recoveryFrozen, false);
    assert.equal(recovered?.lastError, undefined);
    assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
    assert.equal((await f.store.getScope(scope))?.checkpoint?.cursor, 'cursor-0');
    f.store.close();
  });

  test('a source that is still bad freezes again and the cursor does not advance', async () => {
    const f = await frozenBy('pull_cursor_chain_invalid');
    // An event-less page that moves the cursor is exactly what the real applier refuses.
    f.pullResponses.push(json(200, emptyPullPage('cursor-skipped')));
    f.clock.now += 600_000;
    const state = await f.engine.wake('manual', { explicitRetry: true });
    assert.deepEqual(cursorsRequested(f), ['cursor-0']);
    assert.equal(state?.lastError, 'pull_cursor_chain_invalid', 'the same integrity code reasserts');
    assert.equal(state?.recoveryFrozen, true);
    assert.equal(f.ackRequests.length, 0, 'nothing was acknowledged');
    const cursor = await f.store.getCursor(scope);
    assert.ok(cursor?.cursor === undefined || cursor.cursor === 'cursor-0', 'the cursor never moved past the failing page');
    assert.equal((await f.store.getScope(scope))?.checkpoint?.cursor, 'cursor-0');
    f.store.close();
  });
});

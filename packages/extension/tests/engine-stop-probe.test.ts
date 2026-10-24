import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { advanceSyncCircuit, STOP_PROBE_DELAYS_MS, stopProbeDelay, TRANSIENT_STALL_ATTEMPTS } from '../src/sync-circuit-breaker.js';
import { engineBackoffCap, engineBackoffDelay } from '../src/durable-sync-engine-backoff.js';
import { ack, emptyPullPage, json, scope, setup } from './durable-sync-engine-harness.js';

/**
 * A-F5 / A-F9 (Rule D): a stop-class code used to leave the engine inert for every alarm and
 * online wake. Only a user's Retry, a bookmark capture, a worker boot or a sign-in re-ran it, so
 * an idle browser could sit stopped for hours after the cause had gone. A stopped engine now
 * probes itself on a slow persisted schedule: 5 minutes, 15 minutes, 1 hour, then every 6 hours.
 */
const [FIRST, SECOND, THIRD, FOURTH] = STOP_PROBE_DELAYS_MS;

async function stopWith(f: Awaited<ReturnType<typeof setup>>, code: string, reason: 'alarm' | 'manual' = 'alarm') {
  f.sessionFailures.push(new Error(code));
  return f.engine.wake(reason);
}

describe('A-F5 stopped engines re-probe', () => {
  test('the schedule is 5 minutes, 15 minutes, 1 hour, then 6 hours for ever', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 20].map(stopProbeDelay), [FIRST, SECOND, THIRD, FOURTH, FOURTH, FOURTH]);
    assert.deepEqual([FIRST, SECOND, THIRD, FOURTH], [5 * 60_000, 15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
  });

  test('a stop writes its own breaker bucket, a due alarm probes and a failing probe waits longer', async () => {
    const f = await setup(); f.clock.now = Date.now();
    let state = await stopWith(f, 'pull_invalid');
    assert.equal(state?.phase, 'error');
    assert.equal(state?.lastError, 'pull_invalid');
    assert.deepEqual(state?.circuitBreaker?.failures.map((row) => row.code), ['stop:pull_invalid']);
    assert.equal(state?.circuitBreaker?.trips, 0);
    assert.equal(state?.notBefore, f.clock.now + FIRST, 'the next probe is persisted in the engine row');
    assert.deepEqual(f.scheduled.slice(-1), [FIRST], 'and armed as the engine alarm');

    // Alarms before the probe is due stay inert and re-arm the alarm for the remaining time.
    const calls = f.sessionForces.length;
    f.clock.now += FIRST - 60_000;
    for (const reason of ['alarm', 'online', 'startup'] as const) await f.engine.wake(reason, { connectivityRestored: true });
    assert.equal(f.sessionForces.length, calls, 'nothing contacts the server before the probe is due');
    assert.deepEqual(f.scheduled.slice(-1), [60_000]);

    for (const [index, delay] of [SECOND, THIRD, FOURTH, FOURTH].entries()) {
      f.clock.now = state!.notBefore;
      const before = f.sessionForces.length;
      state = await stopWith(f, 'pull_invalid');
      assert.equal(f.sessionForces.length, before + 1, `probe ${index + 1} contacted the server once`);
      assert.equal(state?.phase, 'error');
      assert.equal(state?.circuitBreaker?.trips, index + 1);
      assert.equal(state?.notBefore, f.clock.now + delay, `probe ${index + 1} waits ${delay} ms`);
    }
    f.store.close();
  });

  test('a probe that finds the cause gone returns the engine to sleep and clears the breaker', async () => {
    const f = await setup(); f.clock.now = Date.now();
    const stopped = await stopWith(f, 'pull_invalid');
    f.clock.now = stopped!.notBefore;
    f.pullResponses.push(json(200, emptyPullPage('cursor-fixed'))); f.ackResponses.push(json(200, ack('cursor-fixed')));
    const recovered = await f.engine.wake('alarm');
    assert.equal(recovered?.phase, 'sleeping');
    assert.equal(recovered?.lastError, undefined);
    assert.equal(recovered?.circuitBreaker, undefined);
    f.store.close();
  });

  test('a user Retry probes at once and does not move the automatic schedule on', async () => {
    const f = await setup(); f.clock.now = Date.now();
    let state = await stopWith(f, 'pull_invalid');
    f.clock.now = state!.notBefore;
    state = await stopWith(f, 'pull_invalid'); // automatic probe: trips 1
    assert.equal(state?.circuitBreaker?.trips, 1);
    for (let retry = 0; retry < 4; retry += 1) {
      f.clock.now += 1_000;
      const before = f.sessionForces.length;
      state = await stopWith(f, 'pull_invalid', 'manual');
      assert.equal(f.sessionForces.length, before + 1, 'Retry bypasses the schedule');
      assert.equal(state?.circuitBreaker?.trips, 1, 'a user pressing Retry does not push the next probe to 6 hours');
      assert.equal(state?.notBefore, f.clock.now + SECOND, 're-armed at the delay already reached');
    }
    f.store.close();
  });

  test('an error state written before probes existed is probed by the next alarm', async () => {
    const f = await setup(); f.clock.now = Date.now();
    await f.store.transitionEngine(scope, { phase: 'error', updatedAt: f.clock.now, recoveryFrozen: false,
      authorityRefreshRequired: false, notBefore: 0, lastError: 'queue_state_invalid' });
    const before = f.sessionForces.length;
    f.sessionFailures.push(new Error('queue_state_invalid'));
    const state = await f.engine.wake('alarm');
    assert.equal(f.sessionForces.length, before + 1);
    assert.equal(state?.circuitBreaker?.failures[0]?.code, 'stop:queue_state_invalid');
    assert.equal(state?.notBefore, f.clock.now + FIRST);
    f.store.close();
  });

  test('the probe has its own wake reason and also passes the stop gate', async () => {
    const f = await setup(); f.clock.now = Date.now();
    const stopped = await stopWith(f, 'ack_invalid');
    f.clock.now = stopped!.notBefore;
    f.pullResponses.push(json(200, emptyPullPage('cursor-probe'))); f.ackResponses.push(json(200, ack('cursor-probe')));
    const state = await f.engine.wake('probe');
    assert.equal(state?.phase, 'sleeping');
    f.store.close();
  });

  test('integrity stops stay explicit-retry only: alarms never probe them', async () => {
    const f = await setup(); f.clock.now = Date.now();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      f.sessionFailures.push(new Error('snapshot_invalid'));
      const state = await f.engine.wake(attempt === 0 ? 'manual' : 'startup');
      f.clock.now = Math.max(f.clock.now + 1_000, state!.notBefore);
    }
    const stopped = (await f.store.getEngineState(scope))!;
    assert.equal(stopped.phase, 'error');
    assert.equal(stopped.circuitBreaker?.failures[0]?.code, 'replica_integrity_refresh');
    const calls = f.sessionForces.length;
    f.clock.now += 24 * 3_600_000;
    for (const reason of ['alarm', 'startup', 'online'] as const) await f.engine.wake(reason);
    assert.equal(f.sessionForces.length, calls);
    f.store.close();
  });
});

describe('C-16 / W2C-06 the transient class is bounded', () => {
  test('a waiting code that repeats without progress becomes a named stalled state with a slow probe', async () => {
    const f = await setup(); f.clock.now = Date.now();
    let state: Awaited<ReturnType<typeof f.engine.wake>> = null; let failedAt = 0;
    for (let attempt = 1; attempt <= TRANSIENT_STALL_ATTEMPTS; attempt += 1) {
      f.sessionFailures.push(new Error('session_handoff_pending'));
      failedAt = f.clock.now;
      state = await f.engine.wake('alarm');
      assert.equal(state?.phase === 'error', attempt === TRANSIENT_STALL_ATTEMPTS, `attempt ${attempt}`);
      f.clock.now = Math.max(f.clock.now + 1_000, state!.notBefore);
    }
    assert.equal(state?.lastError, 'session_handoff_pending');
    assert.deepEqual(state?.circuitBreaker?.failures.map((row) => row.code), ['stalled:session_handoff_pending']);
    assert.ok(state!.notBefore >= failedAt + FIRST, 'it waits for the slow probe, not 30 seconds');
    // The stalled state is probed on the stop schedule, and a user Retry still runs at once.
    const before = f.sessionForces.length;
    f.clock.now = failedAt + 60_000;
    await f.engine.wake('alarm');
    assert.equal(f.sessionForces.length, before, 'alarms before the probe is due stay inert');
    f.sessionFailures.push(new Error('session_handoff_pending'));
    await f.engine.wake('manual');
    assert.equal(f.sessionForces.length, before + 1, 'Retry bypasses the schedule');
    f.store.close();
  });

  test('network outages keep polling (no stalled state) but at a growing interval', async () => {
    assert.deepEqual([1, 6, 7, 12, 13, 20, 21, 80].map(engineBackoffCap),
      [30_000, 30_000, 120_000, 120_000, 300_000, 300_000, 900_000, 900_000]);
    assert.equal(engineBackoffDelay(3, 17_000, () => 0.5), 17_000, 'a server Retry-After wins');
    assert.equal(engineBackoffDelay(1, undefined, () => 0.5), 1_000);
    assert.equal(engineBackoffDelay(25, undefined, () => 1), 900_000);
    const network = advanceSyncCircuit(undefined, 'network_unavailable', 'p', 1, { consecutiveFailures: 400 });
    const server = advanceSyncCircuit(undefined, 'server_unavailable', 'p', 1, { consecutiveFailures: 400 });
    assert.equal(network, undefined, 'an outage is never "stalled": the connectivity event or the server ends it');
    assert.equal(server, undefined);
    const waiting = advanceSyncCircuit(undefined, 'pull_page_pending', 'p', 1, { consecutiveFailures: TRANSIENT_STALL_ATTEMPTS });
    assert.equal(waiting?.retryAt, 1 + FIRST);
  });
});

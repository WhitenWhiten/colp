import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import {
  advanceSyncCircuit, CIRCUIT_THRESHOLD, CLOCK_STEP_TOLERANCE_MS, deadlineHolds, STOP_PROBE_DELAYS_MS, stopProbeDue,
} from '../src/sync-circuit-breaker.js';
import { ack, emptyPullPage, json, setup } from './durable-sync-engine-harness.js';

/**
 * W2B-P3-2: the breaker and the engine keep absolute epoch times. A clock that ran ahead and was corrected left a
 * deadline hours away that alarm wakes kept honouring, and a clock that stepped back made the breaker forget the
 * failures it had counted.
 */
const HOUR = 3_600_000;
const [FIRST] = STOP_PROBE_DELAYS_MS;

describe('a stored deadline and the clock that measures it', () => {
  const row = (notBefore: number, updatedAt: number) => ({ notBefore, updatedAt });

  test('holds until it passes, as before', () => {
    assert.equal(deadlineHolds(row(10_000, 9_000), 9_500), true);
    assert.equal(deadlineHolds(row(10_000, 9_000), 10_000), false);
    assert.equal(deadlineHolds(row(0, 9_000), 9_500), false);
  });

  test('jitter of a clock that reads a few seconds before the write still holds', () => {
    assert.equal(deadlineHolds(row(100_000, 60_000), 60_000 - 6_500), true);
    assert.equal(deadlineHolds(row(100_000, 60_000), 60_000 - CLOCK_STEP_TOLERANCE_MS), true);
  });

  test('a clock corrected by more than the tolerance ends the wait instead of stretching it', () => {
    const written = 10 * HOUR; const ahead = 3 * HOUR;
    const deadline = row(written + ahead + 30_000, written + ahead);
    assert.equal(deadlineHolds(deadline, written + 1_000), false, 'the excursion is over; the wait is');
    assert.equal(deadlineHolds(deadline, written + ahead - CLOCK_STEP_TOLERANCE_MS - 1), false);
    assert.equal(stopProbeDue({ ...deadline, phase: 'error' } as never, written + 1_000), true);
  });
});

describe('the breaker keeps the failures it counted when the clock steps back', () => {
  test('failures stamped by a clock that read later still count (five trip the cooldown)', () => {
    let breaker: ReturnType<typeof advanceSyncCircuit>;
    for (let attempt = 0; attempt < CIRCUIT_THRESHOLD - 1; attempt += 1) {
      breaker = advanceSyncCircuit(breaker, 'unexpected_external_code', 'p', 5_000_000 + attempt);
      assert.equal(breaker?.retryAt, undefined);
    }
    // The computer's clock is corrected by more than an hour; the next failure is stamped long before the earlier ones.
    breaker = advanceSyncCircuit(breaker, 'unexpected_external_code', 'p', 1_000_000);
    assert.equal(breaker?.failures[0]?.attempts.length, CIRCUIT_THRESHOLD);
    assert.ok(breaker?.retryAt !== undefined, 'the fifth failure of the window trips it');
    assert.deepEqual(breaker.failures[0]?.attempts.every((at) => at <= 1_000_000), true, 'none of them stays in the future');
  });

  test('the stop bucket keeps its attempts too', () => {
    let breaker = advanceSyncCircuit(undefined, 'queue_state_invalid', 'p', 9_000_000);
    breaker = advanceSyncCircuit(breaker, 'queue_state_invalid', 'p', 1_000_000, { probe: true });
    assert.deepEqual(breaker?.failures[0]?.attempts, [1_000_000, 1_000_000]);
  });
});

describe('an engine whose clock ran ahead and was corrected', () => {
  test('a backoff written under the wrong clock is over when the original wait is, not hours later', async () => {
    const f = await setup(); const real = Date.now();
    f.clock.now = real + 3 * HOUR;
    f.sessionFailures.push(new Error('network_unavailable'));
    const failed = await f.engine.wake('alarm');
    assert.equal(failed?.phase, 'offline');
    assert.ok(failed!.notBefore > f.clock.now, 'a wait was written on the clock that ran ahead');
    f.clock.now = real + 60_000;
    const before = f.sessionForces.length;
    f.pullResponses.push(json(200, emptyPullPage('cursor-corrected'))); f.ackResponses.push(json(200, ack('cursor-corrected')));
    const resumed = await f.engine.wake('alarm');
    assert.equal(f.sessionForces.length, before + 1, 'the alarm reaches the server');
    assert.equal(resumed?.lastError, undefined);
    f.store.close();
  });

  test('without a correction the backoff is honoured exactly as before', async () => {
    const f = await setup(); f.clock.now = Date.now();
    f.sessionFailures.push(new Error('network_unavailable'));
    const failed = await f.engine.wake('alarm');
    const before = f.sessionForces.length;
    f.clock.now = failed!.updatedAt - 6_500; // jitter of a few seconds, not a correction
    await f.engine.wake('alarm');
    assert.equal(f.sessionForces.length, before, 'an alarm that fires inside the wait does nothing');
    f.store.close();
  });

  test('a stop probe scheduled under the wrong clock is probed after the five minutes it asked for', async () => {
    const f = await setup(); const real = Date.now();
    f.clock.now = real + 3 * HOUR;
    f.sessionFailures.push(new Error('pull_invalid'));
    const stopped = await f.engine.wake('alarm');
    assert.equal(stopped?.phase, 'error');
    assert.equal(stopped?.notBefore, f.clock.now + FIRST);
    f.clock.now = real + 60_000;
    const before = f.sessionForces.length;
    f.pullResponses.push(json(200, emptyPullPage('cursor-probe'))); f.ackResponses.push(json(200, ack('cursor-probe')));
    const probed = await f.engine.wake('alarm');
    assert.equal(f.sessionForces.length, before + 1, 'the probe is due once the clock is right');
    assert.equal(probed?.phase, 'sleeping');
    f.store.close();
  });
});

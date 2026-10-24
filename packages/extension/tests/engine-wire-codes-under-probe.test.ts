import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { advanceSyncCircuit, STOP_PROBE_DELAYS_MS, TRANSIENT_STALL_ATTEMPTS } from '../src/sync-circuit-breaker.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';
import { ack, emptyPullPage, json, setup } from './durable-sync-engine-harness.js';

/**
 * Merge check of the wire codes (stream 1) against the stop probe and the stalled-wait rule (stream 2, A-F5 / C-16):
 * a definitive refusal is a stop that is probed on the slow schedule; an outage, whoever words it, keeps polling; a wait
 * for a person or for the browser becomes a named stalled wait after 20 wakes; an authority refusal is still counted
 * under its own code and ends in a cooldown.
 */
const [FIRST] = STOP_PROBE_DELAYS_MS;
const buckets = (breaker: ReturnType<typeof advanceSyncCircuit>) => breaker?.failures.map((row) => row.code);

describe('definitive refusals are stops, probed 5 minutes later', () => {
  const STOPS = ['snapshot_too_large', 'server_version_mismatch', 'session_replica_unknown', 'replica_retired',
    'manifest_unavailable', 'origin_not_allowed', 'invalid_query', 'idempotency_key_reused'];

  test.each(STOPS)('%s', (code) => {
    assert.equal(classifySyncFailure(code)?.exit, 'stop');
    const breaker = advanceSyncCircuit(undefined, code, 'p', 1_000);
    assert.deepEqual(buckets(breaker), [`stop:${code}`]);
    assert.equal(breaker?.retryAt, 1_000 + FIRST);
  });

  test('an engine that meets one stops, and a probe finds the cause gone', async () => {
    const f = await setup(); f.clock.now = Date.now();
    f.sessionFailures.push(new Error('server_version_mismatch'));
    const stopped = await f.engine.wake('alarm');
    assert.equal(stopped?.phase, 'error');
    assert.equal(stopped?.lastError, 'server_version_mismatch');
    assert.equal(stopped?.notBefore, f.clock.now + FIRST, 'the first probe is five minutes away');
    f.clock.now = stopped!.notBefore;
    f.pullResponses.push(json(200, emptyPullPage('cursor-updated'))); f.ackResponses.push(json(200, ack('cursor-updated')));
    const recovered = await f.engine.wake('alarm');
    assert.equal(recovered?.phase, 'sleeping');
    assert.equal(recovered?.lastError, undefined);
    f.store.close();
  });
});

describe('an outage the server words itself keeps polling', () => {
  test.each(['service_unavailable', 'internal_error', 'snapshot_503_service_unavailable', 'snapshot_500_internal_error',
    'snapshot_http_408'])('%s is never a stalled wait, however long it lasts', (code) => {
    assert.equal(advanceSyncCircuit(undefined, code, 'p', 1, { consecutiveFailures: 400 }), undefined);
  });

  test('a Session answered 503 with the server\'s Problem code backs off for ever instead of stopping the engine', async () => {
    const f = await setup(); f.clock.now = Date.now();
    let state: Awaited<ReturnType<typeof f.engine.wake>> = null;
    for (let attempt = 1; attempt <= TRANSIENT_STALL_ATTEMPTS + 5; attempt += 1) {
      f.sessionFailures.push(new Error('service_unavailable'));
      state = await f.engine.wake('alarm');
      assert.notEqual(state?.phase, 'error', `attempt ${attempt}`);
      f.clock.now = Math.max(f.clock.now + 1_000, state!.notBefore);
    }
    assert.equal(state?.lastError, 'service_unavailable');
    assert.equal(state?.circuitBreaker, undefined);
    f.store.close();
  });
});

describe('a wait for a person or for the browser is a named stalled wait after 20 wakes', () => {
  test.each(['server_configuration_failed', 'bookmark_api_error', 'bookmark_write_quota', 'native_read_failed'])('%s', (code) => {
    assert.equal(advanceSyncCircuit(undefined, code, 'p', 1, { consecutiveFailures: TRANSIENT_STALL_ATTEMPTS - 1 }), undefined);
    const stalled = advanceSyncCircuit(undefined, code, 'p', 1, { consecutiveFailures: TRANSIENT_STALL_ATTEMPTS });
    assert.deepEqual(buckets(stalled), [`stalled:${code}`]);
    assert.equal(stalled?.retryAt, 1 + FIRST);
  });

  test('granting the site access again runs the engine at once, even from the stalled wait', async () => {
    const f = await setup(); f.clock.now = Date.now();
    let state: Awaited<ReturnType<typeof f.engine.wake>> = null;
    for (let attempt = 1; attempt <= TRANSIENT_STALL_ATTEMPTS; attempt += 1) {
      f.sessionFailures.push(new Error('server_configuration_failed'));
      state = await f.engine.wake('alarm');
      f.clock.now = Math.max(f.clock.now + 1_000, state!.notBefore);
    }
    assert.equal(state?.phase, 'error');
    assert.deepEqual(buckets(state?.circuitBreaker), ['stalled:server_configuration_failed']);
    // `permissions.onAdded` wakes the engine as a manual pass (sw/server-permission.ts), which no schedule holds back.
    f.pullResponses.push(json(200, emptyPullPage('cursor-granted'))); f.ackResponses.push(json(200, ack('cursor-granted')));
    const resumed = await f.engine.wake('manual');
    assert.equal(resumed?.phase, 'sleeping');
    assert.equal(resumed?.circuitBreaker, undefined);
    f.store.close();
  });
});

describe('a refused credential is counted under its own code and ends in a cooldown', () => {
  test.each(['authentication_required', 'credential_revoked', 'insufficient_scope', 'resource_not_found', 'session_invalid'])('%s', (code) => {
    const first = advanceSyncCircuit(undefined, code, 'p', 1_000);
    assert.deepEqual(buckets(first), [code]);
    assert.equal(first?.retryAt, undefined, 'one refusal is not a stop');
    let breaker = first;
    for (let attempt = 1; attempt < 5; attempt += 1) breaker = advanceSyncCircuit(breaker, code, 'p', 1_000 + attempt);
    assert.deepEqual(buckets(breaker), [code]);
    assert.ok(breaker?.retryAt !== undefined && breaker.retryAt > 1_004, 'five refusals in a row trip the cooldown');
  });
});

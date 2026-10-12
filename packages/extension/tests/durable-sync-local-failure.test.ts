import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SyncStateError } from '../src/sync-state-store.js';
import { ack, emptyPullPage, json, scope, setup } from './durable-sync-engine-harness.js';

test('persists a structured local error code when its diagnostic message includes field context', async () => {
    const fixture = await setup();
    fixture.sessionFailures.push(new SyncStateError('bounded_string_invalid', 'sessionId: bounded_string_invalid'));

    await fixture.engine.wake('manual');

    const state = (await fixture.store.getEngineState(scope))!;
    assert.equal(state.phase, 'error');
    assert.equal(state.lastError, 'bounded_string_invalid');
    const calls = fixture.sessionForces.length;
    await fixture.engine.wake('alarm');
    assert.equal(fixture.sessionForces.length, calls, 'a persistent local failure does not retry on an alarm');
    fixture.pullResponses.push(json(200, emptyPullPage('cursor-retry')));
    fixture.ackResponses.push(json(200, ack('cursor-retry')));
    await fixture.engine.wake('manual');
    assert.notEqual((await fixture.store.getEngineState(scope))?.phase, 'error');
  });

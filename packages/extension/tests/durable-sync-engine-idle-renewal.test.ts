import assert from 'node:assert/strict';
import { test } from 'vitest';
import { emptyPullPage, json, problem, scope, setup } from './durable-sync-engine-harness.js';

test('refresh after a stale Ack confirms the Session cursor and sleeps without another Ack', async () => {
  const f = await setup({ useRealPullApplier: true });
  try {
    f.pullResponses.push(json(200, emptyPullPage('cursor-reissued'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    f.ackResponses.push(problem(410, 'stale_replica', {}));
    await f.engine.wake('manual');
    assert.equal((await f.store.getEngineState(scope))?.phase, 'recovery');
    assert.equal((await f.store.getEngineState(scope))?.authorityRefreshRequired, true);
    assert.equal(await f.store.getPendingAckIntent(scope), null);

    f.forcedSessions.push({ sessionId: 'session-fresh', state: 'active',
      snapshotRequired: false, cursor: 'cursor-fresh' });
    f.pullResponses.push(json(200, emptyPullPage('cursor-fresh')));
    f.order.length = 0;
    f.clock.now += 30_000;
    await f.engine.wake('alarm');
    assert.deepEqual(f.order, ['resume', 'pull:cursor-fresh', 'stage:cursor-fresh', 'resume']);
    assert.equal(f.ackRequests.length, 1);
    assert.equal(f.sessionForces.filter(Boolean).length, 1);
    const state = await f.store.getEngineState(scope);
    assert.equal(state?.phase, 'sleeping');
    assert.equal(state?.sessionId, 'session-fresh');
    assert.equal(state?.lastPublishedCursor, 'cursor-fresh');
    assert.equal(state?.lastAckedCursor, 'cursor-fresh');
    assert.equal(state?.recoveryFrozen, false);
    assert.equal(state?.authorityRefreshRequired, false);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-fresh');
    assert.equal(f.snapshotRequests.length, 0);

    // A subsequent idle wake must also stay healthy without renewing or Acking.
    f.pullResponses.push(json(200, emptyPullPage('cursor-fresh')));
    f.clock.now += 30_000;
    await f.engine.wake('alarm');
    assert.equal((await f.store.getEngineState(scope))?.phase, 'sleeping');
    assert.equal(f.ackRequests.length, 1);
    assert.equal(f.sessionForces.filter(Boolean).length, 1);
  } finally { f.store.close(); }
});

test('a discarded pending Pull Ack freezes recovery and stops the wake', async () => {
  const f = await setup({ useRealPullApplier: true });
  try {
    f.pullResponses.push(json(200, emptyPullPage('cursor-pending'), { 'Known-Sync-Cursor-Reissued': 'true' }));
    f.ackResponses.push(problem(503, 'internal_error', {}));
    await f.engine.wake('manual');
    const pending = await f.store.getPendingAckIntent(scope);
    assert.equal(pending?.cursor, 'cursor-pending');
    f.ackResponses.push(problem(410, 'stale_replica', {}));
    f.order.length = 0;
    f.clock.now += 30_000;
    await f.engine.wake('alarm');
    const state = await f.store.getEngineState(scope);
    assert.deepEqual(f.order, ['ack:cursor-pending']);
    assert.equal(state?.phase, 'recovery');
    assert.equal(state?.recoveryFrozen, true);
    assert.equal(state?.authorityRefreshRequired, true);
    assert.equal(state?.lastError, 'pull_ack_discarded');
    assert.equal(await f.store.getPendingAckIntent(scope), null);
    assert.equal(f.pullRequests.length, 1);
    assert.deepEqual(f.ackRequests[1], f.ackRequests[0]);
    assert.equal(f.scheduled.at(-1), 1_000);
  } finally { f.store.close(); }
});

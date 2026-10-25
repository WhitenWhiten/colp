import assert from 'node:assert/strict';
import { test } from 'vitest';
import { scope, setup } from './durable-sync-engine-harness.js';

test('a retained retired scope never sends queued work', async () => {
  const f = await setup({ instrumentStore: store => ({ ...store, getScope: async input => {
    const row = await store.getScope(input);
    return row ? { ...row, lifecycle: 'retired' as const } : null;
  } }) });
  try {
    await f.enqueue('retired-1');
    const state = await f.engine.wake('startup');
    assert.equal(state?.phase, 'retired');
    assert.equal(state?.recoveryFrozen, true);
    assert.equal(f.sessionForces.length, 0);
    assert.equal(f.push.calls, 0);
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'pending');
  } finally { f.store.close(); }
});

for (const code of ['stale_replica', 'sync_cursor_expired']) {
  test(`a frozen ${code} schedules authority recovery before sending anything`, async () => {
    const f = await setup();
    try {
      await f.enqueue('frozen-1');
      await f.store.transitionEngine(scope, { phase: 'sleeping', updatedAt: f.clock.now,
        recoveryFrozen: true, authorityRefreshRequired: false, notBefore: 0, lastError: code });
      const state = await f.engine.wake('manual');
      assert.equal(state?.phase, 'recovery');
      assert.equal(state?.authorityRefreshRequired, true);
      assert.equal(state?.recoveryFrozen, true);
      assert.deepEqual(f.scheduled, [1000]);
      assert.equal(f.sessionForces.length, 0);
      assert.equal(f.push.calls, 0);
    } finally { f.store.close(); }
  });
}

test('a competing connectivity claim leaves its owner to probe and re-arms the deadline', async () => {
  const f = await setup({ instrumentStore: store => ({ ...store,
    claimRestartConnectivity: async (...args) => {
      // Another worker wins after this wake read the engine revision.
      assert.equal((await store.claimRestartConnectivity(...args)).outcome, 'claimed');
      return store.claimRestartConnectivity(...args);
    },
  }) });
  try {
    await f.store.transitionEngine(scope, { phase: 'offline', updatedAt: f.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: f.clock.now + 60_000,
      lastError: 'network_unavailable' });
    const state = await f.engine.wake('startup');
    assert.notEqual(state?.connectivityConfirmationRevision, undefined);
    assert.deepEqual(f.scheduled, [15_000]);
    assert.equal(f.sessionForces.length, 0);
    assert.equal(f.push.calls, 0);
    assert.equal(f.pullRequests.length, 0);
  } finally { f.store.close(); }
});

test('an interrupted bootstrap cannot use ordinary active authority to upload', async () => {
  const f = await setup();
  try {
    await f.enqueue('bootstrap-1');
    await f.store.transitionEngine(scope, { phase: 'bootstrap', updatedAt: f.clock.now,
      recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0 });
    const state = await f.engine.wake('manual');
    assert.equal(state?.lastError, 'session_authority_invalid');
    assert.equal(f.push.calls, 0);
    assert.equal(f.pullRequests.length, 0);
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'pending');
  } finally { f.store.close(); }
});

test('a push requesting recovery yields without a subsequent Pull or Ack', async () => {
  const f = await setup();
  try {
    await f.enqueue('recover-1');
    f.push.outcomes.push('recovery');
    await f.engine.wake('manual');
    assert.equal(f.push.calls, 1);
    assert.equal(f.pullRequests.length, 0);
    assert.equal(f.ackRequests.length, 0);
    assert.equal((await f.store.listQueue(scope))[0]?.status, 'pending');
  } finally { f.store.close(); }
});

import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { createPullApplier } from '../src/pull-applier.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

test.each(['update', 'move'] as const)('recovers a completed %s from native state without replaying it', async kind => {
  const fixture = await setup('after_browser_call');
  try {
    await fixture.applier.stage(fixture.page([fixture.mutationEvent(kind)]));
    await assert.rejects(fixture.applier.resume(), /worker_crash/);
    const calls = fixture.api.calls.filter(call => call.kind === kind).length;
    assert.equal(calls, 1);
    await createPullApplier(fixture.options).resume();
    assert.equal(fixture.api.calls.filter(call => call.kind === kind).length, calls);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-next');
    assert.equal((await fixture.store.listPullPages(scope, ['staged'])).length, 0);
  } finally { fixture.store.close(); }
});

test.each(['update', 'move'] as const)('a missing native target after a %s crash never advances the cursor', async kind => {
  const fixture = await setup('after_browser_call');
  try {
    await fixture.applier.stage(fixture.page([fixture.mutationEvent(kind)]));
    await assert.rejects(fixture.applier.resume(), /worker_crash/);
    await fixture.api.remove('native-node');
    await assert.rejects(createPullApplier(fixture.options).resume(), /pull_apply_target_missing/);
    assert.equal((await fixture.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.notEqual((await fixture.store.getCursor(scope))?.cursor, 'cursor-next');
    assert.equal(fixture.api.calls.filter(call => call.kind === kind).length, 1);
  } finally { fixture.store.close(); }
});

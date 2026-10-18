import assert from 'node:assert/strict';
import { test } from 'vitest';
import { t02Scope as scope } from './srg-t02-native-harness.js';
import { setupRecoveryWait } from './bootstrap-recovery-harness.js';

// Keep the production regression in the default unit suite without requiring Lean.
for (const interrupted of [false, true]) test(`bootstrap retains native holds and resumes after confirmation (interrupted=${interrupted})`, async () => {
  const r = await setupRecoveryWait({ interruptAfterAck: interrupted });
  try {
    if (interrupted) {
      await assert.rejects(r.engine().wake('startup'), /worker_crash/u);
      await (await r.restart()).wake('startup');
      assert.equal(r.acks.length, 2);
      assert.equal(r.acks[1], r.acks[0]);
    } else await r.engine().wake('startup');
    const held = (await r.fixture.store.getEngineState(scope))!;
    assert.equal(held.recoveryFrozen, true);
    assert.equal(held.authorityRefreshRequired, false);
    await r.confirmNative();
    r.clock.now = held.notBefore;
    const settled = await (await r.restart()).wake('startup');
    assert.equal(settled?.lastError, undefined);
    assert.equal(settled?.recoveryFrozen, false);
    assert.equal(settled?.authorityRefreshRequired, false);
    assert.equal((await r.fixture.store.getCursor(scope))?.cursor, 'active-cut');
    assert.equal(r.fixture.api.calls.filter(c => c.kind === 'create').length, 1);
  } finally { r.fixture.store.close(); }
});

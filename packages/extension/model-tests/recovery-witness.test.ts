import assert from 'node:assert/strict';
import { test } from 'vitest';
import { pendingNativeOrPullFacts } from '../src/native-repair.js';
import { mayUnfreezeForCompletedBootstrapAck } from '../src/bootstrap-ack-unfreeze.js';
import { t02Scope as scope } from '../tests/srg-t02-native-harness.js';
import { setupRecoveryWait } from './recovery-fixture.js';
import { vectors } from './model-vectors.js';

for (const branch of vectors.recoveryBranches) test(`Lean/engine bootstrap path witness (interrupted=${branch.interrupted})`, async () => {
  const { interrupted } = branch;
  const r = await setupRecoveryWait(interrupted);
  try {
    if (interrupted) {
      await assert.rejects(r.engine().wake('startup'), /worker_crash/u);
      await (await r.restart()).wake('startup');
      assert.equal(r.acks.length, 2);
      assert.equal(r.acks[1], r.acks[0], 'unknown Ack retries must retain exact request bytes');
    } else {
      const state = await r.engine().wake('startup');
      assert.equal(state?.lastError, undefined);
    }
    const f = r.fixture;
    const facts = await pendingNativeOrPullFacts(f.store, scope);
    assert.equal(facts.nativeResultUnknown, true);
    assert.equal(mayUnfreezeForCompletedBootstrapAck(facts), false);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'active-cut');
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 1);
    // Current implementation witness: fresh and resumed recovery disagree.
    assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, interrupted);
    await r.capture('final');
    assert.deepEqual(r.checkpoints, branch.checkpoints);
  } finally { r.fixture.store.close(); }
});

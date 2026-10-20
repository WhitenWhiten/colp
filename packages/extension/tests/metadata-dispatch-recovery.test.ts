import assert from 'node:assert/strict';
import { test } from 'vitest';
import { needsReplicaRebuild } from '../src/sync-failure-class.js';
import { terminalFreezeReasonCopy, syncAttentionTerminalCode } from '../src/sync-attention-ui.js';
import { setupRetirement } from './replica-retirement-harness.js';

test('opt-out stops immutable retries until the public reset confirms server retirement and archives the exact queue', async () => {
  const f = await setupRetirement();
  try {
    assert.equal((await f.store.getEngineState(f.scope))?.lastError, 'metadata_sync_disabled');
    // Re-enabling metadata alone cannot rewrite or release the frozen attempt.
    await f.policy.write(f.scope, true);
    assert.equal((await f.worker.drain()).outcome, 'recovery'); assert.equal(f.pushCalls, 1);
    await f.policy.write(f.scope, false);
    assert.equal(needsReplicaRebuild('metadata_sync_disabled'), true);
    assert.equal(syncAttentionTerminalCode(undefined, 'metadata_sync_disabled'), 'metadata_sync_disabled');
    assert.match(terminalFreezeReasonCopy('metadata_sync_disabled'), /Reset sync/);
    assert.deepEqual(await f.rebuilder.handle(await f.request()), { ok: true, result: 'setup_required' });
    assert.deepEqual((await f.store.exportArchive(f.scope)).queue, f.original);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.init.method, 'DELETE');
    assert.equal(f.requests[0]!.init.body, undefined); assert.equal(f.pushCalls, 1);
    assert.equal((await f.policy.read(f.scope)).mode, 'local-only');
  } finally { f.close(); }
});

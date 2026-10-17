import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createPullApplier } from '../src/pull-applier.js';
import { scope, setup } from './own-create-replay-harness.js';

for (const firstRun of ['running', 'completed'] as const) test.each(['change', 'move', 'remove'] as const)(
  `own-create replay recovers a lost %s callback with firstRun=${firstRun}`, async kind => {
    const f = await setup(firstRun);
    try {
      await createPullApplier(f.options).stage(f.page);
      if (kind === 'change') await f.api.update(f.node.id, { title: 'Edited while stopped' });
      else if (kind === 'move') {
        await f.store.putMapping(scope, { ...f.parent, nativeId: 'native-target', colpId: 'target-colp',
          parentNativeId: 'native-root' });
        f.api.seed({ id: 'native-target', parentId: 'native-root', title: 'Destination', index: 1 });
        await f.api.move(f.node.id, { parentId: 'native-target', index: 0 });
      } else await f.api.remove(f.node.id);
      // Resume with a new applier and no callback journal, as after worker eviction.
      await createPullApplier(f.options).resume();
      assert.ok(f.repairs() > 0);
      assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-next');
      assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
      await f.queue.flush();
      assert.equal((await f.store.listQueue(scope)).length, 1, 'repair waits for the exact create receipt');
      const lease = await f.store.acquireLease(scope, 'receipt-worker', 1, 30_000);
      const create = (await f.store.claimNextQueue(scope, 'receipt-worker', lease.fence, 1))!;
      await f.store.settleClaimedPush(scope, create.sequence, 'receipt-worker', lease.fence, {
        outcome: 'terminal', receipt: { opId: create.opId, operationDigest: create.digest, kind: 'terminal',
          receiptId: 'create-receipt', resultDigest: 'sha256:receipt', result: { results: [{ opId: create.opId,
            sequence: create.sequence, status: 'applied', targetId: f.remote.id,
            revision: f.remote.revision }] } },
        authoritativeCreate: { nativeId: f.node.id, targetId: f.remote.id, revision: f.remote.revision },
      });
      await f.queue.flush();
      const successor = (await f.store.listQueue(scope))[1]!;
      assert.equal(successor.payload.type, kind === 'change' ? 'update_node_content' : kind === 'move' ? 'move_node' : 'delete_node');
      assert.equal(successor.payload.targetId, f.remote.id);
      assert.equal(successor.baseRevision, f.remote.revision);
      assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
    } finally { f.store.close(); }
  });

test('replay proves the combined state of multiple unmapped edits without manufacturing another callback', async () => {
  const f = await setup('running');
  try {
    await f.store.putBootstrapRun(scope, { runId: 'bootstrap', confirmationId: 'bootstrap', phase: 'matching',
      bootstrapMode: 'merge', updatedAt: 1 });
    await f.store.deleteMapping(scope, f.node.id);
    await f.api.update(f.node.id, { title: 'Edited title' });
    await f.queue.changed(f.node.id, { title: 'Edited title' }, 'callback');
    await f.api.update(f.node.id, { url: 'https://example.test/edited' });
    await f.queue.changed(f.node.id, { url: 'https://example.test/edited' }, 'callback');
    await f.store.putMapping(scope, f.original);
    const applier = createPullApplier(f.options);
    await applier.stage(f.page); await applier.resume();
    assert.equal(f.repairs(), 0);
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 2);
  } finally { f.store.close(); }
});

test('a provisional mapping alone cannot authorize recovery of an unproven create', async () => {
  const f = await setup('completed', false);
  try {
    await f.api.update(f.node.id, { title: 'Unproven edit' });
    const applier = createPullApplier(f.options);
    await assert.rejects(async () => { await applier.stage(f.page); await applier.resume(); }, /recovery_required/);
    assert.equal(f.repairs(), 0);
    assert.equal((await f.store.getEngineState(scope))?.lastError, 'create_ambiguous');
    assert.equal((await f.store.listBookmarkEventsByStatus(scope, 'pending')).length, 0);
  } finally { f.store.close(); }
});

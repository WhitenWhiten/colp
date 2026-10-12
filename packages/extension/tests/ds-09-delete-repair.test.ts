import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { pendingNativeOrPullFacts, repairNativeSideEffects } from '../src/native-repair.js';
import { hasTerminalDeleteEvidence } from '../src/native-delete-executor.js';
import { reopenT03, seedMappedNode, setupT03, t03Scope } from './srg-t03-delete-harness.js';

test('DS-09 incomplete, failed or malformed member receipts cannot prove deletion complete', () => {
  const member = { colpId: 'node', nativeId: 'native' };
  for (const result of ['not_started', 'failed', 'unknown']) {
    assert.equal(hasTerminalDeleteEvidence({ liveWorkKind: 'delete', anchors: {
      deleteMemberSet: [member], deleteMemberResults: { node: result },
    } }), false);
  }
  for (const members of [[], [member, member], [member, null], [{ colpId: 'node' }]]) {
    assert.equal(hasTerminalDeleteEvidence({ liveWorkKind: 'delete', anchors: {
      deleteMemberSet: members, deleteMemberResults: { node: 'applied' },
    } }), false);
  }
  assert.equal(hasTerminalDeleteEvidence({ liveWorkKind: 'delete', anchors: {
    deleteMemberSet: [member], deleteMemberResults: {},
  } }), false);
});

test.each([false, true])('DS-09 completed deletion stays settled after repair (legacy unknown=%s)', async (legacy) => {
  const f = await setupT03();
  await seedMappedNode(f, { nativeId: 'deleted', colpId: 'node-1', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'bookmark' });
  await f.applier.stage(f.page([f.mutationEvent('delete')]));
  await f.applier.resume();
  const resumed = await reopenT03(f);
  assert.equal(f.api.getNode('deleted'), undefined);
  assert.equal((await resumed.store.listApplyIntents(t03Scope))[0]?.state, 'page_complete');
  if (legacy) {
    const intent = (await resumed.store.listApplyIntents(t03Scope))[0]!;
    await resumed.store.persistApplyIntentFacts(t03Scope, intent.intentId, {
      nativeResult: 'result_unknown', waitReason: 'native_result_unknown', replayState: 'awaiting_receipt',
      eventState: 'awaiting_confirmation',
    });
  }
  await repairNativeSideEffects(resumed.store, t03Scope, f.api);
  assert.deepEqual(await pendingNativeOrPullFacts(resumed.store, t03Scope), {
    pendingIncompletePull: false, nativeResultUnknown: false,
  });
});

test.each([false, true])('DS-09 partial deletion resumes its fixed members (legacy unknown=%s)', async (legacy) => {
  const f = await setupT03('after_delete_member');
  await seedMappedNode(f, { nativeId: 'folder', colpId: 'node-1', parentNativeId: 'native-root',
    parentColpId: 'root-colp', nodeKind: 'folder' });
  await seedMappedNode(f, { nativeId: 'child', colpId: 'node-2', parentNativeId: 'folder',
    parentColpId: 'node-1', nodeKind: 'bookmark' });
  await f.applier.stage(f.page([f.subtreeEvent(['node-1', 'node-2'])]));
  await assert.rejects(() => f.applier.resume(), /worker_crash/);
  const resumed = await reopenT03(f);
  if (legacy) {
    const intent = (await resumed.store.listApplyIntents(t03Scope))[0]!;
    await resumed.store.persistApplyIntentFacts(t03Scope, intent.intentId, {
      nativeResult: 'result_unknown', waitReason: 'native_result_unknown', replayState: 'awaiting_receipt',
      eventState: 'awaiting_confirmation',
    });
  }
  await repairNativeSideEffects(resumed.store, t03Scope, f.api);
  assert.equal((await pendingNativeOrPullFacts(resumed.store, t03Scope)).nativeResultUnknown, false);
  assert.notEqual((await resumed.store.getCursor(t03Scope))?.cursor, 'cursor-next');
  await resumed.applier.resume();
  assert.equal(f.api.getNode('child'), undefined);
  assert.equal(f.api.getNode('folder'), undefined);
  assert.equal((await resumed.store.getCursor(t03Scope))?.cursor, 'cursor-next');
});

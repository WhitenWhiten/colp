import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { executeAdvancedRemoteStep } from '../src/bootstrap/advanced-remote-executor.js';
import { repairUnmountedRangeMappings } from '../src/unmounted-range-repair.js';
import type { AdvancedStep } from '../src/bootstrap/advanced-plan-types.js';
import { setupT03, mapping, t03Scope as scope } from './srg-t03-delete-harness.js';

const step: Extract<AdvancedStep, { side: 'remote'; action: 'delete' }> = {
  stepId: 'delete-folder', order: 1, dependsOn: [], side: 'remote', action: 'delete', operation: 'delete_subtree',
  target: { nodeId: 'node-1' }, payload: { type: 'delete_subtree', targetId: 'node-1', baseRevision: 'revision-old' },
  before: { nodeId: 'node-1', parentId: 'root-colp', kind: 'folder', title: 'Deleted folder', revision: 'revision-old' }, after: null,
};
async function fixture() {
  const f = await setupT03();
  await f.store.putMapping(scope, mapping('unmounted:node-1', 'node-1', { nodeKind: 'folder',
    parentColpId: 'root-colp', parentNativeId: 'native-root' }));
  return f;
}

test('startup repair respects an active advanced plan before its first delete receipt', async () => {
  const f = await fixture();
  await f.store.commitAdvancedPlan(scope, { planId: 'plan', metadata: { mode: 'upload' }, steps: [JSON.parse(JSON.stringify(step))], now: 1 });
  assert.equal((await repairUnmountedRangeMappings(f.store, scope, f.api)).filled, 0);
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
});

test('confirmed remote deletion cannot be resurrected before Pull, while a later restore is repairable', async () => {
  const f = await fixture();
  const input = { store: f.store, scope, step, planId: 'plan', completed: [] };
  assert.equal((await executeAdvancedRemoteStep(input)).state, 'waiting');
  const row = (await f.store.listQueue(scope))[0]!;
  await f.store.completeQueueWithReceipt(scope, row.sequence, { opId: row.opId, operationDigest: row.digest,
    kind: 'terminal', receiptId: 'delete-receipt', resultDigest: 'sha256:receipt', result: { results: [{
      opId: row.opId, sequence: row.sequence, status: 'applied', targetId: 'node-1', revision: 'deleted-r1', cursor: 'delete-cursor' }] } });
  assert.equal((await executeAdvancedRemoteStep(input)).state, 'complete');
  assert.equal((await repairUnmountedRangeMappings(f.store, scope, f.api)).filled, 0);
  assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
  await f.store.putRemoteObservation(scope, { colpId: 'node-1', kind: 'placement', remoteRevision: 'restore-r2',
    cursor: 'restore-cursor', payload: { parentId: 'root-colp' }, sourceDigest: 'sha256:restore', observedAt: Date.now() + 1 });
  assert.equal((await repairUnmountedRangeMappings(f.store, scope, f.api)).filled, 1);
});

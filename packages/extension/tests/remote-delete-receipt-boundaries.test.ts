import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, test } from 'vitest';
import { collectSubtreeNativeIds, interceptStagedRemoteDelete } from '../src/remote-delete-apply.js';
import { enqueueRemoteDeleteRestore } from '../src/remote-delete-restore.js';
import { remoteDeleteDecisionId, remoteDeleteRevision } from '../src/remote-delete-policy.js';
import type { JsonObject } from '../src/sync-state-store.js';
import { installKns05IndexedDb, scope, setup as setupPull } from './kns-05-pull-harness.js';

installKns05IndexedDb();
const fixtures: Awaited<ReturnType<typeof setupPull>>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.store.close(); });
async function setup() { const f = await setupPull(); fixtures.push(f); return f; }

for (const [name, result, expected] of [
  ['missing results', {}, false], ['empty results', { results: [] }, false],
  ['non-object result', { results: [7] }, false], ['array result', { results: [[]] }, false],
  ['missing status', { results: [{}] }, false], ['rejected', { results: [{ status: 'rejected' }] }, false],
  ['wrong target', { results: [{ status: 'applied', targetId: 'other-node' }] }, false],
  ['applied', { results: [{ status: 'applied', targetId: 'node-1' }] }, true],
  ['rebased', { results: [{ status: 'rebased', targetId: 'node-1' }] }, true],
  ['noop legacy receipt', { results: [{ status: 'noop' }] }, true],
] as const) test(`a ${name} restore receipt ${expected ? 'settles' : 'cannot settle'} the parked remote delete`, async () => {
  const f = await setup();
  await f.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 10 });
  const deleted = f.mutationEvent('delete'); await f.applier.stage(f.page([deleted])); await f.applier.resume();
  const pending = (await f.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
  const decision = await f.store.decideRemoteDelete(scope, { decisionId: pending.decisionId, action: 'restore',
    expectedCasVersion: pending.casVersion, deleteRevision: pending.deleteRevision, generation: 1, now: 20, permissionGranted: true });
  await f.applier.resume();
  assert.equal((await f.store.getRemoteDeleteDecision(scope, pending.decisionId))?.state, 'restoring');
  const queued = await enqueueRemoteDeleteRestore(f.store, scope, decision, 20);
  await f.applier.resume();
  assert.equal((await f.store.getRemoteDeleteDecision(scope, pending.decisionId))?.state, 'restoring');
  await f.store.completeQueueWithReceipt(scope, queued.sequence, { opId: queued.opId, operationDigest: queued.digest,
    kind: 'terminal', receiptId: 'restore-receipt', resultDigest: 'sha256:restore', result: structuredClone(result) as JsonObject });
  f.store.close(); await f.applier.resume();
  assert.equal((await f.store.getRemoteDeleteDecision(scope, pending.decisionId))?.state, expected ? 'restored' : 'restoring');
  assert.equal(f.api.calls.filter(call => call.kind === 'delete').length, 0);
  assert.equal(f.api.getNode('native-node')?.title, 'node-1');
  assert.equal((await f.store.getQueueReceipt(scope, queued.sequence))?.operationDigest, queued.digest);
});

test('a crash after parking keep-local resumes from the durable decision without needing the vanished parent', async () => {
  const f = await setup(), event = f.mutationEvent('delete');
  assert.ok(event.kind === 'operation' && event.effect.kind === 'node_deleted');
  await f.applier.stage(f.page([event]));
  const raw = (await f.store.listPullEvents(scope))[0]!;
  await f.store.parkRemoteDelete(scope, { decision: {
    decisionId: remoteDeleteDecisionId(String(raw.eventId)), eventId: String(raw.eventId), pageId: String(raw.pageId),
    operationId: event.operation.opId, effectId: event.effect.effectId, effectDigest: event.effect.effectDigest,
    targetId: 'node-1', deleteRevision: remoteDeleteRevision(event.effect)!, generation: scope.generation,
    nativeIds: ['native-node'], nodeKind: 'bookmark', title: 'node-1', policy: 'keep_local', updatedAt: 20 } });
  await f.store.deleteMapping(scope, 'native-root'); f.store.close();
  assert.equal(await interceptStagedRemoteDelete(f.options, f.api, String(raw.eventId), String(raw.pageId), event, () => 30), 'skip');
  assert.equal((await f.store.getRemoteDeleteDecision(scope, remoteDeleteDecisionId(String(raw.eventId))))?.state, 'keep_local');
  assert.equal((await f.store.getLocalSyncExclusion(scope, 'native-node'))?.priorColpId, 'node-1');
  assert.equal(f.api.getNode('native-node')?.title, 'node-1');
  assert.equal(f.api.calls.length, 0);
});

test('a native subtree read distinguishes vanished folders, permission loss and a concurrent reparent cycle', async () => {
  const f = await setup();
  assert.deepEqual(await collectSubtreeNativeIds(f.api, 'vanished'), ['vanished']);
  f.api.denyPermission('native-root');
  await assert.rejects(collectSubtreeNativeIds(f.api, 'native-root'), /permission/);
  const reads: string[] = [];
  const moving = { ...f.api, getChildren: async (id: string) => {
    reads.push(id); return [{ id: id === 'root' ? 'child' : 'root', title: 'Moved during walk' }];
  } };
  assert.deepEqual(await collectSubtreeNativeIds(moving, 'root'), ['root', 'child']);
  assert.deepEqual(reads, ['root', 'child']);
  assert.equal(f.api.calls.length, 0);
});

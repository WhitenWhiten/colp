import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { deletionFixture } from './rejoin-decision-harness.js';
import { installKns05IndexedDb, scope } from './kns-05-pull-harness.js';
import { refreshRejoinDecisions, resolveRejoinDecision } from '../src/scope-rejoin-decisions.js';
import { restoreEvidence } from '../src/sync-state/rejoin-decision-repository.js';
import { requestValue } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';

installKns05IndexedDb();
const CAP = 8 * 1_024;
async function assertPhysicalCap(f: Awaited<ReturnType<typeof deletionFixture>>, cap: number) {
  const db = await f.getStore().open();
  const tx = db.transaction([STORES.metadata, STORES.scopeCommandPlans, STORES.mappings], 'readonly');
  const values = await Promise.all([STORES.metadata, STORES.scopeCommandPlans, STORES.mappings]
    .map(name => requestValue(tx.objectStore(name).getAll())));
  for (const row of values.flat()) assert.ok(new TextEncoder().encode(JSON.stringify(row)).length <= cap);
}

test('5000 long cloud IDs confirm, prepare and GET under the default physical cap without a native API', async () => {
  const f = await deletionFixture(5_000);
  try {
    await f.compare();
    const choice = await f.resolve('keep_remote', { createNative: undefined });
    const plan = (await f.getStore().getScopeCommandPlan(scope, choice.commandId))!;
    assert.equal(plan.phase, 'applying'); assert.equal(plan.dependencies.length, 5_001);
    const order = restoreEvidence(plan).orders.find(row => row.parentId === 'restore-folder')!;
    assert.deepEqual(order.children, f.children.map(row => row.nodeId));
    assert.equal((await f.getStore().getMappingByColpId(scope, 'restore-folder'))?.projection.childrenOrder, undefined);
    await assertPhysicalCap(f, 256 * 1_024);
    f.reopen();
    await refreshRejoinDecisions({ ...f.input(), createNative: undefined });
    assert.deepEqual(await f.getStore().getScopeCommandPlan(scope, choice.commandId), plan);
    assert.equal((await f.getStore().listMappings(scope)).length, 5_002);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
  } finally { f.getStore().close(); }
}, 120_000);

test('160 long IDs at an 8 KiB cap survive the 41st native receipt crash with exact cloud order and zero duplicate creates', async () => {
  const f = await deletionFixture(160, CAP);
  try {
    await f.compare();
    const choice = await f.resolve('keep_remote', { createNative: undefined });
    await assertPhysicalCap(f, CAP);
    f.reopen();
    await assert.rejects(refreshRejoinDecisions({ ...f.input(), crash: at => {
      if (at === 'after_evidence_before_mapping' && f.api.calls.filter(row => row.kind === 'create').length === 41) throw new Error('worker_crash');
    } }), /worker_crash/);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 41);
    f.reopen();
    await resolveRejoinDecision(f.input(), { kind: 'known.sync.rejoinDecisions.resolve', commandId: choice.commandId,
      token: choice.token, choice: 'keep_remote', userGesture: true });
    const folder = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
    const mappings = await f.getStore().listMappings(scope);
    const byNative = new Map(mappings.map(row => [row.nativeId, row.colpId]));
    assert.deepEqual((await f.api.getChildren(folder.nativeId)).map(row => byNative.get(row.id)), f.children.map(row => row.nodeId));
    assert.deepEqual(folder.projection.childrenOrder, (await f.api.getChildren(folder.nativeId)).map(row => row.id));
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 161);
    assert.equal((await f.getStore().getMountBinding(scope, 'mount-bar'))?.status, 'active');
    assert.equal((await f.getStore().getScopeCommandPlan(scope, choice.commandId))?.phase, 'active');
    await assertPhysicalCap(f, CAP);
    f.reopen(); await f.refresh(); await f.compare(); await f.queue().recover();
    assert.equal((await f.getStore().listQueue(scope)).length, 0);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 161);
  } finally { f.getStore().close(); }
}, 120_000);

test.each(['mapping', 'observation'])('a late %s change aborts all restore mappings and evidence publication', async kind => {
  const f = await deletionFixture(160, CAP);
  try {
    await f.compare();
    await assert.rejects(f.resolve('keep_remote', { crash: at => {
      if (at === 'after_rejoin_confirmation') throw new Error('worker_crash');
    } }), /worker_crash/);
    const [choice] = await f.list();
    if (kind === 'mapping') {
      const { scopeKey: _key, ...mapping } = (await f.getStore().getMappingByColpId(scope, 'restore-folder'))!;
      await f.getStore().putMapping(scope, { ...mapping, projection: { ...mapping.projection, revision: 'late-revision', resourceRevision: 'late-revision' } });
    } else {
      await f.getStore().putRemoteObservation(scope, { colpId: 'restore-folder', remoteRevision: 'late', cursor: 'late',
        kind: 'content', payload: { title: 'Late cloud edit' }, sourceDigest: 'late', observedAt: Date.now() });
    }
    const before = await f.getStore().exportScope(scope);
    await assert.rejects(f.getStore().prepareRejoinRestore(scope, choice!.commandId), /preview_stale/);
    assert.deepEqual(await f.getStore().exportScope(scope), before);
    assert.equal(f.api.calls.filter(row => row.kind === 'create').length, 0);
  } finally { f.getStore().close(); }
});

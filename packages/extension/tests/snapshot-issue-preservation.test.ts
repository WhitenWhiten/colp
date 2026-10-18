import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { canonicalAuthoritativeEffectDigest, canonicalOperationDigest } from '@know-n/colp/sync';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import type { MappingInput } from '../src/sync-state-store.js';

installKns05IndexedDb();
type Fixture = Awaited<ReturnType<typeof setup>>;
async function issueFromPull(f: Fixture) {
  const event: any = f.mutationEvent('update');
  event.effect.node.title = 'x'.repeat(300_000);
  event.operation.payload.value.title = event.effect.node.title;
  event.effect.operationDigest = canonicalOperationDigest(event.operation);
  event.effect.effectDigest = canonicalAuthoritativeEffectDigest(event.effect);
  await f.applier.stage(f.page([event], 'cursor-held')); await f.applier.resume();
  assert.equal((await f.store.listPullIssues(scope)).length, 1);
}
async function snapshot(f: Fixture, virtual: boolean) {
  const { scopeKey: _key, ...root } = (await f.store.getMappingByColpId(scope, 'root-colp'))!;
  const staged: MappingInput[] = [{ ...root, ...(virtual ? { nativeId: 'recovery:root-colp', rootNativeId: 'recovery:root' } : {}) }];
  await f.store.stageRecoveryPage(scope, { snapshotId: 'snapshot-new', revision: 'revision-new',
    syncCursor: 'cursor-recovered', identityDigest: 'sha256:identity', rootNodeId: 'root-colp', page: 0,
    pageDigest: 'sha256:page', previousPageDigest: null, nextCursor: null, complete: true,
    nodes: staged.map(mapping => ({ colpId: mapping.colpId, parentId: null, position: 'a', kind: 'Folder',
      payloadDigest: 'sha256:root', mapping })) });
  return staged;
}
for (const virtual of [false, true]) for (const restart of [false, true]) {
  test(`real Pull issue survives complete Snapshot cutover (virtual=${virtual}, restart=${restart})`, async () => {
    const f = await setup();
    try {
      await issueFromPull(f);
      const before = await f.store.listPullIssues(scope);
      const staged = await snapshot(f, virtual);
      if (restart) f.store.close();
      const projected = await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api, staged, freezeUnprovenIdentity: true });
      await f.store.finalizeRecoveryMappings(scope, 'snapshot-new', projected);
      if (restart) f.store.close();
      await f.store.commitRecovery(scope, 'snapshot-new');
      assert.ok(f.api.getNode('native-node'));
      assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'native-node');
      assert.deepEqual(await f.store.listPullIssues(scope), before);
      assert.ok((await readOpenSyncIssues(f.store, scope)).roots.has('node-1'));
      assert.ok((await f.store.getLocalSyncExclusion(scope, 'native-node')));
      if (!virtual) {
        assert.equal(f.api.getNode('native-child'), undefined, 'independent removal continues');
        assert.deepEqual(verifySyncResilienceCase('SYNC-0039', { issuesBefore: before, issuesAfter: await f.store.listPullIssues(scope),
          nativeSubject: 'native-node', mapping: await f.store.getMappingByColpId(scope, 'node-1'),
          survivors: f.api.all().map(node => node.id), exclusions: (await f.store.listLocalSyncExclusions(scope)).map(row => row.nativeId),
          independent: ['native-child'], previousCursor: 'cursor-held', cursor: (await f.store.getCursor(scope))?.cursor }), []);
      }
    } finally { f.store.close(); }
  });
}

test('a resumed delete intent rechecks issues created after planning', async () => {
  const f = await setup();
  try {
    await f.store.replaceProjectionIntents(scope, [{ intentId: 'delete:node-1', kind: 'delete', colpId: 'node-1',
      nativeId: 'native-node', order: 1, suppression: 'delete:node-1', generation: 1, state: 'executing' }]);
    await issueFromPull(f); f.store.close();
    const root = (await f.store.getMappingByColpId(scope, 'root-colp'))!;
    await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api, staged: [root], freezeUnprovenIdentity: true });
    assert.ok(f.api.getNode('native-node'));
    assert.notEqual((await f.store.listProjectionIntents(scope))[0]?.state, 'terminal');
  } finally { f.store.close(); }
});

test('local issue protects descendants and ancestors without protecting independent siblings', async () => {
  const f = await setup();
  try {
    f.api.seed({ id: 'native-folder', parentId: 'native-root', title: 'Folder', index: 2 });
    f.api.seed({ id: 'native-leaf', parentId: 'native-folder', title: 'Leaf', url: 'https://leaf.test/', index: 0 });
    for (const [nativeId, colpId, parentNativeId, parentColpId, nodeKind] of [
      ['native-folder', 'folder', 'native-root', 'root-colp', 'folder'],
      ['native-leaf', 'leaf', 'native-folder', 'folder', 'bookmark'],
    ] as const) await f.store.putMapping(scope, { nativeId, colpId, parentNativeId, parentColpId,
      rootNativeId: 'native-root', nodeKind, projection: { revision: 'old', digest: 'sha256:old' } });
    await f.store.recordLocalIssue(scope, { nativeId: 'native-folder', code: 'recovery_identity_unproven', now: 1 });
    const staged = await snapshot(f, false);
    const projected = await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api, staged, freezeUnprovenIdentity: true });
    await f.store.finalizeRecoveryMappings(scope, 'snapshot-new', projected);
    await f.store.commitRecovery(scope, 'snapshot-new');
    assert.ok(f.api.getNode('native-folder')); assert.ok(f.api.getNode('native-leaf'));
    assert.equal(f.api.getNode('native-child'), undefined);
    assert.equal((await f.store.listLocalIssues(scope)).length, 1);
    assert.ok(await f.store.getMappingByColpId(scope, 'leaf'));
  } finally { f.store.close(); }
});

test('Snapshot retains an unresolved real native-create wait without creating a second copy', async () => {
  const { setupT02, reopenT02, t02Scope } = await import('./srg-t02-native-harness.js');
  const { projectNativeWaits, confirmNativeWait } = await import('../src/native-wait.js');
  const f = await setupT02('after_create_before_evidence');
  try {
    const event: any = f.createEvent();
    await f.applier.stage(f.page([event])); await assert.rejects(f.applier.resume(), /worker_crash/u);
    f.disableCrash(); const resumed = await reopenT02(f);
    await resumed.applier.resume().catch((error: Error) => { if (!/native_result_unknown|recovery_required/u.test(error.message)) throw error; });
    const waits = await projectNativeWaits(resumed.store, t02Scope); assert.equal(waits.length, 1);
    const parent = (await resumed.store.listMappings(t02Scope)).find(row => row.nativeId === 'native-root')!;
    const { scopeKey: _key, ...root } = parent;
    const created = { nativeId: `recovery:${event.effect.node.id}`, colpId: event.effect.node.id,
      rootNativeId: 'native-root', parentColpId: root.colpId, nodeKind: 'bookmark' as const,
      projection: { revision: event.effect.node.revision, digest: event.effect.effectDigest,
        content: { title: event.effect.node.title, url: event.effect.node.url } } };
    const independent = { ...created, colpId: 'independent-node', nativeId: 'recovery:independent-node',
      projection: { ...created.projection, content: { title: 'Independent', url: 'https://independent.test/' } } };
    const staged = [root, created, independent];
    await resumed.store.stageRecoveryPage(t02Scope, { snapshotId: 'wait-snapshot', revision: 'new', syncCursor: 'wait-cursor',
      identityDigest: 'sha256:wait', rootNodeId: root.colpId, page: 0, pageDigest: 'sha256:page', previousPageDigest: null,
      nextCursor: null, complete: true, nodes: staged.map((mapping, i) => ({ colpId: mapping.colpId,
        parentId: mapping.parentColpId ?? null, position: String(i), kind: mapping.nodeKind === 'bookmark' ? 'Bookmark' : 'Folder',
        payloadDigest: mapping.projection.digest, mapping })) });
    const before = f.api.calls.filter(call => call.kind === 'create').length;
    const projected = await recoverVerifiedOrFreeze({ scope: t02Scope, store: resumed.store, api: resumed.api,
      staged, freezeUnprovenIdentity: true });
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, before + 1);
    assert.equal(f.api.all().filter(node => node.title === 'Remote').length, 1);
    await resumed.store.finalizeRecoveryMappings(t02Scope, 'wait-snapshot', projected);
    await resumed.store.commitRecovery(t02Scope, 'wait-snapshot');
    assert.equal((await projectNativeWaits(resumed.store, t02Scope)).length, 1);
    assert.ok(projected.some(row => row.colpId === created.colpId));
    await resumed.store.prunePullHistory(t02Scope, 1, { maxEvents: 1, maxBytes: 1 });
    resumed.store.close();
    const [wait] = await projectNativeWaits(resumed.store, t02Scope); assert.ok(wait);
    const rootBefore = await resumed.store.getMappingByColpId(t02Scope, root.colpId);
    const nativeId = f.api.calls.find(call => call.kind === 'create')!.nativeId!;
    assert.equal((await confirmNativeWait({ scope: t02Scope, store: resumed.store, api: resumed.api,
      waitRef: wait.waitRef, intentId: wait.intentId, generation: t02Scope.generation, action: 'bind', nativeId })).ok, true);
    await resumed.applier.resume();
    assert.equal((await resumed.store.getCursor(t02Scope))?.cursor, 'wait-cursor');
    assert.deepEqual(await resumed.store.getMappingByColpId(t02Scope, root.colpId), rootBefore);
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, before + 1);
    assert.equal((await projectNativeWaits(resumed.store, t02Scope)).length, 0);

  } finally { f.store.close(); }
});

test('Snapshot accounts a deletion parked just before worker interruption, then its decision publishes without cursor rewind', async () => {
  const { createPullApplier } = await import('../src/pull-applier.js');
  const f = await setup(); let interrupt = true;
  try {
    const store = { ...f.store, completePullPage: async (...args: Parameters<typeof f.store.completePullPage>) => {
      if (interrupt) { interrupt = false; throw new Error('worker_crash'); }
      return f.store.completePullPage(...args);
    } };
    const applier = createPullApplier({ ...f.options, store });
    await f.store.setRemoteDeletePolicy(scope, { policy: 'confirm', expectedCasVersion: 0, now: 1 });
    await applier.stage(f.page([f.mutationEvent('delete')], 'cursor-delete'));
    await assert.rejects(applier.resume(), /worker_crash/u);
    const staged = await snapshot(f, false);
    const projected = await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api, staged, freezeUnprovenIdentity: true });
    await f.store.finalizeRecoveryMappings(scope, 'snapshot-new', projected);
    await f.store.commitRecovery(scope, 'snapshot-new'); f.store.close();
    const decision = (await f.store.listRemoteDeleteDecisions(scope, ['pending']))[0]!;
    assert.ok(await f.store.getPullEvent(scope, decision.eventId));
    await f.store.decideRemoteDelete(scope, { decisionId: decision.decisionId, action: 'apply',
      expectedCasVersion: decision.casVersion, deleteRevision: decision.deleteRevision,
      generation: scope.generation, now: 2, permissionGranted: true });
    await f.applier.resume();
    assert.equal(f.api.getNode('native-node'), undefined);
    assert.equal(await f.store.getMappingByColpId(scope, 'node-1'), null);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-recovered');
    assert.equal((await f.store.getPullEvent(scope, decision.eventId))?.state, 'page_complete');
  } finally { f.store.close(); }
});

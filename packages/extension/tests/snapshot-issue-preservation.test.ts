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

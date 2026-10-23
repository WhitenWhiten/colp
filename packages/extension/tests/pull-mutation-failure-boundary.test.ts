import { createPullApplier } from '../src/pull-applier.js';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';

import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

import { installOutboundPushIndexedDb } from './outbound-push-worker-harness.js';

installKns05IndexedDb();
installOutboundPushIndexedDb();
const id = (n: number) => `node-created-${n}`;
const create = (n: number, parentId = 'root-colp', kind: 'Bookmark' | 'Folder' = 'Bookmark') =>
  pullFixtures.createEvent({ sequence: n, parentId, kind, collectionId: scope.collectionId });

test('review: failure after a native delete must not be committed as an unapplied item', async () => {
  const f = await setup();
  try {
    await f.applier.stage(f.page([pullFixtures.mutationEvent({ sequence: 91, kind: 'delete',
      targetId: 'node-1', parentId: 'missing-parent', collectionId: scope.collectionId })], 'cursor-1'));
    await f.applier.resume().catch(() => undefined);
    assert.equal(f.api.getNode('native-node'), undefined, 'the destructive call already ran');
    assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-1', 'must retain incomplete apply state');
    assert.equal((await f.store.listPullIssues(scope)).length, 0);
    const intent = (await f.store.listApplyIntents(scope))[0]!;
    assert.equal(intent.anchors?.deleteMemberResults && (intent.anchors.deleteMemberResults as any)['node-1'], 'applied');
    await f.store.putMapping(scope, { nativeId: 'native-parent', colpId: 'missing-parent', rootNativeId: 'native-root',
      nodeKind: 'folder', projection: { revision: 'r1', digest: 'sha256:parent' } });
    await restoreAuthority(f);
    await f.applier.resume();
    assert.equal(await f.store.getMappingByNativeId(scope, 'native-node'), null);
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.equal(f.api.calls.filter(c => c.kind === 'delete').length, 1);
  } finally { f.store.close(); }
});

test('create mutation with a missing revision mapping resumes with the original native evidence', async () => {
  const f = await setup();
  try {
    const event: any = create(91);
    let fail = true;
    const applier = createPullApplier({ ...f.options, store: { ...f.store,
      getMappingByColpId: async (scope, nodeId) => {
        if (fail && nodeId === 'root-colp' && f.api.calls.some(c => c.kind === 'create')) {
          fail = false; throw new Error('parent_revision_mapping_missing');
        }
        return f.store.getMappingByColpId(scope, nodeId);
      } } });
    await f.applier.stage(f.page([event], 'cursor-1'));
    await assert.rejects(applier.resume(), /mapping_missing/);
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 1);
    assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.equal((await f.store.listPullIssues(scope)).length, 0);
    await assert.rejects(f.store.setAsidePullEvent(scope, `${event.cursor}:${event.operation.opId}`,
      { code: 'parent_mapping_missing', nodeId: id(91), now: 1 }), /pull_event_state_invalid/);
    await restoreAuthority(f);
    await applier.resume();
    assert.equal(f.api.calls.filter(c => c.kind === 'create').length, 1, 'recovery must not duplicate the created bookmark');
    assert.ok(await f.store.getMappingByColpId(scope, id(91)));
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-1');
  } finally { f.store.close(); }
});

test('update interrupted after the browser call retains recovery evidence and resumes', async () => {
  const f = await setup('after_browser_call');
  try {
    const event = pullFixtures.mutationEvent({ sequence: 91, kind: 'update', targetId: 'node-1',
      parentId: 'root-colp', collectionId: scope.collectionId });
    await f.applier.stage(f.page([event], 'cursor-1'));
    await assert.rejects(f.applier.resume(), /worker_crash/);
    assert.equal(f.api.getNode('native-node')?.title, 'Remote update');
    assert.equal((await f.store.listPullIssues(scope)).length, 0);
    assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-1');
    await f.applier.resume();
    assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.projection.content?.title, 'Remote update');
  } finally { f.store.close(); }
});

// Models refreshed authority after repairing the failed mapping read; no staged
// event or native evidence is replaced. The production engine performs this transition.
async function restoreAuthority(f: Awaited<ReturnType<typeof setup>>) {
  const current = (await f.store.getScope(scope))!;
  await f.store.registerScope({ ...current, lifecycle: 'active', metadata: {} });
  const state = (await f.store.getEngineState(scope))!;
  await f.store.transitionEngine(scope, { phase: 'pulling', updatedAt: Date.now(),
    expectedRevision: state.revision, recoveryFrozen: false, authorityRefreshRequired: false, notBefore: 0 });
}

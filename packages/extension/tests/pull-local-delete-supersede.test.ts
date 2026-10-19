import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { locallyDeletedColpIds } from '../src/pull-local-delete-supersede.js';

installKns05IndexedDb();

type Removal = 'pending' | 'processed' | 'rejected' | 'recaptured' | 'already_deleted';

/**
 * This browser removed `node-1` (a bookmark) or `node-folder` (a folder whose
 * recorded members include `node-1`), as ingress records it: the event, the
 * delete in the lane and no mapping left for the removed nodes.
 */
async function removedLocally(f: Awaited<ReturnType<typeof setup>>, input: {
  readonly removal: Removal; readonly subtree?: boolean; readonly targetId?: string;
}) {
  const targetId = input.targetId ?? (input.subtree ? 'node-folder' : 'node-1');
  const type = input.subtree ? 'delete_subtree' : 'delete_node';
  await f.api.remove('native-node');
  const staged = await f.store.stageBookmarkEvent(scope, { eventId: `remove-${targetId}`, dedupeKey: `remove-${targetId}`,
    nativeId: 'native-node', kind: 'remove', occurredAt: '2026-10-18T00:00:00Z',
    details: { deleteNativeIds: ['native-node'], draft: { type, targetId, baseRevision: 'revision-old', payload: {} },
      ...(input.subtree ? { subtreeMemberIds: [targetId, 'node-1'] } : {}) } });
  if (input.removal === 'pending') return;
  const queued = await f.store.commitBookmarkEvent(scope, staged.event.eventId, {
    operation: { type, targetId, payload: { reason: 'browser_event' } }, baseRevision: 'revision-old',
    operationRevision: 'local-delete', deleteNativeIds: ['native-node'],
    allocateOperationId: () => `delete-${targetId}`, validateOperation: () => true, digestOperation: () => 'sha256:delete',
  });
  if (input.removal === 'processed') return;
  const lease = await f.store.acquireLease(scope, 'owner-test', 1_000, 30_000);
  assert.equal(lease.outcome, 'acquired');
  const claimed = await f.store.claimNextQueue(scope, 'owner-test', lease.fence!, 1_000);
  assert.equal(claimed?.opId, queued.opId);
  await f.store.settleClaimedPush(scope, queued.sequence, 'owner-test', lease.fence!,
    { outcome: 'rejected', recovery: { code: input.removal === 'recaptured' ? 'recaptured'
      : input.removal === 'already_deleted' ? 'target_already_deleted' : 'invalid_document' } });
}

const foreign = (f: Awaited<ReturnType<typeof setup>>, kind: 'update' | 'move' | 'delete', targetId = 'node-1', parentId = 'root-colp') =>
  pullFixtures.mutationEvent({ kind, sequence: 7, collectionId: scope.collectionId, targetId, parentId, replicaId: 'another-replica' });

async function applied(f: Awaited<ReturnType<typeof setup>>, event: unknown) {
  const before = f.api.calls.length;
  await f.applier.stage(f.page([event]));
  await f.applier.resume();
  return { issues: (await f.store.listPullIssues(scope)).map(issue => issue.code),
    page: (await f.store.exportScope(scope)).pullPages[0]?.state,
    event: (await f.store.exportScope(scope)).pullEvents[0] as { apiResultEvidence?: { recovery?: string } } | undefined,
    nativeCalls: f.api.calls.slice(before).filter(call => call.kind !== 'get' && call.kind !== 'getChildren').map(call => call.kind) };
}

describe('a remote change to a node this browser deleted', () => {
  test.each(['pending', 'processed', 'recaptured', 'already_deleted'] as Removal[])(
    'an update from another device is taken as superseded by the local deletion (%s)', async removal => {
      const f = await setup();
      try {
        await removedLocally(f, { removal });
        const result = await applied(f, foreign(f, 'update'));
        assert.deepEqual(result.issues, []);
        assert.equal(result.page, 'page_complete');
        assert.equal(result.event?.apiResultEvidence?.recovery, 'local_removal');
        assert.deepEqual(result.nativeCalls, []);
        if (removal !== 'pending') assert.equal(await f.store.getMappingByColpId(scope, 'node-1'), null);
      } finally { f.store.close(); }
    });

  test.each(['processed', 'already_deleted'] as Removal[])('a deletion from another device of the same node settles without an item (%s)', async removal => {
    const f = await setup();
    try {
      await removedLocally(f, { removal });
      const result = await applied(f, foreign(f, 'delete'));
      assert.deepEqual(result.issues, []);
      assert.equal(result.page, 'page_complete');
      assert.deepEqual(result.nativeCalls, []);
      // The parent's children revision still follows the server.
      assert.equal((await f.store.getMappingByColpId(scope, 'root-colp'))?.projection.childrenRevision, 'children-7');
    } finally { f.store.close(); }
  });

  test('a bookmark saved elsewhere into a folder deleted here goes with the folder', async () => {
    const f = await setup();
    try {
      await removedLocally(f, { removal: 'processed', subtree: true });
      const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 7, collectionId: scope.collectionId,
        parentId: 'node-folder', replicaId: 'another-replica' });
      const result = await applied(f, event);
      assert.deepEqual(result.issues, []);
      assert.equal(result.page, 'page_complete');
      assert.deepEqual(result.nativeCalls, []);
      assert.equal(await f.store.getMappingByColpId(scope, 'node-created-7'), null);
    } finally { f.store.close(); }
  });

  test('an update inside a deleted folder is superseded through the recorded members', async () => {
    const f = await setup();
    try {
      await removedLocally(f, { removal: 'processed', subtree: true });
      assert.deepEqual([...await locallyDeletedColpIds(f.store, scope)].sort(), ['node-1', 'node-folder']);
      const result = await applied(f, foreign(f, 'update'));
      assert.deepEqual(result.issues, []);
      assert.equal(result.page, 'page_complete');
    } finally { f.store.close(); }
  });

  test('a move out of a deleted folder to a live folder keeps its item: the bookmark is not lost silently', async () => {
    const f = await setup();
    try {
      await removedLocally(f, { removal: 'processed', subtree: true });
      const result = await applied(f, foreign(f, 'move', 'node-1', 'root-colp'));
      assert.deepEqual(result.issues, ['target_mapping_missing']);
    } finally { f.store.close(); }
  });

  test('a delete the server refused for good is no authority: the remote update stays an item', async () => {
    const f = await setup();
    try {
      await removedLocally(f, { removal: 'rejected' });
      assert.deepEqual([...await locallyDeletedColpIds(f.store, scope)], []);
      const result = await applied(f, foreign(f, 'update'));
      // The refused delete is itself the open item; the update waits with it instead of vanishing.
      assert.deepEqual(result.issues, ['parent_set_aside']);
    } finally { f.store.close(); }
  });

  test('a removal of another node is no authority over this one', async () => {
    const f = await setup();
    try {
      await removedLocally(f, { removal: 'processed', targetId: 'node-child' });
      const result = await applied(f, foreign(f, 'update'));
      assert.deepEqual(result.issues, ['target_mapping_missing']);
    } finally { f.store.close(); }
  });
});

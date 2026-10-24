import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { LOCAL_DELETE_MEMBER_ID_BOUND, locallyDeletedColpIds, recordedDeleteMembers } from '../src/pull-local-delete-supersede.js';
import { captureSubtreeDeletion } from '../src/subtree-observation.js';
import type { MappingInput } from '../src/sync-state-store.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { mapping, setupT03, t03Scope } from './srg-t03-delete-harness.js';

/**
 * B-14: a removal names the nodes it took with it so that a later change from another device to one of them is taken
 * as superseded. Past 2000 members it named none but the root, and every deeper node fell back to a permanent item.
 * Now a larger folder names its folders, and a node whose event names a removed parent goes with that parent.
 */
installKns05IndexedDb();

describe('what a removal records', () => {
  const row = (colpId: string, parentColpId: string | undefined, nodeKind?: MappingInput['nodeKind']): MappingInput => {
    const { nodeKind: _default, ...rest } = mapping(`native-${colpId}`, colpId, parentColpId ? { parentColpId } : {});
    return { ...rest, ...(nodeKind ? { nodeKind } : {}) };
  };

  test('the members a remote change can name as a parent are the folders and anything with a member beneath it', () => {
    const captured = captureSubtreeDeletion('big', [
      row('big', 'root-colp', 'folder'), row('empty', 'big', 'folder'), row('b1', 'big', 'bookmark'),
      // a mapping without a kind still counts when something hangs under it
      row('legacy', 'big', undefined), row('b2', 'legacy', 'bookmark'),
      row('outside', 'root-colp', 'folder'), row('elsewhere', 'outside', 'bookmark'),
    ]);
    assert.deepEqual([...captured.parentIds].sort(), ['big', 'empty', 'legacy']);
    assert.deepEqual([...captured.memberIds].sort(), ['b1', 'b2', 'big', 'empty', 'legacy']);
  });

  test('every member while they fit; past the bound the parents, never more than the bound', () => {
    const members = Array.from({ length: LOCAL_DELETE_MEMBER_ID_BOUND }, (_, index) => `m${index}`);
    assert.deepEqual(recordedDeleteMembers(members, ['m0']), members);
    const grown = [...members, 'one-more'];
    assert.deepEqual(recordedDeleteMembers(grown, ['m0', 'm7']), ['m0', 'm7']);
    const folders = Array.from({ length: LOCAL_DELETE_MEMBER_ID_BOUND + 5 }, (_, index) => `f${index}`);
    assert.equal(recordedDeleteMembers([...folders, ...grown], folders).length, LOCAL_DELETE_MEMBER_ID_BOUND);
  });
});

type Fixture = Awaited<ReturnType<typeof setup>>;

/** The removal as ingress leaves it once the delete is in the lane: the event, the op and no mapping for `node-1`. */
async function folderRemoved(f: Fixture, recorded: readonly string[]) {
  await f.api.remove('native-node');
  const staged = await f.store.stageBookmarkEvent(scope, { eventId: 'remove-node-folder', dedupeKey: 'remove-node-folder',
    nativeId: 'native-node', kind: 'remove', occurredAt: '2026-10-24T00:00:00Z',
    details: { deleteNativeIds: ['native-node'], subtreeMemberIds: [...recorded],
      draft: { type: 'delete_subtree', targetId: 'node-folder', baseRevision: 'revision-old', payload: {} } } });
  await f.store.commitBookmarkEvent(scope, staged.event.eventId, {
    operation: { type: 'delete_subtree', targetId: 'node-folder', payload: { reason: 'browser_event' } },
    baseRevision: 'revision-old', operationRevision: 'local-delete', deleteNativeIds: ['native-node'],
    allocateOperationId: () => 'delete-node-folder', validateOperation: () => true, digestOperation: () => 'sha256:delete' });
}

const foreign = (kind: 'update' | 'move' | 'delete', targetId: string, parentId: string, sequence = 7) =>
  pullFixtures.mutationEvent({ kind, sequence, collectionId: scope.collectionId, targetId, parentId, replicaId: 'another-replica' });

async function applied(f: Fixture, events: readonly unknown[]) {
  const before = f.api.calls.length;
  await f.applier.stage(f.page(events));
  await f.applier.resume();
  return { issues: (await f.store.listPullIssues(scope)).map(issue => issue.code),
    page: (await f.store.exportScope(scope)).pullPages[0]?.state,
    recovery: (await f.store.exportScope(scope)).pullEvents.map(event =>
      (event as { apiResultEvidence?: { recovery?: string } }).apiResultEvidence?.recovery),
    nativeCalls: f.api.calls.slice(before).filter(call => call.kind !== 'get' && call.kind !== 'getChildren').map(call => call.kind) };
}

describe('a remote change to a node the removal could not list', () => {
  test('an update to it is superseded through its removed parent', async () => {
    const f = await setup();
    try {
      await folderRemoved(f, ['node-folder']);
      assert.deepEqual([...await locallyDeletedColpIds(f.store, scope)], ['node-folder']);
      const result = await applied(f, [foreign('update', 'node-1', 'node-folder')]);
      assert.deepEqual(result.issues, []);
      assert.equal(result.page, 'page_complete');
      assert.deepEqual(result.recovery, ['local_removal']);
      assert.deepEqual(result.nativeCalls, []);
    } finally { f.store.close(); }
  });

  test('a delete from another device of it settles without an item', async () => {
    const f = await setup();
    try {
      await folderRemoved(f, ['node-folder']);
      const result = await applied(f, [foreign('delete', 'node-1', 'node-folder')]);
      assert.deepEqual(result.issues, []);
      assert.equal(result.page, 'page_complete');
      assert.deepEqual(result.nativeCalls, []);
    } finally { f.store.close(); }
  });

  test('a move of it inside the removed folder is superseded', async () => {
    const f = await setup();
    try {
      await folderRemoved(f, ['node-folder']);
      const result = await applied(f, [foreign('move', 'node-1', 'node-folder')]);
      assert.deepEqual(result.issues, []);
      assert.equal(result.page, 'page_complete');
    } finally { f.store.close(); }
  });

  test('a move of it out to a live folder keeps its item: the bookmark is not lost silently', async () => {
    const f = await setup();
    try {
      await folderRemoved(f, ['node-folder']);
      assert.deepEqual((await applied(f, [foreign('move', 'node-1', 'root-colp')])).issues, ['target_mapping_missing']);
    } finally { f.store.close(); }
  });

  test('a node a superseded create never mapped is superseded for its own update', async () => {
    const f = await setup();
    try {
      await folderRemoved(f, ['node-folder']);
      const created = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 7, collectionId: scope.collectionId,
        parentId: 'node-folder', replicaId: 'another-replica' });
      const result = await applied(f, [created, foreign('update', 'node-created-7', 'node-folder', 8)]);
      assert.deepEqual(result.issues, []);
      assert.equal(result.page, 'page_complete');
      assert.deepEqual(result.recovery, ['local_removal', 'local_removal']);
      assert.deepEqual(result.nativeCalls, []);
    } finally { f.store.close(); }
  });

  test('a node under a live folder is no business of the removal: its item stays', async () => {
    const f = await setup();
    try {
      await folderRemoved(f, ['node-folder']);
      assert.deepEqual((await applied(f, [foreign('update', 'node-1', 'root-colp')])).issues, ['target_mapping_missing']);
    } finally { f.store.close(); }
  });

  test('a node this browser still holds is applied, whatever its parent', async () => {
    const f = await setup();
    try {
      // the removal took `node-folder` only; node-1 is still here and is the remote edit's target
      await f.store.stageBookmarkEvent(scope, { eventId: 'remove-node-folder', dedupeKey: 'remove-node-folder',
        nativeId: 'native-folder', kind: 'remove', occurredAt: '2026-10-24T00:00:00Z',
        details: { deleteNativeIds: ['native-folder'], subtreeMemberIds: ['node-folder'],
          draft: { type: 'delete_subtree', targetId: 'node-folder', baseRevision: 'revision-old', payload: {} } } });
      const result = await applied(f, [foreign('update', 'node-1', 'node-folder')]);
      assert.equal(f.api.getNode('native-node')?.title, 'Remote update');
      assert.deepEqual(result.recovery, [undefined]);
    } finally { f.store.close(); }
  });
});

describe('a folder past the bound, through the capture and the Pull', () => {
  const LEAVES = LOCAL_DELETE_MEMBER_ID_BOUND + 100;

  test('names its folders, so a change to a leaf or to a folder deep inside is superseded', async () => {
    const f = await setupT03();
    try {
      const put = async (nativeId: string, colpId: string, parent: string, nodeKind: 'folder' | 'bookmark') =>
        f.store.putMapping(t03Scope, mapping(nativeId, colpId, { parentNativeId: `native-${parent}`, parentColpId: parent, nodeKind }));
      await f.store.putMapping(t03Scope, mapping('native-big', 'big', { parentNativeId: 'native-root', parentColpId: 'root-colp',
        nodeKind: 'folder' }));
      for (const sub of [0, 1, 2]) await put(`native-sub-${sub}`, `sub-${sub}`, 'big', 'folder');
      for (let index = 0; index < LEAVES; index += 1) await put(`native-b${index}`, `b${index}`, `sub-${index % 3}`, 'bookmark');

      const queue = createBookmarkEventQueue({ store: f.store, scope: t03Scope, autoFlush: false,
        api: { get: async id => (await f.api.get(id)).map(row => ({ ...row, title: row.title ?? '' })),
          getChildren: async id => (await f.api.getChildren(id)).map(row => ({ ...row, title: row.title ?? '' })) } });
      await queue.removed('native-big', { parentId: 'native-root', index: 0,
        node: { id: 'native-big', title: 'big', type: 'folder' } });
      await queue.flush();

      const removal = (await f.store.listBookmarkEvents(t03Scope, 0, 10)).find(event => event.kind === 'remove')!;
      const recorded = removal.details.subtreeMemberIds as string[];
      assert.deepEqual([...recorded].sort(), ['big', 'sub-0', 'sub-1', 'sub-2'], 'the folders, not 2100 leaves');
      assert.ok(removal.details.subtreeMemberIdsDigest, 'the stale-delete rebase still has the digest of every member');
      assert.equal(await f.store.getMappingByColpId(t03Scope, 'b1500'), null, 'the mappings went with the removal');

      const update = pullFixtures.mutationEvent({ kind: 'update', sequence: 7, collectionId: t03Scope.collectionId,
        targetId: 'b1500', parentId: 'sub-0', replicaId: 'another-replica' });
      const created = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 8, collectionId: t03Scope.collectionId,
        parentId: 'sub-1', replicaId: 'another-replica' });
      await f.applier.stage(f.page([update, created]));
      await f.applier.resume();
      assert.deepEqual((await f.store.listPullIssues(t03Scope)).map(issue => issue.code), []);
      assert.equal((await f.store.exportScope(t03Scope)).pullPages[0]?.state, 'page_complete');
      assert.deepEqual(f.api.calls.filter(call => call.kind !== 'get' && call.kind !== 'getChildren'), []);
    } finally { f.store.close(); }
  }, 120_000);
});

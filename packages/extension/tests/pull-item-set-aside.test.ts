import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { replicaIssuesFromPull } from '../src/sw/replica-health-report.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { BookmarkApiError } from '../src/bookmark-api-error.js';
import { pullAckWarnings } from '../src/pull-item-set-aside.js';

installKns05IndexedDb();

const LONG = 'x'.repeat(300_000);
const create = (sequence: number, input: { kind?: 'Bookmark' | 'Folder'; title?: string; parentId?: string } = {}) =>
  pullFixtures.createEvent({ kind: input.kind ?? 'Bookmark', sequence, collectionId: scope.collectionId,
    parentId: input.parentId ?? 'root-colp', ...(input.title ? { title: input.title } : {}) });

describe('C2 a remote record this browser cannot store is one item, not a stop', () => {
  test('a managed bookmark update is held with evidence while siblings and later pages advance', async () => {
    const f = await setup();
    try {
      const update = f.api.update.bind(f.api);
      f.api.update = async (id, changes) => {
        if (id === 'native-node') throw new BookmarkApiError('managed_not_writable', "Can't modify a managed bookmark.");
        return update(id, changes);
      };
      const change = (sequence: number) => pullFixtures.mutationEvent({ kind: 'update', sequence,
        collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' });
      await f.applier.stage(f.page([change(91), create(92)], 'cursor-managed-1'));
      await f.applier.resume();
      assert.ok(await f.store.getMappingByColpId(scope, 'node-created-92'));
      assert.equal(f.api.getNode('native-node')?.title, 'node-1');
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-managed-1');
      assert.deepEqual((await f.store.listPullIssues(scope)).map(row => [row.nodeId, row.code]), [['node-1', 'managed_not_writable']]);
      assert.equal((await pullAckWarnings(f.store, scope))[0]?.nodeId, 'node-1');
      const intent = (await f.store.listApplyIntents(scope)).find(row => row.apiResultEvidence?.nativeRejection);
      assert.equal(intent?.apiResultEvidence?.nativeRejection, 'managed_not_writable');
      // A later change to the held node follows its issue; an independent page still advances.
      await f.applier.stage(f.page([change(93), create(94)], 'cursor-managed-2'));
      await f.applier.resume();
      assert.ok(await f.store.getMappingByColpId(scope, 'node-created-94'));
      assert.equal((await f.store.getCursor(scope))?.cursor, 'cursor-managed-2');
    } finally { f.store.close(); }
  });

  test('global permission loss does not get acknowledged as a managed-node rejection', async () => {
    const f = await setup();
    try {
      f.api.update = async () => { throw new BookmarkApiError('permission_denied', 'Permission revoked'); };
      await f.applier.stage(f.page([pullFixtures.mutationEvent({ kind: 'update', sequence: 91,
        collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' }), create(92)], 'cursor-denied'));
      await assert.rejects(f.applier.resume(), /Permission revoked/);
      assert.deepEqual(await f.store.listPullIssues(scope), []);
      assert.notEqual((await f.store.getCursor(scope))?.cursor, 'cursor-denied');
    } finally { f.store.close(); }
  });

  test('a bookmark with a title too long to store is set aside while the rest of the page applies', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([create(91), create(92, { title: LONG }), create(93)], 'cursor-1'));
    await fixture.applier.resume();
    // Nothing reached the browser for the item, so no bookmark is left without a mapping.
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 2);
    assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-91'));
    assert.equal(await fixture.store.getMappingByColpId(scope, 'node-created-92'), null);
    assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-93'));
    // The page completes and the cursor moves on.
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.deepEqual((await fixture.store.listPullPages(scope)).map((page) => page.state), ['page_complete']);
    const issues = await fixture.store.listPullIssues(scope);
    assert.deepEqual(issues.map((issue) => [issue.nodeId, issue.code, issue.count, issue.title?.length]),
      [['node-created-92', 'record_too_large', 1, 200]]);
    // The Sync center gets it as one Pull item.
    assert.deepEqual(replicaIssuesFromPull(issues).map((issue) => [issue.direction, issue.code, issue.nodeId]),
      [['pull', 'record_too_large', 'node-created-92']]);
  });

  test('later changes about a set-aside folder wait with it, and deletion preserves its repair evidence', async () => {
    const fixture = await setup();
    await fixture.applier.stage(fixture.page([create(92, { kind: 'Folder', title: LONG })], 'cursor-1'));
    await fixture.applier.resume();
    // A bookmark created inside it has nowhere to go; an edit of it is counted on the same item.
    await fixture.applier.stage(fixture.page([create(94, { parentId: 'node-created-92' }),
      pullFixtures.mutationEvent({ kind: 'update', sequence: 95, collectionId: scope.collectionId,
        targetId: 'node-created-92', parentId: 'root-colp', targetKind: 'folder' }), create(96)], 'cursor-2'));
    await fixture.applier.resume();
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-2');
    assert.deepEqual((await fixture.store.listPullIssues(scope)).map((issue) => [issue.nodeId, issue.code, issue.count]),
      [['node-created-92', 'record_too_large', 2], ['node-created-94', 'parent_set_aside', 1]]);
    assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-96'));
    // A tombstone must not erase an unresolved issue and its repair path.
    await fixture.applier.stage(fixture.page([pullFixtures.mutationEvent({ kind: 'delete', sequence: 97,
      collectionId: scope.collectionId, targetId: 'node-created-92', parentId: 'root-colp', targetKind: 'folder' })],
    'cursor-3'));
    await fixture.applier.resume();
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-3');
    assert.deepEqual((await fixture.store.listPullIssues(scope)).map((issue) => issue.nodeId), ['node-created-92', 'node-created-94']);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
  });

  test('an update whose browser bookmark is gone is set aside in the middle of a page that still applies', async () => {
    const fixture = await setup();
    await fixture.api.remove('native-node');
    await fixture.applier.stage(fixture.page([create(91), pullFixtures.mutationEvent({ kind: 'update', sequence: 92,
      collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' }), create(93)], 'cursor-1'));
    await fixture.applier.resume();
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'create').length, 2);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.deepEqual((await fixture.store.listPullIssues(scope)).map((issue) => [issue.nodeId, issue.code]),
      [['node-1', 'pull_apply_target_missing']]);
  });

  test('a remote delete leaves a bookmark with a change held on this browser in place', async () => {
    const fixture = await setup();
    const held = await fixture.store.allocateSequenceAndEnqueue(scope, { opId: 'local-edit', batchId: 'local-edit',
      idempotencyKey: 'local-edit', digest: 'sha256:local-edit', endpointIdentity: 'syncPush',
      mediaType: 'application/json', baseRevision: 'revision-old', operationRevision: 'local-edit', status: 'pending',
      retry: { attempt: 0, notBefore: 0 }, payload: { type: 'update_node_content', targetId: 'node-1',
        payload: { base: { title: 'node-1' }, value: { title: 'Held edit' } } } }, { allowUnstamped: true });
    await fixture.store.setAsideQueue(scope, [held.sequence], 'recovery_identity_unproven');
    await fixture.applier.stage(fixture.page([pullFixtures.mutationEvent({ kind: 'delete', sequence: 94,
      collectionId: scope.collectionId, targetId: 'node-1', parentId: 'root-colp' })], 'cursor-1'));
    await fixture.applier.resume();
    // G4: nothing set aside is deleted automatically; the page still completes.
    assert.ok(fixture.api.getNode('native-node'));
    assert.equal(fixture.api.calls.some((call) => call.kind === 'delete'), false);
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
    assert.equal((await fixture.store.getQueueByOpId(scope, 'local-edit'))?.status, 'set_aside');
  });


});

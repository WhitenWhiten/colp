import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { replicaIssuesFromPull } from '../src/sw/replica-health-report.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

const LONG = 'x'.repeat(300_000);
const create = (sequence: number, input: { kind?: 'Bookmark' | 'Folder'; title?: string; parentId?: string } = {}) =>
  pullFixtures.createEvent({ kind: input.kind ?? 'Bookmark', sequence, collectionId: scope.collectionId,
    parentId: input.parentId ?? 'root-colp', ...(input.title ? { title: input.title } : {}) });

describe('C2 a remote record this browser cannot store is one item, not a stop', () => {
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

  test('later changes about a set-aside folder wait with it, and its deletion closes it', async () => {
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
    // Deleting the folder on the server leaves nothing to take in.
    await fixture.applier.stage(fixture.page([pullFixtures.mutationEvent({ kind: 'delete', sequence: 97,
      collectionId: scope.collectionId, targetId: 'node-created-92', parentId: 'root-colp', targetKind: 'folder' })],
    'cursor-3'));
    await fixture.applier.resume();
    assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-3');
    assert.deepEqual((await fixture.store.listPullIssues(scope)).map((issue) => issue.nodeId), ['node-created-94']);
    assert.equal(fixture.api.calls.filter((call) => call.kind === 'delete').length, 0);
  });
});

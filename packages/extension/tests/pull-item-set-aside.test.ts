import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { setAsidePullItem } from '../src/pull-item-set-aside.js';
import type { PullApplierOptions } from '../src/pull-applier-types.js';
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

  test('past the ceiling of open items the replica stops instead of diverging further', async () => {
    const full = Array.from({ length: 200 }, (_, index) => ({ nodeId: `held-${index}`, code: 'record_too_large',
      eventId: `event-${index}`, count: 1, firstSeenAt: 0, lastSeenAt: 0 }));
    const options = { scope, store: { listPullIssues: async () => full,
      setAsidePullEvent: async () => { throw new Error('must not set aside past the ceiling'); } } };
    await assert.rejects(() => setAsidePullItem(options as unknown as PullApplierOptions, 'event-new',
      create(95, { parentId: 'held-1' }) as never, 0), /pull_issue_ceiling/);
  });
});

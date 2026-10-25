import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { BookmarkApiError, classifyBookmarkApiFailure } from '../src/bookmark-api-error.js';
import { isItemRetryEvent, planItemRetry, restagedPullEvent } from '../src/pull-item-retry-plan.js';
import { retrySetAsidePullItem, retrySetAsidePullItems } from '../src/pull-item-retry.js';
import type { UnknownRecord } from '../src/sync-state/types.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

/**
 * D3 / B-07: "Try again" for a remote item this browser set aside. The stored events are staged again on their own
 * completed page and the ordinary apply pass takes them in; the cursor, the Ack and the page are never touched.
 */
installKns05IndexedDb();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T08:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

type Fixture = Awaited<ReturnType<typeof setup>>;
const refusal = new BookmarkApiError(classifyBookmarkApiFailure(new Error('Index out of bounds.')), 'Index out of bounds.');
const create = (sequence: number, title?: string, kind: 'Bookmark' | 'Folder' = 'Bookmark', parentId = 'root-colp') =>
  pullFixtures.createEvent({ kind, sequence, collectionId: scope.collectionId, parentId, ...(title ? { title } : {}) });
const update = (sequence: number, targetId: string) => pullFixtures.mutationEvent({ kind: 'update', sequence,
  collectionId: scope.collectionId, targetId, parentId: 'root-colp' });

/** One engine wake: the applier resumes once; the next wake is later than the wake gap. */
async function wake(fixture: Fixture): Promise<string> {
  let outcome = 'ok';
  try { await fixture.applier.resume(); } catch (error) { outcome = error instanceof Error ? error.message : String(error); }
  vi.setSystemTime(Date.now() + 6_000);
  return outcome;
}
const issues = (fixture: Fixture) => fixture.store.listPullIssues(scope);
const cursor = async (fixture: Fixture) =>
  (await fixture.store.getCursor(scope))?.cursor ?? (await fixture.store.getScope(scope))?.checkpoint?.cursor;
/** Event ids are `<cursor>:<opId>`; the last event of a page carries the page's next cursor. */
const E91 = 'cursor-91:op-91'; const E92 = 'cursor-1:op-92'; const E93 = 'cursor-2:op-93';
const stateOf = async (fixture: Fixture, eventId: string) => (await fixture.store.getPullEvent(scope, eventId))?.state;

/** Chrome refuses the create of every bookmark titled BAD until `fixture.api.create` is restored. */
function refuseBad(fixture: Fixture) {
  const original = fixture.api.create.bind(fixture.api);
  fixture.api.create = async (input) => { if (input.title?.startsWith('BAD')) throw refusal; return original(input); };
  return () => { fixture.api.create = original; };
}
/** The three wakes of Rule B: `node-created-91` ends set aside as `apply_failed:bookmark_api_error`. */
async function held(fixture: Fixture, events: readonly unknown[] = [create(91, 'BAD'), create(92)], next = 'cursor-1') {
  await fixture.applier.stage(fixture.page(events, next));
  await wake(fixture); await wake(fixture); await wake(fixture);
}

describe('trying a held create again', () => {
  test('takes it in once the cause is gone, outside the page flow, and never touches the cursor or the page', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      assert.deepEqual((await issues(fixture)).map(issue => issue.code), ['apply_failed:bookmark_api_error']);
      assert.equal(await cursor(fixture), 'cursor-1');
      const pagesBefore = (await fixture.store.exportScope(scope)).pullPages;
      fixed();

      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'retried');
      assert.deepEqual(await issues(fixture), [], 'while the retry waits for the next pass the item is not listed');
      assert.equal(await stateOf(fixture, E91), 'staged', 'the stored event is staged again on its own page');
      assert.equal(await cursor(fixture), 'cursor-1');

      assert.equal(await wake(fixture), 'ok');
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-91'), 'the bookmark is mapped');
      assert.ok(fixture.api.all().some(node => node.title === 'BAD'), 'and it is in Chrome');
      assert.deepEqual(await issues(fixture), []);
      assert.equal(await stateOf(fixture, E91), 'page_complete');
      assert.equal(isItemRetryEvent((await fixture.store.getPullEvent(scope, E91))!, scope.generation), false);
      assert.equal(await cursor(fixture), 'cursor-1', 'the cursor did not move');
      assert.deepEqual((await fixture.store.exportScope(scope)).pullPages, pagesBefore, 'no page was added or changed');
    } finally { fixture.store.close(); }
  });

  test('the event that was not held is not played again', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      fixed();
      const creates = () => fixture.api.calls.filter(call => call.kind === 'create').length;
      const before = creates();
      await retrySetAsidePullItem(fixture.options, 'node-created-91');
      await wake(fixture);
      assert.equal(creates() - before, 1, 'one create: the held one');
    } finally { fixture.store.close(); }
  });

  test('if Chrome refuses again the item is set aside again by the same three-wake count, with its reason', async () => {
    const fixture = await setup();
    try {
      refuseBad(fixture);
      await held(fixture);
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'retried');
      assert.equal(await wake(fixture), 'Index out of bounds.');
      assert.equal(await wake(fixture), 'Index out of bounds.');
      assert.deepEqual(await issues(fixture), [], 'still a retry after two refusals');
      assert.equal(await wake(fixture), 'ok');
      const [issue, ...rest] = await issues(fixture);
      assert.equal(rest.length, 0);
      assert.deepEqual({ nodeId: issue!.nodeId, code: issue!.code, count: issue!.count },
        { nodeId: 'node-created-91', code: 'apply_failed:bookmark_api_error', count: 1 });
      assert.equal(await stateOf(fixture, E91), 'page_complete');
      assert.equal(await fixture.store.getMappingByColpId(scope, 'node-created-91'), null);
      assert.equal(await cursor(fixture), 'cursor-1');
    } finally { fixture.store.close(); }
  });

  test('another try works the same way after the item was set aside again', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      await retrySetAsidePullItem(fixture.options, 'node-created-91');
      await wake(fixture); await wake(fixture); await wake(fixture);
      assert.equal((await issues(fixture)).length, 1);
      fixed();
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'retried');
      await wake(fixture);
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-91'));
      assert.deepEqual(await issues(fixture), []);
    } finally { fixture.store.close(); }
  });
});

describe('a node with several held events', () => {
  test('they go back in the order the server delivered them and the node ends at its latest state', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      await fixture.applier.stage(fixture.page([update(93, 'node-created-91')], 'cursor-2'));
      await fixture.applier.resume();
      assert.equal(await cursor(fixture), 'cursor-2');
      assert.equal(await stateOf(fixture, E93), 'page_complete', 'the update was held with the node');
      fixed();

      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'retried');
      assert.equal(await stateOf(fixture, E91), 'staged');
      assert.equal(await stateOf(fixture, E93), 'staged');
      await wake(fixture);
      assert.equal(fixture.api.all().find(node => node.title === 'Remote update')?.url, 'https://example.test/');
      assert.equal(fixture.api.all().some(node => node.title === 'BAD'), false, 'created, then updated to the latest title');
      assert.deepEqual(await issues(fixture), []);
      assert.equal(await cursor(fixture), 'cursor-2');
    } finally { fixture.store.close(); }
  });

  test('a remote delete after the hold closes the item: there is nothing left to bring in', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      const removal = pullFixtures.mutationEvent({ kind: 'delete', sequence: 94, collectionId: scope.collectionId,
        targetId: 'node-created-91', parentId: 'root-colp' });
      await fixture.applier.stage(fixture.page([removal], 'cursor-2'));
      await fixture.applier.resume();
      fixed();
      const callsBefore = fixture.api.calls.length;
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'superseded');
      assert.deepEqual(await issues(fixture), []);
      await wake(fixture);
      assert.equal(fixture.api.calls.length, callsBefore, 'nothing was applied');
      assert.equal(fixture.api.all().some(node => node.title === 'BAD'), false);
    } finally { fixture.store.close(); }
  });

  test('a bookmark that landed by other means is not created twice', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      fixed();
      fixture.api.seed({ id: 'native-landed', parentId: 'native-root', index: 5, title: 'BAD', url: 'https://example.test/' });
      await fixture.store.putMapping(scope, { nativeId: 'native-landed', colpId: 'node-created-91', rootNativeId: 'native-root',
        nodeKind: 'bookmark', parentNativeId: 'native-root', parentColpId: 'root-colp',
        projection: { revision: 'revision-node-created-91', digest: 'sha256:landed', content: { title: 'BAD', url: 'https://example.test/' } } });
      const before = fixture.api.calls.length;
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'superseded');
      assert.deepEqual(await issues(fixture), []);
      await wake(fixture);
      assert.equal(fixture.api.calls.length, before);
    } finally { fixture.store.close(); }
  });
});

describe('a folder and what is inside it', () => {
  async function heldFolderWithChild(fixture: Fixture) {
    const original = fixture.api.create.bind(fixture.api);
    fixture.api.create = async (input) => { if (input.title === 'BADFOLDER') throw refusal; return original(input); };
    await held(fixture, [create(91, 'BADFOLDER', 'Folder'), create(92, 'Inside', 'Bookmark', 'node-created-91')]);
    assert.deepEqual((await issues(fixture)).map(issue => `${issue.nodeId}:${issue.code}`).sort(),
      ['node-created-91:apply_failed:bookmark_api_error', 'node-created-92:parent_set_aside']);
    return () => { fixture.api.create = original; };
  }

  test('the child is not tried while its folder is still held', async () => {
    const fixture = await setup();
    try {
      const fixed = await heldFolderWithChild(fixture); fixed();
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-92'), 'unavailable');
      assert.equal((await issues(fixture)).length, 2, 'nothing changed');
      assert.equal(await stateOf(fixture, E92), 'page_complete');
    } finally { fixture.store.close(); }
  });

  test('both go back together, folder first, whichever the order they were named in', async () => {
    const fixture = await setup();
    try {
      const fixed = await heldFolderWithChild(fixture); fixed();
      const outcomes = await retrySetAsidePullItems(fixture.options, ['node-created-92', 'node-created-91']);
      assert.deepEqual([...outcomes].sort(), [['node-created-91', 'retried'], ['node-created-92', 'retried']]);
      await wake(fixture);
      const folder = await fixture.store.getMappingByColpId(scope, 'node-created-91');
      const child = await fixture.store.getMappingByColpId(scope, 'node-created-92');
      assert.ok(folder && child, 'both are mapped after one pass');
      assert.equal(child.parentNativeId, folder.nativeId, 'the child went into the folder');
      assert.deepEqual(await issues(fixture), []);
      assert.equal(await cursor(fixture), 'cursor-1');
    } finally { fixture.store.close(); }
  });
});

describe('what is left alone', () => {
  test('an item that is not open, or whose stored event is gone, is unavailable and nothing changes', async () => {
    const fixture = await setup();
    try {
      refuseBad(fixture);
      await held(fixture);
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-unknown'), 'unavailable');
      // History keeps the latest page only: the held event is dropped, the issue stays.
      await fixture.applier.stage(fixture.page([create(95)], 'cursor-2'));
      await fixture.applier.resume();
      vi.setSystemTime(Date.now() + 3_600_000); // the held event's intent has expired, so its page is ordinary history
      await fixture.store.prunePullHistory(scope, 1, { maxEvents: 1 });
      assert.equal(await fixture.store.getPullEvent(scope, E91), null);
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'unavailable');
      assert.deepEqual((await issues(fixture)).map(issue => issue.nodeId), ['node-created-91']);
    } finally { fixture.store.close(); }
  });

  test('a hold that a conflict decision settles is not tried again from here', async () => {
    const fixture = await setup();
    try {
      await fixture.applier.stage(fixture.page([create(91)], 'cursor-1'));
      await fixture.store.setAsidePullEvent(scope, 'cursor-1:op-91', { code: 'parent_set_aside', nodeId: 'node-created-91',
        conflictOpIds: ['op-conflict'], now: Date.now() });
      await fixture.applier.resume();
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'unavailable');
      assert.equal((await issues(fixture)).length, 1);
    } finally { fixture.store.close(); }
  });

  test('a restaged event keeps its page from being pruned until it is applied', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      await fixture.applier.stage(fixture.page([create(95)], 'cursor-2'));
      await fixture.applier.resume();
      fixed();
      vi.setSystemTime(Date.now() + 3_600_000); // the same hour that lets history drop the held event (see above)
      assert.equal(await retrySetAsidePullItem(fixture.options, 'node-created-91'), 'retried');
      await fixture.store.prunePullHistory(scope, 1, { maxEvents: 1 });
      assert.equal(await stateOf(fixture, E91), 'staged', 'the page of a staged event is protected');
      await wake(fixture);
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-91'));
    } finally { fixture.store.close(); }
  });
});

describe('the plan', () => {
  const held = (id: string, kind: string, extra: UnknownRecord = {}): UnknownRecord => ({ eventId: id, state: 'page_complete',
    apiResultEvidence: { setAside: 'x', nodeId: 'n' }, payload: { effect: { kind, node: { id: 'n', parentId: 'p' },
      placement: { parentId: 'p' }, tombstone: { targetId: 'n' }, rootTombstone: { targetId: 'n' } } }, ...extra });
  const applied = (id: string, kind: string, state = 'page_complete'): UnknownRecord => ({ eventId: id, state,
    payload: { effect: { kind, node: { id: 'n' } } } });

  test('nothing held is nothing to try', () => {
    assert.equal(planItemRetry([], false).outcome, 'unavailable');
    assert.equal(planItemRetry([applied('a', 'node_created')], false).outcome, 'unavailable');
  });

  test('a held run is taken whole, oldest first, from its create', () => {
    const plan = planItemRetry([held('a', 'node_created'), held('b', 'node_content_updated'), held('c', 'node_moved')], false);
    assert.deepEqual(plan, { outcome: 'restage', eventIds: ['a', 'b', 'c'], parentId: 'p' });
  });

  test('only the run at the end of the history: earlier applied events are not played again', () => {
    const plan = planItemRetry([held('a', 'node_created'), applied('b', 'node_content_updated'),
      held('c', 'node_content_updated')], true);
    assert.deepEqual(plan, { outcome: 'restage', eventIds: ['c'], parentId: 'p' });
  });

  test('a later event decides: applied closes the item, one still in flight waits', () => {
    assert.equal(planItemRetry([held('a', 'node_created'), applied('b', 'node_content_updated')], false).outcome, 'superseded');
    assert.equal(planItemRetry([held('a', 'node_created'), applied('b', 'node_content_updated', 'staged')], false).outcome, 'unavailable');
    assert.equal(planItemRetry([held('a', 'node_created'), applied('b', 'node_content_updated', 'intent_prepared')], false).outcome, 'unavailable');
  });

  test('a deletion in the run closes the item unless something came after it', () => {
    assert.equal(planItemRetry([held('a', 'node_created'), held('b', 'node_deleted')], false).outcome, 'superseded');
    assert.deepEqual(planItemRetry([held('a', 'node_created'), held('b', 'node_deleted'), held('c', 'node_restored')], false),
      { outcome: 'restage', eventIds: ['c'], parentId: 'p' });
  });

  test('a create that is here is not made twice; an update cannot make a node that is not', () => {
    assert.equal(planItemRetry([held('a', 'node_created')], true).outcome, 'superseded');
    assert.equal(planItemRetry([held('a', 'node_content_updated')], false).outcome, 'unavailable');
    assert.equal(planItemRetry([held('a', 'node_content_updated')], true).outcome, 'restage');
  });

  test('an effect this build does not know is left alone', () => {
    assert.equal(planItemRetry([held('a', 'node_teleported')], false).outcome, 'unavailable');
  });

  test('a restaged row is a fresh staged one with the retry mark and nothing of the earlier try', () => {
    const row = restagedPullEvent({ ...held('a', 'node_created'), intentId: 'intent:a', pendingMappings: [{}],
      pendingObservations: [], pendingDeleteNativeIds: [], pendingRangeExit: {}, deferredNativeIntentId: 'i' }, 7);
    assert.equal(row.state, 'staged');
    assert.equal(row.itemRetry, 7);
    for (const field of ['intentId', 'apiResultEvidence', 'pendingMappings', 'pendingObservations', 'pendingDeleteNativeIds',
      'pendingRangeExit', 'deferredNativeIntentId']) assert.equal(field in row, false, field);
    assert.equal(isItemRetryEvent(row, 7), true);
    assert.equal(isItemRetryEvent(row, 8), false, 'another generation is not honoured');
    assert.equal(isItemRetryEvent({ ...row, state: 'page_complete' }, 7), false);
  });
});

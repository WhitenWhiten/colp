import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { BookmarkApiError, classifyBookmarkApiFailure } from '../src/bookmark-api-error.js';
import { issueActionOutcomeCopy } from '../src/sync-attention-view.js';
import { pullLocalActions } from '../src/sync-issue-local-actions.js';
import { pullIssueId } from '../src/sync-issue-snapshot.js';
import { handleSyncIssueAction, type SyncIssueActionDeps } from '../src/sw/sync-issue-actions.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

/**
 * D3 / B-07: Try again for a remote item the browser set aside. The card hands the item to the pull layer
 * (`pull-item-retry.ts`), starts a manual pass, and says what each item came to: back in the queue for the next pass,
 * nothing left to do, or not possible from here.
 */
installKns05IndexedDb();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T08:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

type Fixture = Awaited<ReturnType<typeof setup>>;
const refusal = new BookmarkApiError(classifyBookmarkApiFailure(new Error('Index out of bounds.')), 'Index out of bounds.');
const create = (sequence: number, title: string) => pullFixtures.createEvent({ kind: 'Bookmark', sequence,
  collectionId: scope.collectionId, parentId: 'root-colp', title });

async function wake(fixture: Fixture): Promise<void> {
  try { await fixture.applier.resume(); } catch { /* a refused create is counted; the item is set aside after three wakes */ }
  vi.setSystemTime(Date.now() + 6_000);
}
/** Chrome refuses the create of every bookmark titled BAD until the returned function is called. */
function refuseBad(fixture: Fixture): () => void {
  const original = fixture.api.create.bind(fixture.api);
  fixture.api.create = async (input) => { if (input.title?.startsWith('BAD')) throw refusal; return original(input); };
  return () => { fixture.api.create = original; };
}
async function held(fixture: Fixture): Promise<void> {
  await fixture.applier.stage(fixture.page([create(91, 'BAD'), create(92, 'Fine')], 'cursor-1'));
  await wake(fixture); await wake(fixture); await wake(fixture);
}
function deps(fixture: Fixture, over: Partial<SyncIssueActionDeps> = {}) {
  const calls = { ran: 0, wakes: 0 };
  const value: SyncIssueActionDeps = { scope: async () => scope, store: fixture.store,
    run: async work => { calls.ran += 1; return work(); }, recapture: () => async () => ({ operations: [] }),
    wake: () => { calls.wakes += 1; }, ...over };
  return { value, calls };
}
const retry = (...ids: string[]) => ({ kind: 'known.sync.issue.act' as const, action: 'retry' as const, issueIds: ids });
const NODE = 'node-created-91';

describe('Try again for a remote item', () => {
  test('puts the held change back for the next pass, starts one, and the pass takes it in', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      assert.deepEqual((await fixture.store.listPullIssues(scope)).map(issue => issue.code), ['apply_failed:bookmark_api_error']);
      fixed();
      const { value, calls } = deps(fixture);

      const result = await handleSyncIssueAction(value, retry(pullIssueId(NODE)));

      assert.deepEqual(result, { ok: true, done: 1, skipped: 0, failed: 0, woke: true, remote: 1 });
      assert.equal(calls.ran, 1, 'it ran in the engine lane');
      assert.equal(calls.wakes, 1, 'and a manual pass was started');
      assert.deepEqual(await fixture.store.listPullIssues(scope), [], 'until that pass has run the item is not listed');
      await wake(fixture);
      assert.ok(await fixture.store.getMappingByColpId(scope, NODE), 'the pass applied it');
      assert.deepEqual(await fixture.store.listPullIssues(scope), []);
    } finally { fixture.store.close(); }
  });

  test('an item that is gone is skipped, and nothing is started for it', async () => {
    const fixture = await setup();
    try {
      const { value, calls } = deps(fixture);
      assert.deepEqual(await handleSyncIssueAction(value, retry(pullIssueId('node-nobody-has'))),
        { ok: true, done: 0, skipped: 1, failed: 0 });
      assert.equal(calls.wakes, 0);
    } finally { fixture.store.close(); }
  });

  test('a hold that a conflict decision owns is not offered Try again, and is skipped if asked for', async () => {
    assert.deepEqual(pullLocalActions({ conflictOpIds: ['op-1'] }), []);
    assert.deepEqual(pullLocalActions({}), ['retry', 'dismiss']);
  });

  test('the pull layer decides each item; the card counts what it said', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      fixed();
      const asked: Array<readonly string[]> = [];
      const store = { ...fixture.store, restagePullIssues: async (_scope: unknown, nodeIds: readonly string[]) => {
        asked.push(nodeIds);
        return nodeIds.map(id => [id, 'unavailable'] as const) as never;
      } } as typeof fixture.store;
      const { value, calls } = deps(fixture, { store });
      const result = await handleSyncIssueAction(value, retry(pullIssueId(NODE)));
      assert.deepEqual(result, { ok: true, done: 0, skipped: 0, failed: 0, unavailable: 1 });
      assert.deepEqual(asked, [[NODE]]);
      assert.equal(calls.wakes, 0, 'nothing was put back, so no pass is started');

      const settled = { ...fixture.store, restagePullIssues: async (_scope: unknown, nodeIds: readonly string[]) =>
        nodeIds.map(id => [id, 'superseded'] as const) as never } as typeof fixture.store;
      assert.deepEqual(await handleSyncIssueAction(deps(fixture, { store: settled }).value, retry(pullIssueId(NODE))),
        { ok: true, done: 0, skipped: 0, failed: 0, superseded: 1 });
    } finally { fixture.store.close(); }
  });

  test('several items go to the pull layer in one call, so a folder and what is in it go back together', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await fixture.applier.stage(fixture.page([create(91, 'BAD one'), create(92, 'BAD two')], 'cursor-1'));
      // Each refused create is counted over three wakes before it is set aside; the second starts counting after the first.
      for (let round = 0; round < 6; round += 1) await wake(fixture);
      fixed();
      const nodes = (await fixture.store.listPullIssues(scope)).map(issue => issue.nodeId);
      assert.equal(nodes.length, 2);
      const asked: Array<readonly string[]> = [];
      const original = fixture.store.restagePullIssues.bind(fixture.store);
      const store = { ...fixture.store, restagePullIssues: async (target: typeof scope, ids: readonly string[]) => {
        asked.push(ids); return original(target, ids);
      } } as typeof fixture.store;
      const { value } = deps(fixture, { store });
      const result = await handleSyncIssueAction(value, retry(...nodes.map(pullIssueId)));
      assert.equal(asked.length, 1, 'one call');
      assert.deepEqual([...asked[0]!].sort(), [...nodes].sort());
      assert.deepEqual(result, { ok: true, done: 2, skipped: 0, failed: 0, woke: true, remote: 2 });
    } finally { fixture.store.close(); }
  });

  test('a store that cannot answer fails the items with its reason and leaves them listed', async () => {
    const fixture = await setup();
    try {
      const fixed = refuseBad(fixture);
      await held(fixture);
      fixed();
      const store = { ...fixture.store, restagePullIssues: async () => { throw new Error('state_unavailable'); } } as typeof fixture.store;
      const { value, calls } = deps(fixture, { store });
      const result = await handleSyncIssueAction(value, retry(pullIssueId(NODE)));
      assert.deepEqual(result, { ok: true, done: 0, skipped: 0, failed: 1, code: 'state_unavailable' });
      assert.equal(calls.wakes, 0);
      assert.equal((await fixture.store.listPullIssues(scope)).length, 1);
    } finally { fixture.store.close(); }
  });
});

describe('what the card says afterwards', () => {
  const ok = (over: Record<string, number | string | boolean>) => ({ ok: true as const, done: 0, skipped: 0, failed: 0, ...over });

  test('remote items go back to the next pass; uploads go back to the queue; the two are said apart', () => {
    assert.equal(issueActionOutcomeCopy('retry', ok({ done: 1, remote: 1 }), 1), 'Trying again. 1 item from your library goes back to the next sync pass.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ done: 3, remote: 3 }), 3), 'Trying again. 3 items from your library go back to the next sync pass.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ done: 3, remote: 2 }), 3),
      'Tried again. 1 item is back in the upload queue. Trying again. 2 items from your library go back to the next sync pass.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ done: 2 }), 2), 'Tried again. 2 items are back in the upload queue.');
  });

  test('an item with nothing left to do and one that cannot be tried from here each say so, with the way out', () => {
    assert.equal(issueActionOutcomeCopy('retry', ok({ superseded: 1 }), 1), 'Nothing left to do for 1 item. It has been settled since.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ unavailable: 1 }), 1),
      'Sync cannot try 1 item again from here. If it stays, dismiss it to keep this browser’s version, or reset sync on this device.');
    assert.equal(issueActionOutcomeCopy('retry', ok({ unavailable: 2 }), 2),
      'Sync cannot try 2 items again from here. If they stay, dismiss them to keep this browser’s versions, or reset sync on this device.');
    assert.match(issueActionOutcomeCopy('retry', ok({ done: 1, remote: 1, superseded: 1, unavailable: 1 }), 3),
      /^Trying again\. 1 item .* Nothing left to do for 1 item\. .* Sync cannot try 1 item again/u);
  });

  test('"nothing changed" is only said when nothing came of any item', () => {
    assert.equal(issueActionOutcomeCopy('retry', ok({}), 1), 'Nothing changed: the item is gone or no longer offers this.');
    assert.doesNotMatch(issueActionOutcomeCopy('retry', ok({ unavailable: 1 }), 1), /Nothing changed/u);
    assert.doesNotMatch(issueActionOutcomeCopy('retry', ok({ superseded: 1 }), 1), /Nothing changed/u);
  });
});

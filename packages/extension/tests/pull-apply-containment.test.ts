import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import {
  BookmarkApiError, bookmarkApiErrorFromUnknown, classifyBookmarkApiFailure, type BookmarkApiFailureClass,
} from '../src/bookmark-api-error.js';
import { stableError, retryAfterMilliseconds } from '../src/durable-sync-engine-errors.js';
import { classifySyncFailure } from '../src/sync-failure-class.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-24T08:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

type Fixture = Awaited<ReturnType<typeof setup>>;
const refusal = (message: string) => new BookmarkApiError(classifyBookmarkApiFailure(new Error(message)), message);
const create = (sequence: number, title?: string) => pullFixtures.createEvent({ kind: 'Bookmark', sequence,
  ...(title ? { title } : {}), collectionId: scope.collectionId, parentId: 'root-colp' });

/** One engine wake: the applier resumes once; the next wake is later than the wake gap. */
async function wake(fixture: Fixture): Promise<string> {
  let outcome = 'ok';
  try { await fixture.applier.resume(); } catch (error) { outcome = error instanceof Error ? error.message : String(error); }
  vi.setSystemTime(Date.now() + 6_000);
  return outcome;
}
async function issues(fixture: Fixture) { return fixture.store.listPullIssues(scope); }
/** The published cursor: the durable cursor row once a page completed, else the scope's checkpoint. */
async function cursor(fixture: Fixture) {
  return (await fixture.store.getCursor(scope))?.cursor ?? (await fixture.store.getScope(scope))?.checkpoint?.cursor;
}

describe('Chromium 149 refusals are classified by what they say about the node (B-03)', () => {
  test('the four strings the audit probed, and their neighbours, no longer fall through the regexes', () => {
    const rows: Array<[string, BookmarkApiFailureClass]> = [
      ['Index out of bounds.', 'other_failure'],
      ["Can't find parent bookmark for id.", 'not_found'],
      ["Can't find bookmark for id.", 'not_found'],
      ["Can't move a folder to itself or its descendant.", 'other_failure'],
      ["Can't modify the root bookmark folders.", 'managed_not_writable'],
      ["Can't modify managed bookmarks.", 'managed_not_writable'],
      ["Parameter 'parentId' does not specify a folder.", 'other_failure'],
      ["Can't set URL of a bookmark folder.", 'other_failure'],
      ["Can't remove non-empty folder (use recursive to force).", 'other_failure'],
      ['Invalid URL.', 'other_failure'],
      ['User denied permission to modify bookmarks.', 'permission_denied'],
    ];
    for (const [message, expected] of rows) assert.equal(classifyBookmarkApiFailure(new Error(message)), expected, message);
  });

  test('a write quota is named and waits; an ordinary refusal does not carry a code', () => {
    const hourly = bookmarkApiErrorFromUnknown(new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.'));
    assert.equal(stableError(hourly), 'bookmark_write_quota');
    assert.equal(retryAfterMilliseconds(hourly), 5 * 60_000);
    const sustained = bookmarkApiErrorFromUnknown(new Error('This request exceeds the MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE quota.'));
    assert.equal(retryAfterMilliseconds(sustained), 60_000);
    assert.equal(classifySyncFailure('bookmark_write_quota')?.class, 'transient');
    assert.equal(bookmarkApiErrorFromUnknown(new Error('Index out of bounds.')).code, undefined);
  });
});

describe('a browser refusal stays with its node (B-03)', () => {
  test('a create Chrome refuses is retried, then set aside; the next independent event applies and the cursor moves', async () => {
    const fixture = await setup();
    try {
      const original = fixture.api.create.bind(fixture.api);
      fixture.api.create = async (input) => { if (input.title === 'BAD') throw refusal('Index out of bounds.'); return original(input); };
      await fixture.applier.stage(fixture.page([create(91, 'BAD'), create(92)], 'cursor-1'));
      assert.equal(await wake(fixture), 'Index out of bounds.');
      assert.equal(await wake(fixture), 'Index out of bounds.');
      assert.equal((await issues(fixture)).length, 0, 'two wakes of the same refusal are still a retry');
      assert.equal(await wake(fixture), 'ok', 'the third wake sets the node aside and the page goes on');
      const [issue, ...rest] = await issues(fixture);
      assert.equal(rest.length, 0);
      assert.deepEqual({ nodeId: issue!.nodeId, code: issue!.code, title: issue!.title },
        { nodeId: 'node-created-91', code: 'apply_failed:bookmark_api_error', title: 'BAD' });
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-92'), 'the independent create landed');
      assert.equal(fixture.api.all().some((node) => node.title === 'BAD'), false);
      assert.equal(await cursor(fixture), 'cursor-1', 'the page completed');
    } finally { fixture.store.close(); }
  });

  test('failures inside one wake count once, so a tight retry loop cannot set a node aside', async () => {
    const fixture = await setup();
    try {
      fixture.api.create = async () => { throw refusal('Index out of bounds.'); };
      await fixture.applier.stage(fixture.page([create(91), create(92)], 'cursor-1'));
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await assert.rejects(() => fixture.applier.resume(), /Index out of bounds/u);
      }
      assert.equal((await issues(fixture)).length, 0);
      assert.equal(await cursor(fixture), 'cursor-old');
    } finally { fixture.store.close(); }
  });

  test('a refusal that stops by itself applies normally and leaves no issue', async () => {
    const fixture = await setup();
    try {
      const original = fixture.api.create.bind(fixture.api); let refusals = 0;
      fixture.api.create = async (input) => { if (refusals < 2) { refusals += 1; throw refusal('Index out of bounds.'); } return original(input); };
      await fixture.applier.stage(fixture.page([create(91)], 'cursor-1'));
      assert.equal(await wake(fixture), 'Index out of bounds.');
      assert.equal(await wake(fixture), 'Index out of bounds.');
      assert.equal(await wake(fixture), 'ok');
      assert.equal((await issues(fixture)).length, 0);
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-91'));
      assert.equal(await cursor(fixture), 'cursor-1');
    } finally { fixture.store.close(); }
  });

  test('a move into its own descendant that Chrome refuses is set aside the same way', async () => {
    const fixture = await setup();
    try {
      fixture.api.move = async () => { throw refusal("Can't move a folder to itself or its descendant."); };
      const move = pullFixtures.mutationEvent({ kind: 'move', sequence: 91, collectionId: scope.collectionId,
        targetId: 'node-1', parentId: 'root-colp', afterId: 'node-child' });
      await fixture.applier.stage(fixture.page([move, create(92)], 'cursor-1'));
      await wake(fixture); await wake(fixture);
      assert.equal(await wake(fixture), 'ok');
      const [issue] = await issues(fixture);
      assert.equal(issue?.code, 'apply_failed:bookmark_api_error');
      assert.equal(issue?.nodeId, 'node-1');
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-92'));
      assert.equal(await cursor(fixture), 'cursor-1');
    } finally { fixture.store.close(); }
  });

  test('a remove Chrome refuses leaves the bookmark where it is and sets the delete aside', async () => {
    const fixture = await setup();
    try {
      fixture.api.remove = async () => { throw refusal('Cannot remove this bookmark.'); };
      const remove = pullFixtures.mutationEvent({ kind: 'delete', sequence: 91, collectionId: scope.collectionId,
        targetId: 'node-1', parentId: 'root-colp' });
      await fixture.applier.stage(fixture.page([remove, create(92)], 'cursor-1'));
      await wake(fixture); await wake(fixture);
      assert.equal(await wake(fixture), 'ok');
      assert.equal((await issues(fixture))[0]?.code, 'apply_failed:bookmark_api_error');
      assert.ok(fixture.api.getNode('native-node'), 'the local bookmark is untouched');
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-1'), 'its mapping is kept');
      assert.equal(await cursor(fixture), 'cursor-1');
    } finally { fixture.store.close(); }
  });

  test('an update Chrome refuses (not a managed bookmark) is set aside after three wakes', async () => {
    const fixture = await setup();
    try {
      fixture.api.update = async () => { throw refusal('Invalid URL.'); };
      await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')], 'cursor-1'));
      await wake(fixture); await wake(fixture);
      assert.equal(await wake(fixture), 'ok');
      assert.equal((await issues(fixture))[0]?.code, 'apply_failed:bookmark_api_error');
      assert.equal(await cursor(fixture), 'cursor-1');
    } finally { fixture.store.close(); }
  });

  test('a managed bookmark is still set aside at once, under its own code', async () => {
    const fixture = await setup();
    try {
      fixture.api.update = async () => { throw refusal("Can't modify managed bookmarks."); };
      await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')], 'cursor-1'));
      assert.equal(await wake(fixture), 'ok');
      assert.equal((await issues(fixture))[0]?.code, 'managed_not_writable');
    } finally { fixture.store.close(); }
  });

  test('a lost bookmark permission is never contained: it stops the replica, not one node', async () => {
    const fixture = await setup();
    try {
      fixture.api.create = async () => { throw new BookmarkApiError('permission_denied', 'permission_required'); };
      await fixture.applier.stage(fixture.page([create(91), create(92)], 'cursor-1'));
      assert.match(await wake(fixture), /permission_revoked/u);
      for (let attempt = 0; attempt < 5; attempt += 1) await wake(fixture);
      assert.equal((await issues(fixture)).length, 0, 'a lost permission is never an issue about the node');
      assert.equal(fixture.api.all().some((node) => node.title === 'Remote'), false, 'nothing was created without the permission');
    } finally { fixture.store.close(); }
  });

  test('a write quota is never held against the node: it keeps its name and waits', async () => {
    const fixture = await setup();
    try {
      const quota = bookmarkApiErrorFromUnknown(new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_HOUR quota.'));
      fixture.api.create = async () => { throw quota; };
      await fixture.applier.stage(fixture.page([create(91), create(92)], 'cursor-1'));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let thrown: unknown;
        try { await fixture.applier.resume(); } catch (error) { thrown = error; }
        assert.equal(stableError(thrown), 'bookmark_write_quota');
        assert.equal(retryAfterMilliseconds(thrown), 5 * 60_000);
        vi.setSystemTime(Date.now() + 6_000);
      }
      assert.equal((await issues(fixture)).length, 0);
      assert.equal(await cursor(fixture), 'cursor-old');
    } finally { fixture.store.close(); }
  });
});

describe('a move into a folder\'s own descendant is caught before Chrome is asked (B-03)', () => {
  test('the folder is set aside at once as pull_apply_move_cycle and the page goes on', async () => {
    const fixture = await setup();
    try {
      const folder = (nativeId: string, colpId: string, parentNativeId: string) => ({ nativeId, colpId,
        rootNativeId: 'native-root', nodeKind: 'folder' as const, parentNativeId,
        projection: { revision: 'revision-old', resourceRevision: 'revision-old', childrenRevision: 'children-old',
          digest: `sha256:${colpId}`, content: { title: colpId } } });
      await fixture.store.putMapping(scope, folder('native-F', 'folder-F', 'native-root'));
      await fixture.store.putMapping(scope, folder('native-G', 'folder-G', 'native-F'));
      fixture.api.seed({ id: 'native-F', parentId: 'native-root', index: 2, title: 'folder-F' });
      fixture.api.seed({ id: 'native-G', parentId: 'native-F', index: 0, title: 'folder-G' });
      const move = pullFixtures.mutationEvent({ kind: 'move', sequence: 91, collectionId: scope.collectionId,
        targetId: 'folder-F', parentId: 'folder-G', targetKind: 'folder' });
      await fixture.applier.stage(fixture.page([move, create(92)], 'cursor-1'));
      assert.equal(await wake(fixture), 'ok', 'no retry: the cycle is certain');
      const [issue] = await issues(fixture);
      assert.deepEqual({ nodeId: issue?.nodeId, code: issue?.code }, { nodeId: 'folder-F', code: 'pull_apply_move_cycle' });
      assert.equal(fixture.api.calls.some((call) => call.kind === 'move'), false, 'Chrome was never asked to move it');
      assert.equal(fixture.api.getNode('native-F')?.parentId, 'native-root');
      assert.ok(await fixture.store.getMappingByColpId(scope, 'node-created-92'));
      assert.equal(await cursor(fixture), 'cursor-1');
    } finally { fixture.store.close(); }
  });
});

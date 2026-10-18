/**
 * A-02 third row (S2 / SR-02 follow-up): the same defect class as `be740ad6` survived on two more
 * Pull reads. A *rejected* Chrome read must never be answered with a value that claims the read
 * succeeded:
 *
 * 1. `src/pull-range-move.ts` — the extras walk unioned a range root's Chrome subtree with
 *    `.catch(() => [])`, so a permission/managed/transport failure on `getChildren` became "this
 *    folder has no children": the range exit then persisted exclusions and observations from a
 *    silently truncated local fact set, with no diagnostic. `not_found` stays a legal "nothing to
 *    walk" answer, but it must be journaled; every other class must surface.
 * 2. `src/recovery-guard.ts` — `hasUnprovenNativeIdentity` folded a failed `get` into
 *    "identity unproven", so a permission/managed/transient fault froze the scope as
 *    `recovery_identity_unproven`. Only a read that *completed* and reported no node (or an explicit
 *    `not_found`) is evidence about identity; a read that never completed is evidence about the API.
 *
 * Fixtures: `tests/kns-05-pull-harness.ts` (`honestChrome()` rejects exactly like real Chromium) and
 * the read-only `tests/durable-sync-engine-harness.ts#setup()` store.
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { CHROME_BOOKMARK_NOT_FOUND } from '../src/bookmark-api-error.js';
import type { PullBookmarkApi } from '../src/pull-applier.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { scope as engineScope, setup as setupEngine } from './durable-sync-engine-harness.js';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

const PERMISSION_MESSAGE = 'User denied permission to modify bookmarks.';

/**
 * A range exit (`retain_local_copy`): an active source mount moving into a detached dest mount is
 * exactly the shape that makes `applyPlannedMove` union the root's Chrome subtree for extras.
 * `node-1`/`native-node` is the moved folder; `native-extra` is a Chrome child with no mapping, so
 * the walk has work to do and the extras are observable in the persisted exclusions.
 */
async function rangeExitFixture() {
  const f = await setup();
  await f.store.putMountBinding(scope, { mountId: 'mount-bar', nativeRootId: 'native-root',
    remoteMountNodeId: 'root-colp', boundaryVersion: '1', materialized: false, status: 'active',
    rootRole: 'bookmarks-bar' });
  await f.store.putMountBinding(scope, { mountId: 'mount-other', nativeRootId: 'native-other',
    remoteMountNodeId: 'other-colp', boundaryVersion: '1', materialized: false, status: 'detached',
    rootRole: 'other-bookmarks' });
  await f.store.putMapping(scope, { nativeId: 'native-other', colpId: 'other-colp', rootNativeId: 'native-other',
    nodeKind: 'folder', projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'd-other' } });
  f.api.seed({ id: 'native-other', title: 'Other' });
  await f.store.putMapping(scope, { nativeId: 'native-node', colpId: 'node-1', rootNativeId: 'native-root',
    nodeKind: 'folder', parentNativeId: 'native-root', parentColpId: 'root-colp',
    projection: { revision: 'revision-old', childrenRevision: 'children-old', digest: 'sha256:node-1',
      content: { title: 'node-1' } } });
  f.api.seed({ id: 'native-node', parentId: 'native-root', index: 0, title: 'node-1' });
  f.api.seed({ id: 'native-extra', parentId: 'native-node', index: 0, title: 'extra',
    url: 'https://example.test/extra' });
  return f;
}

function moveFolderEvent(sequence: number) {
  return pullFixtures.mutationEvent({ kind: 'move', sequence, collectionId: scope.collectionId,
    targetId: 'node-1', parentId: 'other-colp', targetKind: 'folder' });
}

/** Fail `getChildren` for one native id only, leaving every other read (including `get`) honest. */
function refuseChildrenOf(api: { getChildren(id: string): Promise<readonly { readonly id: string }[]> },
  nativeId: string, error: Error) {
  const children = api.getChildren.bind(api);
  api.getChildren = async (id: string) => {
    if (id === nativeId) throw error;
    return await children(id);
  };
}

function extrasDiagnostics(records: readonly DiagnosticRow[]) {
  return records.filter((row) => row.kind === 'pull_range_extras');
}

type DiagnosticRow = { readonly kind?: string; readonly code?: string; readonly details?: unknown };

describe('SR-02 follow-up: the range-extras walk classifies its reads', () => {
  test('a rejected getChildren surfaces instead of truncating extras to an empty folder', async () => {
    const f = await rangeExitFixture();
    // Only the *child listing of the range root* is refused. `get` on the same id still answers, so
    // the failure lands on the extras walk itself (a permission/managed/transient fault there is the
    // exact shape `.catch(() => [])` hid); denying the whole id would surface earlier, at the
    // move's before-state read, and never reach this defect.
    refuseChildrenOf(f.api, 'native-node', new Error(PERMISSION_MESSAGE));
    await f.applier.stage(f.page([moveFolderEvent(91)]));
    await assert.rejects(() => f.applier.resume(), /User denied permission to modify bookmarks\./u);
    // The failure is not disguised as "this folder has no children".
    assert.equal(extrasDiagnostics((await f.store.exportDiagnostics()).records).length, 0);
    // Nothing truncated reached a decision: no range exit, no exclusion (including the unmapped
    // child the walk would have collected), no observation, no unmounted mapping, no cursor move.
    assert.equal(await f.store.getLocalSyncExclusion(scope, 'native-node'), null);
    assert.equal(await f.store.getLocalSyncExclusion(scope, 'native-extra'), null);
    assert.deepEqual(await f.store.listLocalSyncExclusions(scope), []);
    assert.equal(await f.store.getRemoteObservation(scope, 'node-1'), null);
    assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'native-node');
    assert.equal(await f.store.getCursor(scope), null);
    assert.equal((await f.store.getScope(scope))?.checkpoint?.cursor, 'cursor-old');
  });

  test('a vanished range root degrades to "nothing to walk" but leaves a diagnostic', async () => {
    const f = await rangeExitFixture();
    // Genuine local divergence: the folder behind the mapping is gone, so `getChildren` reports
    // not_found exactly like Chromium does for an unknown id.
    f.api.removeTree('native-node');
    await f.applier.stage(f.page([moveFolderEvent(92)]));
    await f.applier.resume();
    const rows = extrasDiagnostics((await f.store.exportDiagnostics()).records);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.code, 'root_missing');
    const details = rows[0]?.details as { nativeId?: string; colpId?: string } | undefined;
    assert.equal(details?.nativeId, 'native-node');
    assert.equal(details?.colpId, 'node-1');
    // No extras were invented for the unreadable folder, and the verified subtree still exits.
    assert.deepEqual((await f.store.listLocalSyncExclusions(scope)).map((row) => row.nativeId), ['native-node']);
  });

  test('a vanished descendant folder is journaled and the sibling extras it already observed survive', async () => {
    const f = await rangeExitFixture();
    f.api.seed({ id: 'native-sub', parentId: 'native-node', index: 1, title: 'sub' });
    // The subfolder is still listed by its parent, but its own child listing reports it gone: the
    // walk must skip that branch, journal it, and keep the extras it did observe.
    refuseChildrenOf(f.api, 'native-sub', new Error(CHROME_BOOKMARK_NOT_FOUND));
    await f.applier.stage(f.page([moveFolderEvent(93)]));
    await f.applier.resume();
    const rows = extrasDiagnostics((await f.store.exportDiagnostics()).records);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.code, 'subtree_folder_missing');
    assert.equal((rows[0]?.details as { nativeId?: string } | undefined)?.nativeId, 'native-sub');
    assert.deepEqual((await f.store.listLocalSyncExclusions(scope)).map((row) => row.nativeId).sort(),
      ['native-extra', 'native-node', 'native-sub']);
  });
});

/** A Chrome double for the recovery-guard seam: every mutation is a defect, only reads decide. */
function chromeApi(reads: Partial<Pick<PullBookmarkApi, 'get' | 'getChildren'>>): PullBookmarkApi {
  const unused = async (): Promise<never> => { throw new Error('chrome_should_not_run'); };
  const unusedRead = async (): Promise<never> => { throw new Error('chrome_should_not_run:read'); };
  return { create: unused, update: unused, move: unused, remove: unused, removeTree: unused,
    get: reads.get ?? unusedRead, getChildren: reads.getChildren ?? unusedRead };
}

/** `setup()` seeds one live non-virtual mapping (`native-root`/`root-old`) for identity to read. */
async function driveIdentityRead(api: PullBookmarkApi) {
  const fixture = await setupEngine();
  const staged = (await fixture.store.listMappings(engineScope))
    .map(({ scopeKey: _scopeKey, ...row }) => row);
  assert.equal(staged.some((row) => row.nativeId === 'native-root'), true);
  return { fixture, staged, run: () => recoverVerifiedOrFreeze({
    scope: engineScope, store: fixture.store, staged, api, freezeUnprovenIdentity: true }) };
}

describe('SR-02 follow-up: a failed identity read is not an unproven identity', () => {
  test.each([
    ['permission_denied', PERMISSION_MESSAGE],
    ['managed_not_writable', 'Bookmark is unmodifiable'],
    ['other_failure', 'boom'],
  ] as const)('a %s read never freezes as recovery_identity_unproven', async (_class, message) => {
    const { fixture, run } = await driveIdentityRead(chromeApi({
      get: async () => { throw new Error(message); },
    }));
    // The genuine fault keeps its own identity; the caller is never told "identity unproven".
    await assert.rejects(run, new RegExp(`${message.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
    assert.notEqual((await fixture.store.getScope(engineScope))?.lifecycle, 'recovery_required');
    assert.equal((await fixture.store.getScope(engineScope))?.metadata?.recoveryCode, undefined);
    const engine = await fixture.store.getEngineState(engineScope);
    assert.notEqual(engine?.recoveryFrozen, true);
    assert.notEqual(engine?.lastError, 'recovery_identity_unproven');
  });

  test('an explicit not_found records its subject without freezing the scope', async () => {
    const { fixture, run } = await driveIdentityRead(chromeApi({
      get: async () => { throw new Error(CHROME_BOOKMARK_NOT_FOUND); }, getChildren: async () => [],
    }));
    await run();
    assert.notEqual((await fixture.store.getEngineState(engineScope))?.recoveryFrozen, true);
    assert.equal((await fixture.store.listLocalIssues(engineScope))[0]?.nativeId, 'native-root');
  });

  test('an empty API result remains a read failure, not verified absence', async () => {
    const { fixture, run } = await driveIdentityRead(chromeApi({ get: async () => [] }));
    await assert.rejects(run, /bookmark_lookup_empty/u);
    assert.equal((await fixture.store.listLocalIssues(engineScope)).length, 0);
  });
});

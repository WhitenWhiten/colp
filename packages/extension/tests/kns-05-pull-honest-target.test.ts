/**
 * A-02 (B0-2 / S2 / SR-02): Pull must fail *honestly* when remote authority names a bookmark that
 * is gone locally, when an anchor native is gone, or when the parent's children cannot be read.
 *
 * Owner: S2 lane. Fixture: `tests/kns-05-pull-harness.ts` (`honestChrome()` is the default since
 * B3-1, so `api.get` rejects `Can't find bookmark for id.` exactly like real Chromium).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import { installKns05IndexedDb, setup, scope } from './kns-05-pull-harness.js';
import { classifySyncFailure, freezesPullApply, setsAsidePullItem } from '../src/sync-failure-class.js';
import { pullFixtures } from './pull-effect-fixtures.js';

installKns05IndexedDb();

describe('A-02 pull honest failure semantics', () => {
  test('a locally deleted update target is set aside without stopping unrelated Pull', async () => {
    const f = await setup();
    // Local divergence: the mapping survives, the bookmark behind it does not.
    await f.api.remove('native-node');
    await f.applier.stage(f.page([f.mutationEvent('update')]));
    await f.applier.resume();
    const readsAfterFirst = f.api.reads.length;
    assert.ok(f.api.reads.some((read) => read.kind === 'get' && read.nativeId === 'native-node'));
    // The divergence retains the identity needed to repair the set-aside item.
    const diagnostics = await f.store.exportDiagnostics();
    assert.equal(diagnostics.records.some((row) => row.kind === 'pull_apply_target_missing'
      && row.code === 'not_found'
      && (row.details as { colpId?: string; nativeId?: string } | undefined)?.colpId === 'node-1'
      && (row.details as { colpId?: string; nativeId?: string } | undefined)?.nativeId === 'native-node'), true);
    assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
    const issues = await f.store.listPullIssues(scope);
    assert.deepEqual(issues.map(row => [row.nodeId, row.code]), [['node-1', 'pull_apply_target_missing']]);
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    await f.applier.resume();
    assert.equal(f.api.reads.length, readsAfterFirst);
    assert.equal(f.api.calls.some((call) => call.kind === 'update'), false);
  });

  test('a missing anchor maps to anchor_mapping_missing and never lands index 0', async () => {
    const f = await setup();
    // The anchor mapping `node-child` is still present; its native bookmark is gone.
    await f.api.remove('native-child');
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 61, collectionId: scope.collectionId,
      parentId: 'root-colp', afterId: 'node-child' });
    await f.applier.stage(f.page([event]));
    await f.applier.resume();
    // No silent index-0 landing: nothing was created and no mapping was invented.
    assert.equal(f.api.calls.some((call) => call.kind === 'create'), false);
    assert.equal(await f.store.getMappingByColpId(scope, 'node-created-61'), null);
    assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
    assert.deepEqual((await f.store.listPullIssues(scope)).map(row => [row.nodeId, row.code]),
      [['node-created-61', 'anchor_mapping_missing']]);
  });

  test('an unreadable parent fails without an empty-children digest and without freezing the scope (B-10)', async () => {
    const f = await setup();
    f.api.denyPermission('native-root');
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 62, collectionId: scope.collectionId,
      parentId: 'root-colp' });
    await f.applier.stage(f.page([event]));
    // A lost permission waits for the user, like every other native call; it is not a rebuild-only freeze.
    await assert.rejects(() => f.applier.resume(), /permission_revoked/);
    assert.equal(f.api.calls.some((call) => call.kind === 'create'), false);
    assert.equal(await f.store.getMappingByColpId(scope, 'node-created-62'), null);
    // No expectation was built at all, so no `preStateDigest` over `[]` can exist.
    const events = await f.store.listPullEvents(scope);
    assert.equal(events.length, 1);
    assert.equal(events.every((row) => row.state === 'staged'), true);
    for (const row of events) {
      // No intent row was ever written, so no `preStateDigest` over `[]` exists to be replayed.
      assert.equal(await f.store.getApplyIntent(scope, `intent:${row.eventId}`), undefined);
    }
    assert.equal((await f.store.getScope(scope))?.lifecycle, 'active');
    assert.equal((await f.store.getScope(scope))?.metadata?.recoveryCode, undefined);
  });

  test('B-10: one failed read of the parent is transient: nothing is frozen and the next pass applies the create', async () => {
    const f = await setup();
    const original = f.api.getChildren.bind(f.api); let busy = true;
    f.api.getChildren = async (id) => { if (busy) throw new Error('Bookmarks storage is busy'); return original(id); };
    const event = pullFixtures.createEvent({ kind: 'Bookmark', sequence: 63, collectionId: scope.collectionId,
      parentId: 'root-colp' });
    await f.applier.stage(f.page([event]));
    await assert.rejects(() => f.applier.resume(), /native_read_failed/);
    assert.equal((await f.store.getScope(scope))?.lifecycle, 'active', 'no freeze');
    assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen ?? false, false);
    assert.equal(classifySyncFailure('native_read_failed')?.class, 'transient');
    busy = false;
    await f.applier.resume();
    assert.ok(await f.store.getMappingByColpId(scope, 'node-created-63'), 'the retry applied the create');
  });
});

describe('A-02 static guard: the pull apply read seam', () => {
  test('chrome bookmark reads only exist inside the lookupBookmark wrapper', async () => {
    const [runtime, evidence] = await Promise.all([
      readFile(new URL('../src/pull-apply-runtime.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/pull-bookmark-evidence.ts', import.meta.url), 'utf8'),
    ]);
    // `pull-apply-runtime.ts` must not touch the raw API at all any more.
    assert.equal(/api\.get\(/u.test(runtime), false);
    // The extracted seam may, but only on the `lookupBookmark*` wrapper line.
    const wrapped = evidence.split('\n').filter((line) => line.includes('api.get('));
    assert.ok(wrapped.length >= 1);
    for (const line of wrapped) assert.match(line, /lookupBookmark(Children)?\(/u);
    // Missing subjects stay visible as item issues; an unreadable parent still freezes.
    assert.equal(setsAsidePullItem('pull_apply_target_missing', { nodeId: 'node-1' }), true);
    assert.equal(freezesPullApply('pull_apply_evidence_missing'), true);
    assert.equal(/\.catch\(\(\) => \[\]\)/u.test(runtime), false);
    assert.equal(/nativeIndex\([^)]*\)\.catch\(/u.test(runtime), false);
  });
});

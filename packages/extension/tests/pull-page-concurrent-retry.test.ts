/**
 * W2C-09: a page that cannot complete because a bookmark it changed was edited locally in the same moment is
 * completed again on the next wake before it is blocked (a blocked page ends in a Snapshot recovery).
 */
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { describe, test } from 'vitest';
import type { MappingInput } from '../src/sync-state-store.js';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Applies the update, then stops right after the event commits: the page is staged and its event is committed. */
async function committedButNotCompleted(): Promise<{ fixture: Fixture; base: MappingInput }> {
  const fixture = await setup('after_event');
  await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')], 'cursor-1'));
  await assert.rejects(() => fixture.applier.resume(), /worker_crash/u);
  const stored = (await fixture.store.getMappingByNativeId(scope, 'native-node'))!;
  const { scopeKey: _scopeKey, ...base } = stored as MappingInput & { readonly scopeKey?: string };
  return { fixture, base };
}
const editedLocally = (base: MappingInput): MappingInput => ({ ...base,
  projection: { ...base.projection, digest: 'sha256:edited-locally' } });

describe('concurrent local mutation at page completion (W2C-09)', () => {
  test('the first sighting retries the completion instead of blocking the page', async () => {
    const { fixture, base } = await committedButNotCompleted();
    try {
      await fixture.store.putMapping(scope, editedLocally(base));
      await assert.rejects(() => fixture.applier.resume(), /concurrent_local_mutation/u);
      assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'active', 'the replica is not in recovery');
      assert.equal((await fixture.store.listPullPages(scope, ['blocked'])).length, 0);
      assert.equal((await fixture.store.listPullPages(scope, ['staged'])).length, 1);
      // The moment passes (the local edit settles back to what the change was prepared against): the page completes.
      await fixture.store.putMapping(scope, base);
      await fixture.applier.resume();
      assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
      assert.equal((await fixture.store.listPullPages(scope, ['page_complete'])).length, 1);
    } finally { fixture.store.close(); }
  });

  test('a mismatch that is still there on the second sighting blocks the page exactly as before', async () => {
    const { fixture, base } = await committedButNotCompleted();
    try {
      await fixture.store.putMapping(scope, editedLocally(base));
      await assert.rejects(() => fixture.applier.resume(), /concurrent_local_mutation/u);
      await assert.rejects(() => fixture.applier.resume(), /recovery_required/u);
      assert.equal((await fixture.store.getScope(scope))?.lifecycle, 'recovery_required');
      assert.equal((await fixture.store.getScope(scope))?.metadata?.recoveryCode, 'concurrent_local_mutation');
      assert.equal((await fixture.store.listPullPages(scope, ['blocked'])).length, 1);
    } finally { fixture.store.close(); }
  });

  test('a page without a mismatch completes on the first try and records no retry', async () => {
    const fixture = await setup();
    try {
      await fixture.applier.stage(fixture.page([fixture.mutationEvent('update')], 'cursor-1'));
      await fixture.applier.resume();
      assert.equal((await fixture.store.getCursor(scope))?.cursor, 'cursor-1');
      const diagnostics = await fixture.store.exportDiagnostics();
      assert.equal(diagnostics.records.some((row) => row.kind === 'pull_page_concurrent_retry'), false);
    } finally { fixture.store.close(); }
  });
});

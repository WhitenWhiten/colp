import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';

installKns05IndexedDb();

for (const legacyStamp of [false, true]) test(`a stale lease stamp detaches an uncalled page after restart (legacy=${legacyStamp})`, async () => {
  const f = await setup();
  try {
    await f.applier.stage(f.page([f.createEvent('Bookmark')], 'cursor-next'));
    const pageId = String((await f.store.exportScope(scope)).pullPages[0]!.pageId);
    await f.store.putScopeDiagnostic(scope, { kind: 'pull_page_authority', code: pageId,
      details: { ...(legacyStamp ? {} : { pageId }), authorityGeneration: scope.generation,
        leaseGeneration: 'previous-lease-generation' } });
    await f.store.transitionEngine(scope, { phase: 'recovery', updatedAt: 1, recoveryFrozen: true,
      authorityRefreshRequired: true, notBefore: 0, lastError: 'stale_replica' });
    f.store.close();
    // Matching cursor and replica generation do not make a different Session
    // lease authoritative. The uncalled event must be retired before replay.
    await f.store.rebaseActiveSessionAuthority(scope, { cursor: 'cursor-old', serverRevision: 'revision-old' });
    await f.applier.resume();
    const state = await f.store.exportScope(scope);
    assert.equal(state.pullPages.length, 0); assert.equal(state.pullEvents.length, 0);
    assert.equal(state.cursor?.cursor, 'cursor-old');
    assert.equal(f.api.calls.filter(call => call.kind === 'create').length, 0);
    assert.ok((await f.store.exportDiagnostics()).records.some(row => row.kind === 'pull_page_handover'
      && row.code === 'stale_unapplied_page_retired' && row.callFact === 'not_called'));
  } finally { f.store.close(); }
});

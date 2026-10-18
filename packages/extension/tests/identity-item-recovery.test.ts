import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
installKns05IndexedDb();

test('one observed missing native is an issue while independent real Pull still applies', async () => {
  const f = await setup();
  try {
    await f.api.remove('native-node');
    const mappings = await f.store.listMappings(scope);
    await recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api, staged: mappings, freezeUnprovenIdentity: true });
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    const issue = (await readOpenSyncIssues(f.store, scope)).local[0];
    assert.equal(issue?.nativeId, 'native-node');
    const event = pullFixtures.mutationEvent({ kind: 'update', sequence: 2, collectionId: scope.collectionId,
      targetId: 'node-child', parentId: 'root-colp' });
    await f.applier.stage(f.page([event], 'cursor-independent')); await f.applier.resume();
    assert.equal(f.api.getNode('native-child')?.title, 'Remote update');
    assert.equal(f.api.getNode('native-node'), undefined);
    assert.ok((await readOpenSyncIssues(f.store, scope)).roots.has('node-1'));
  } finally { f.store.close(); }
});

for (const failure of ['permission denied', 'temporary native read failure', 'bookmark_lookup_empty']) {
  test(`uncompleted native read is not absence: ${failure}`, async () => {
    const f = await setup();
    try {
      const api = { ...f.api, get: async () => { throw new Error(failure); } };
      await assert.rejects(recoverVerifiedOrFreeze({ scope, store: f.store, api,
        staged: await f.store.listMappings(scope), freezeUnprovenIdentity: true }), new RegExp(failure));
      assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
      assert.notEqual((await f.store.getEngineState(scope))?.lastError, 'recovery_identity_unproven');
    } finally { f.store.close(); }
  });
}

test('ambiguous lookup keeps a concrete subject and never guesses native identity', async () => {
  const f = await setup();
  try {
    const api = { ...f.api, get: async (id: string) => id === 'native-node'
      ? [{ id: 'another-id', title: 'node-1', url: 'https://example.test/' }] : f.api.get(id) };
    await recoverVerifiedOrFreeze({ scope, store: f.store, api,
      staged: await f.store.listMappings(scope), freezeUnprovenIdentity: true });
    assert.ok((await readOpenSyncIssues(f.store, scope)).nativeRoots.has('native-node'));
    assert.equal((await f.store.getMappingByColpId(scope, 'node-1'))?.nativeId, 'native-node');
  } finally { f.store.close(); }
});

test('old mapped-identity freeze is localized across restart, with fresh read and CAS proof', async () => {
  const f = await setup();
  try {
    const { freezeScopeRecovery } = await import('../src/pull-recovery-freeze.js');
    const { recoverMappedIdentityFreeze } = await import('../src/local-save-freeze-recovery.js');
    const { createDurableSyncEngine } = await import('../src/durable-sync-engine.js');
    await f.api.remove('native-node');
    await freezeScopeRecovery(f.store, scope, 'recovery_identity_unproven'); f.store.close();
    let requests = 0;
    const engine = createDurableSyncEngine({ scope, store: f.store, pullApplier: f.applier,
      recoverIdentityFreeze: () => recoverMappedIdentityFreeze({ scope, store: f.store, api: f.api, assertCurrent: async () => {} }),
      endpoints: async () => { requests++; throw new Error('network_unavailable'); },
      sessions: { get: async () => { requests++; throw new Error('network_unavailable'); } },
      snapshotProjector: staged => recoverVerifiedOrFreeze({ scope, store: f.store, api: f.api, staged }),
      pushWorker: { drain: async () => { requests++; throw new Error('network_unavailable'); } } });
    await engine.wake('startup');
    assert.ok(requests > 0, 'old identity gate no longer suppresses all requests');
    assert.notEqual((await f.store.getEngineState(scope))?.lastError, 'recovery_identity_unproven');
    assert.ok((await readOpenSyncIssues(f.store, scope)).roots.has('node-1'));
    f.store.close();
    assert.ok((await readOpenSyncIssues(f.store, scope)).roots.has('node-1'));
  } finally { f.store.close(); }
});

test('permission failure cannot release an old identity freeze', async () => {
  const f = await setup();
  try {
    const { freezeScopeRecovery } = await import('../src/pull-recovery-freeze.js');
    const { recoverMappedIdentityFreeze } = await import('../src/local-save-freeze-recovery.js');
    await freezeScopeRecovery(f.store, scope, 'recovery_identity_unproven');
    f.api.denyPermission('native-node');
    await assert.rejects(recoverMappedIdentityFreeze({ scope, store: f.store, api: f.api, assertCurrent: async () => {} }), /permission/iu);
    assert.equal((await f.store.getEngineState(scope))?.lastError, 'recovery_identity_unproven');
    assert.equal((await readOpenSyncIssues(f.store, scope)).total, 0);
  } finally { f.store.close(); }
});

import { verifySyncResilienceCase } from '../../conformance/src/sync-resilience.mjs';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { test } from 'vitest';
import { installKns05IndexedDb, scope, setup } from './kns-05-pull-harness.js';
import { recoverVerifiedOrFreeze } from '../src/recovery-guard.js';
import { pullFixtures } from './pull-effect-fixtures.js';
import { readOpenSyncIssues } from '../src/sync-issues.js';
import { createBookmarkEventQueue } from '../src/bookmark-event-queue.js';
import { createOutboundPushWorker } from '../src/outbound-push-worker.js';
import { endpoints } from './outbound-push-worker-harness.js';
installKns05IndexedDb();

for (const identity of ['missing', 'ambiguous'] as const) test(`one ${identity} native is isolated while independent Pull and captured upload continue`, async () => {
  const f = await setup();
  try {
    if (identity === 'missing') await f.api.remove('native-node');
    const api = identity === 'missing' ? f.api : { ...f.api, get: async (id: string) => id === 'native-node'
      ? [{ id: 'different-native', title: 'node-1', url: 'https://example.test/' }] : f.api.get(id) };
    const mappings = await f.store.listMappings(scope);
    await recoverVerifiedOrFreeze({ scope, store: f.store, api, staged: mappings, freezeUnprovenIdentity: true });
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    const issue = (await readOpenSyncIssues(f.store, scope)).local[0];
    assert.equal(issue?.nativeId, 'native-node');
    const event = pullFixtures.mutationEvent({ kind: 'update', sequence: 2, collectionId: scope.collectionId,
      targetId: 'node-child', parentId: 'root-colp' });
    await f.applier.stage(f.page([event], 'cursor-independent')); await f.applier.resume();
    assert.equal(f.api.getNode('native-child')?.title, 'Remote update');
    const remoteApplied = f.api.all();
    assert.equal(f.api.getNode('native-node')?.title, identity === 'missing' ? undefined : 'node-1');
    // Capture from current native state, then drive the real worker to its transport boundary.
    // A deliberately lost transport has no successful receipt to fake application.
    const readNative = async (method: 'get' | 'getChildren', id: string) => (await f.api[method](id)).map(node => {
      if (typeof node.title !== 'string') throw new Error('native_fixture_title_missing');
      return { ...node, title: node.title };
    });
    const queue = createBookmarkEventQueue({ scope, store: f.store, autoFlush: false,
      api: { get: id => readNative('get', id), getChildren: id => readNative('getChildren', id) } });
    await f.api.update('native-child', { title: 'Independent local edit' });
    await queue.changed('native-child', { title: 'Independent local edit' }); await queue.flush();
    const upload = (await f.store.listQueue(scope)).find(row => row.payload.targetId === 'node-child')!;
    assert.equal(upload.status, 'pending');
    const sent: any[] = [];
    const worker = createOutboundPushWorker({ scope, store: f.store, endpoints: async () => endpoints,
      sessions: { get: async () => ({ credential: { accessToken: 'unusable-test-token' }, session: {
        sessionId: 'session-kns05', expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', snapshotRequired: false,
        credentialAuthorityDigest: 'a'.repeat(64), collection: { collectionId: scope.collectionId, serverCursor: 'cursor-independent', serverRevision: 'revision-next' },
        replicaLease: { leaseId: 'lease-kns05', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      } }) }, fetch: async (_url, init) => { sent.push(...JSON.parse(String(init?.body)).operations); throw new Error('network_unavailable'); },
      schedule: () => undefined });
    await worker.drain();
    assert.deepEqual(sent.map(op => op.targetId), ['node-child']);
    assert.equal(sent[0].payload.value.title, 'Independent local edit');
    assert.ok((await f.store.getQueueByOpId(scope, upload.opId))?.attempt);
    assert.notEqual((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    assert.ok((await readOpenSyncIssues(f.store, scope)).roots.has('node-1'));
    assert.deepEqual(verifySyncResilienceCase('SYNC-0040', { localIssues: await f.store.listLocalIssues(scope),
      missingNative: 'native-node', missingNode: 'node-1', roots: [...(await readOpenSyncIssues(f.store, scope)).roots],
      mapping: await f.store.getMappingByColpId(scope, 'node-1'), lifecycle: (await f.store.getScope(scope))?.lifecycle,
      nativeUpdates: remoteApplied }), []);
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

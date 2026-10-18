import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createBookmarkCreatePlacementStore } from '../src/bookmark-create-placement.js';
import { MemoryStorageArea } from '../src/credential-store.js';
import { recoverLocalSaveFreeze } from '../src/local-save-freeze-recovery.js';
import { freezeScopeRecovery } from '../src/pull-recovery-freeze.js';
import { createDurableSyncEngine } from '../src/durable-sync-engine.js';
import type { StoredSession } from '../src/types.js';
import { bookmark, fixture, scope } from './bookmark-event-queue-harness.js';

async function frozenSave(legacyActiveScope = false) {
  const f = await fixture(new IDBFactory());
  const storage = new MemoryStorageArea();
  const placements = createBookmarkCreatePlacementStore({ storage, now: () => 100 });
  const record = await placements.reserve({ mode: 'top', targetParentNativeId: 'root-unselected',
    batchId: '11111111-1111-4111-8111-111111111111', batchOrder: 0, batchSize: 1,
    title: 'Local save', url: 'https://local-save.example/', expectedIndex: 0 });
  await placements.bind(record.intentId, 'native-local-save');
  await placements.markAttention(record.intentId);
  f.api.put(bookmark('native-local-save', 'root-selected', 2, record.title, record.url));
  await f.store.putScopeDiagnostic(scope, { kind: 'bookmark_create_placement', code: 'identity_unproven',
    details: { nativeId: 'native-local-save', candidateCount: 1 } });
  await f.store.transitionEngine(scope, { phase: 'sleeping', recoveryFrozen: false, authorityRefreshRequired: false,
    updatedAt: 100, notBefore: 0, sessionId: 'session-before',
    lastPublishedCursor: 'cursor-3', lastAckedCursor: 'cursor-3', lastPushServerCursor: 'push-cursor' });
  const db = await f.store.open();
  const scopeKey = (await f.store.getScope(scope))!.scopeKey;
  const put = async (table: string, row: Record<string, unknown>) => {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(table, 'readwrite');
      tx.objectStore(table).put({ scopeKey, ...row });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  };
  await put('ack_intents', { intentId: 'completed-bootstrap', kind: 'bootstrap', state: 'complete', cursor: 'cursor-3' });
  await freezeScopeRecovery(f.store, scope, 'recovery_identity_unproven', () => 200);
  if (legacyActiveScope) {
    const { metadata: _metadata, ...record } = (await f.store.getScope(scope))!;
    await f.store.registerScope({ ...record, lifecycle: 'active' });
  }
  const options = { scope, store: f.store, storage, api: f.api,
    assertCurrent: async () => {}, now: () => 300 };
  return { ...f, options, placements, record, put };
}

test.each([false, true])('reload repairs a persisted local-only false freeze (scope already active=%s)', async active => {
  const f = await frozenSave(active);
  try {
    // A completed request is retained byte-for-byte; there is no archive, new
    // replica, or queue rewrite hidden behind the repair.
    await f.put('outbound_queue', { sequence: 1, status: 'terminal', payload: { type: 'create_node' }, opId: 'retained-op' });
    const before = await f.store.exportScope(scope);
    const oldRevision = (await f.store.getEngineState(scope))!.revision;
    assert.equal(await recoverLocalSaveFreeze(f.options), true);
    const after = await f.store.exportScope(scope);
    assert.equal(after.scope?.replicaId, before.scope?.replicaId);
    assert.deepEqual(after.scope?.lease, before.scope?.lease);
    assert.equal(after.scope?.lifecycle, 'active');
    assert.equal(after.scope?.metadata?.recoveryCode, undefined);
    for (const name of ['mappings', 'queue', 'cursor', 'ackIntents'] as const) {
      assert.deepEqual(after[name], before[name], name);
    }
    const engine = (await f.store.getEngineState(scope))!;
    assert.equal(engine.recoveryFrozen, true, 'fresh Session authority must release the remaining recovery hold');
    assert.equal(engine.phase, 'session');
    assert.equal(engine.authorityRefreshRequired, true);
    assert.equal(engine.lastError, undefined);
    assert.equal(engine.notBefore, 0);
    assert.equal(engine.revision, oldRevision + 1);
    assert.equal(engine.lastPublishedCursor, 'cursor-3');
    assert.equal(engine.lastAckedCursor, 'cursor-3');
    assert.equal(engine.lastPushServerCursor, 'push-cursor');
    assert.equal((await f.placements.get(f.record.intentId))?.state, 'bound');
    assert.equal(await recoverLocalSaveFreeze(f.options), false);
  } finally { f.store.close(); }
});

test('the next engine wake adopts fresh authority and actually resumes Pull on the same replica', async () => {
  const f = await frozenSave(true);
  try {
    assert.equal(await recoverLocalSaveFreeze(f.options), true);
    const session: StoredSession = { sessionId: 'session-after-repair', credentialAuthorityDigest: 'a'.repeat(64),
      expiresAt: '2099-01-01T00:00:00Z', scope: 'collection', acceptedProtocolVersion: '0.2', snapshotRequired: false,
      collection: { collectionId: scope.collectionId, serverCursor: 'cursor-renewed', serverRevision: 'server-r2' },
      replicaLease: { leaseId: 'lease', generation: '1', state: 'active', expiresAt: '2099-01-01T00:00:00Z' },
      conversionPolicy: { separator: 'preserve_remote' } };
    const sessions: boolean[] = []; const pulls: string[] = [];
    const engine = createDurableSyncEngine({ scope, store: f.store, now: () => 300,
      sessions: { get: async (force = false) => { sessions.push(force); return { session, credential: { accessToken: 'test-access' } }; } },
      endpoints: async () => ({ syncPull: 'https://known.example/pull', syncAck: 'https://known.example/ack',
        syncSnapshot: 'https://known.example/snapshot' }),
      pullApplier: { resume: async () => {}, stage: async page => { assert.deepEqual(page.events, []); } },
      pushWorker: { drain: async () => ({ outcome: 'idle' }) }, snapshotProjector: async rows => rows,
      fetch: async url => { pulls.push(new URL(String(url)).searchParams.get('cursor')!);
        return Response.json({ events: [], nextCursor: 'cursor-renewed', hasMore: false,
          collectionRevision: 'server-r2', recommendedPullAfterSeconds: 30 }); },
    });
    await engine.wake('startup');
    const state = (await f.store.getEngineState(scope))!;
    assert.equal(sessions[0], true);
    assert.deepEqual(pulls, ['cursor-renewed']);
    assert.equal(state.recoveryFrozen, false, state.lastError);
    assert.equal(state.authorityRefreshRequired, false);
    assert.equal(state.lastError, undefined);
    assert.equal(state.phase, 'sleeping');
    assert.equal((await f.store.getScope(scope))?.replicaId, scope.replicaId);
    // The saved bookmark can now enter the ordinary queue instead of remaining
    // hidden behind a successful state-only repair.
    assert.equal((await f.queue.created('native-local-save', f.api.node('native-local-save'))).outcome, 'staged');
    await f.queue.flush();
    assert.equal((await f.store.listQueue(scope))[0]?.payload.type, 'create_node');
  } finally { f.store.close(); }
});

test.each(['missing native', 'permission failure', 'different saved content', 'cloud reservation',
  'pending push', 'pending pull', 'pending acknowledgement', 'unknown native result', 'staged snapshot',
  'different terminal error', 'different scope error'] as const)('does not thaw a freeze with %s', async blocker => {
  const f = await frozenSave();
  try {
    const options = { ...f.options };
    if (blocker === 'missing native' || blocker === 'permission failure') {
      options.api = { ...f.api, get: async id => {
        if (id === 'root-selected') throw new Error(blocker === 'missing native'
          ? "Can't find bookmark for id." : 'Permission denied');
        return f.api.get(id);
      } };
    } else if (blocker === 'different saved content') {
      f.api.put(bookmark('native-local-save', 'root-selected', 2, 'Different', f.record.url));
    } else if (blocker === 'cloud reservation') {
      const key = `known.bookmark.create-placement.v1.${f.record.intentId}`;
      const row = (await f.options.storage.get(key))[key] as Record<string, unknown>;
      await f.options.storage.set({ [key]: { ...row, collectionId: scope.collectionId } });
    } else if (blocker === 'pending push') {
      await f.put('outbound_queue', { sequence: 1, status: 'unknown' });
    } else if (blocker === 'pending pull') {
      await f.put('pull_pages', { pageId: 'pending-page', state: 'blocked' });
    } else if (blocker === 'pending acknowledgement') {
      await f.put('ack_intents', { intentId: 'pending-ack', kind: 'pull', state: 'pending' });
    } else if (blocker === 'unknown native result') {
      await f.put('apply_intents', { intentId: 'unknown-native', state: 'page_complete', nativeResult: 'result_unknown' });
    } else if (blocker === 'staged snapshot') {
      await f.put('recovery_staging', { snapshotId: 'staged-snapshot' });
    } else if (blocker === 'different terminal error') {
      await f.store.transitionEngine(scope, { ...(await f.store.getEngineState(scope))!, lastError: 'deletion_identity_unproven' });
    } else {
      await f.store.registerScope({ ...(await f.store.getScope(scope))!, metadata: { recoveryCode: 'mapping_identity_collision' } });
    }
    assert.equal(await recoverLocalSaveFreeze(options), false);
    assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
  } finally { f.store.close(); }
});

test.each(['engine revision', 'mapping revision', 'authority fence'] as const)(
  'a concurrent %s change prevents a stale unfreeze', async change => {
    const f = await frozenSave(); let checks = 0;
    try {
      const work = recoverLocalSaveFreeze({ ...f.options, assertCurrent: async () => {
        if (++checks !== 3) return;
        if (change === 'authority fence') throw new Error('authority_fenced');
        if (change === 'engine revision') {
          await f.store.transitionEngine(scope, { ...(await f.store.getEngineState(scope))!, updatedAt: 250 });
        } else {
          const mapping = (await f.store.getMappingByNativeId(scope, 'root-selected'))!;
          const { scopeKey: _key, ...row } = mapping;
          await f.store.putMapping(scope, { ...row, projection: { ...row.projection,
            revision: 'changed-r2', resourceRevision: 'changed-r2' } });
        }
      } });
      if (change === 'authority fence') await assert.rejects(work, /authority_fenced/);
      else assert.equal(await work, false);
      assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
    } finally { f.store.close(); }
  });

test('an old placement diagnostic cannot clear another freeze after this migration already recovered it', async () => {
  const f = await frozenSave();
  try {
    assert.equal(await recoverLocalSaveFreeze(f.options), true);
    await freezeScopeRecovery(f.store, scope, 'recovery_identity_unproven');
    assert.equal(await recoverLocalSaveFreeze(f.options), false);
    assert.equal((await f.store.getEngineState(scope))?.recoveryFrozen, true);
  } finally { f.store.close(); }
});

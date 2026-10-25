import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test } from 'vitest';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';

/**
 * W2A-12: a database created by this version has no intents from before v15, but its backfill marker started as
 * 'unknown': every open ran a write transaction over the intents until the first one existed, and the first
 * intents it found were stamped nativeResult 'unknown', which the expired-intent prune never reclaims.
 */
const scope: SyncScope = { environment: 'production', serverId: 'server', serverOrigin: 'https://known.example',
  accountId: 'account', browserProfileId: 'profile', collectionId: 'collection', replicaId: 'replica', generation: 1 };

async function marker(store: ReturnType<typeof createSyncStateStore>) {
  const tx = (await store.open()).transaction(STORES.metadata, 'readonly'); const done = transactionDone(tx);
  const request = tx.objectStore(STORES.metadata).get('v15-backfill');
  const value = await new Promise<{ status?: string } | undefined>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  await done; return value;
}

test('a new database has nothing to backfill, and its first intents keep the result they are given', async () => {
  const factory = new IDBFactory();
  const store = createSyncStateStore({ indexedDB: factory });
  assert.equal((await marker(store))?.status, 'complete');
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease', expiresAt: 10_000 },
    checkpoint: { serverRevision: 'r0', cursor: 'c0' }, selectedRoots: [] });
  await store.createApplyIntent(scope, { intentId: 'intent-1', correlationId: 'correlation-1', operationId: 'op-1',
    expected: { kind: 'create', nativeId: 'native-1' }, expiresAt: 20_000 });
  store.close();
  // The next worker start opens the same database again: the intent is not stamped.
  const reopened = createSyncStateStore({ indexedDB: factory });
  const [intent] = (await reopened.exportScope(scope)).intents;
  assert.equal(intent?.intentId, 'intent-1');
  assert.equal(intent?.nativeResult, undefined);
  assert.equal((await marker(reopened))?.status, 'complete');
  reopened.close();
});

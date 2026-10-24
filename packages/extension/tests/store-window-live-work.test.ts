import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, test } from 'vitest';
import { createLocalBatchStore, LOCAL_BATCH_DATABASE, LOCAL_BATCH_PARTITION } from '../src/bookmark-batch-local-store.js';
import { createSyncStateStore, type SyncScope } from '../src/sync-state-store.js';
import { transactionDone } from '../src/sync-state/idb.js';
import { STORES } from '../src/sync-state/schema.js';

/**
 * W2A-08: lists over stores that never shrink (bulk-operation plans, import plans) returned the first N rows by
 * key. Plan ids are random, so once N settled plans existed a live one could sit outside the window: an
 * interrupted batch was not resumed, a second batch could start, an import was never advanced. The window is
 * now the most recently updated plans, which is where live work always is.
 */
const scope: SyncScope = Object.freeze({ environment: 'production', serverId: 'server-a', serverOrigin: 'https://known.example',
  accountId: 'account-a', browserProfileId: 'profile-a', collectionId: 'collection-a', replicaId: 'replica-a', generation: 1 });
const stores: ReturnType<typeof createSyncStateStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function fixture() {
  const store = createSyncStateStore({ indexedDB: new IDBFactory() }); stores.push(store);
  await store.registerScope({ ...scope, lifecycle: 'active', lease: { leaseId: 'lease-1', expiresAt: Date.parse('2099-01-01') },
    checkpoint: { cursor: 'cursor-0', serverRevision: 'revision-0' }, selectedRoots: [] });
  return { store, key: (await store.getScope(scope))!.scopeKey };
}
async function write(store: ReturnType<typeof createSyncStateStore>, name: string, rows: readonly Record<string, unknown>[]) {
  const tx = (await store.open()).transaction(name, 'readwrite'); const done = transactionDone(tx);
  for (const row of rows) tx.objectStore(name).put(row);
  await done;
}

const batchPlan = (key: string, planId: string, state: string, updatedAt: number) => ({ scopeKey: key, planId, commandId: `command-${planId}`,
  kind: 'rename', digest: 'sha256:digest', treeDigest: 'sha256:tree', boundaryVersion: '1', state, casVersion: 1, itemCount: 1,
  requiresSecondConfirm: false, createdAt: updatedAt, updatedAt });
const importPlan = (key: string, planId: string, state: string, updatedAt: number) => ({ scopeKey: key, planId, conversionDigest: 'sha256:c',
  sourceProfile: 'netscape-bookmarks-v1', sourceIdentity: 'source', choiceDigest: 'sha256:choice', state, createdAt: updatedAt, updatedAt });

test('a live bulk operation outside the first 1,001 plans by id is still found, and still blocks a second one', async () => {
  const { store, key } = await fixture();
  // 1,100 settled plans whose ids sort before the live one, which is the newest by update time.
  await write(store, STORES.batchPlans, [
    ...Array.from({ length: 1_100 }, (_, index) => batchPlan(key, `a-${String(index).padStart(4, '0')}`, 'completed', 1_000 + index)),
    batchPlan(key, 'z-live', 'active', 5_000),
  ]);
  const plans = await store.listBatchPlans(scope);
  assert.equal(plans.length, 1_001);
  assert.equal(plans[0]?.planId, 'z-live', 'newest first');
  assert.ok(plans.some(plan => plan.state === 'active'));
  await assert.rejects(() => store.commitBatchPlan(scope, { plan: { planId: 'b-new', commandId: 'command-new', kind: 'rename', digest: 'sha256:new',
    treeDigest: 'sha256:tree', boundaryVersion: '1', itemCount: 1, requiresSecondConfirm: false, createdAt: 6_000, updatedAt: 6_000 },
  items: [{ itemId: 'item-1', order: 0, nativeId: 'native-1', nodeKind: 'bookmark', title: 'T', parentNativeId: 'native-parent', index: 0,
    preDigest: 'sha256:pre', operationId: 'operation-1', reversalId: 'reversal-1' }] }), /batch_in_progress/);
});

test('a live import outside the first 100 plans by id is still advanced', async () => {
  const { store, key } = await fixture();
  await write(store, STORES.importPlans, [
    ...Array.from({ length: 150 }, (_, index) => importPlan(key, `a-${String(index).padStart(3, '0')}`, 'complete', 1_000 + index)),
    importPlan(key, 'z-live', 'active', 5_000),
  ]);
  const plans = await store.listImportPlans(scope);
  assert.equal(plans.length, 100);
  assert.ok(plans.some(plan => plan.planId === 'z-live' && plan.state === 'active'));
  assert.deepEqual(plans.map(plan => plan.planId), [...plans.map(plan => plan.planId)].sort(), 'handed back in id order, as before');
});

test('the browser-local batch database, which has no update-time index, keeps live work in its window too', async () => {
  const factory = new IDBFactory(); const batches = createLocalBatchStore(factory);
  assert.deepEqual(await batches.local.listBatchPlans(), []);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(LOCAL_BATCH_DATABASE); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = database.transaction(STORES.batchPlans, 'readwrite'); const done = transactionDone(tx);
  for (let index = 0; index < 1_100; index += 1) {
    tx.objectStore(STORES.batchPlans).put(batchPlan(LOCAL_BATCH_PARTITION, `a-${String(index).padStart(4, '0')}`, 'completed', 1_000 + index));
  }
  tx.objectStore(STORES.batchPlans).put(batchPlan(LOCAL_BATCH_PARTITION, 'z-live', 'active', 5_000));
  await done; database.close();
  const plans = await batches.local.listBatchPlans();
  assert.equal(plans.length, 1_001);
  assert.equal(plans[0]?.planId, 'z-live');
  await batches.close();
});

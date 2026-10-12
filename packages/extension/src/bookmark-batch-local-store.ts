import { createBatchJournal, readPlan, readItem, type BatchItemRecord, type BatchPlanRecord } from './sync-state/batch-journal.js';
import { DEFAULT_MAX_RECORD_BYTES } from './sync-state/codec.js';
import { INDEXES, STORES } from './sync-state/schema.js';
import { requestValue, transactionDone } from './sync-state/idb.js';
import type { BoundBatchJournal } from './bookmark-batch-context.js';

export const LOCAL_BATCH_DATABASE = 'known-bookmark-batches';
export const LOCAL_BATCH_PARTITION = 'browser';
function assertNativeItems(items: readonly Pick<BatchItemRecord, 'colpId' | 'mappingRevision' | 'parentColpId' | 'targetParentColpId'>[]) {
  if (items.some(item => item.colpId || item.mappingRevision || item.parentColpId || item.targetParentColpId)) throw new Error('local_batch_cloud_identity');
}
export function createLocalBatchStore(factory: IDBFactory = indexedDB) {
  let connection: Promise<IDBDatabase> | undefined;
  function open() {
    return connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(LOCAL_BATCH_DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORES.batchPlans, { keyPath: ['scopeKey', 'planId'] });
        const items = request.result.createObjectStore(STORES.batchItems, { keyPath: ['scopeKey', 'planId', 'itemId'] });
        items.createIndex(INDEXES.batchItemByPlanOrder, ['scopeKey', 'planId', 'order'], { unique: true });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = undefined; }; resolve(request.result);
      };
      request.onerror = () => { connection = undefined; reject(request.error); };
    });
  }
  const journal = createBatchJournal({ maxRecordBytes: DEFAULT_MAX_RECORD_BYTES, open, writableDatabase: open,
    assertWritable() {}, guardStores: [], requirePartition: async () => {} });
  const local: BoundBatchJournal = {
    commitBatchPlan: input => { assertNativeItems(input.items); return journal.commitBatchPlan(LOCAL_BATCH_PARTITION, input); },
    listBatchPlans: () => journal.listBatchPlans(LOCAL_BATCH_PARTITION),
    readBatchPlan: id => journal.readBatchPlan(LOCAL_BATCH_PARTITION, id),
    settleBatchItem: input => journal.settleBatchItem(LOCAL_BATCH_PARTITION, input),
    settleBatchPlan: input => journal.settleBatchPlan(LOCAL_BATCH_PARTITION, input),
  };
  return { local,
    async importLegacy(plans: readonly BatchPlanRecord[], items: readonly BatchItemRecord[]) {
      const normalizedPlans = plans.map(plan => readPlan({ ...plan, scopeKey: LOCAL_BATCH_PARTITION }, LOCAL_BATCH_PARTITION, DEFAULT_MAX_RECORD_BYTES));
      const normalizedItems = items.map(item => readItem({ ...item, scopeKey: LOCAL_BATCH_PARTITION }, LOCAL_BATCH_PARTITION, DEFAULT_MAX_RECORD_BYTES));
      assertNativeItems(normalizedItems);
      const counts = new Map<string, number>();
      for (const item of normalizedItems) counts.set(item.planId, (counts.get(item.planId) ?? 0) + 1);
      if (normalizedPlans.some(plan => plan.itemCount !== counts.get(plan.planId))
        || normalizedItems.some(item => !normalizedPlans.some(plan => plan.planId === item.planId))) throw new Error('local_batch_migration_incomplete');
      const tx = (await open()).transaction([STORES.batchPlans, STORES.batchItems], 'readwrite'), done = transactionDone(tx);
      for (const plan of normalizedPlans) {
        const prior = await requestValue(tx.objectStore(STORES.batchPlans).get([LOCAL_BATCH_PARTITION, plan.planId]));
        if (prior && JSON.stringify(prior) !== JSON.stringify(plan)) { tx.abort(); await done.catch(() => undefined); throw new Error('local_batch_migration_conflict'); }
        tx.objectStore(STORES.batchPlans).put(plan);
      }
      for (const item of normalizedItems) tx.objectStore(STORES.batchItems).put(item);
      await done;
    },
    async close() { (await connection)?.close(); connection = undefined; },
  };
}

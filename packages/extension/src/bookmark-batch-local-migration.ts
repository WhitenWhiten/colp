import { DATABASE_NAME, STORES } from './sync-state/schema.js';
import { requestValue, transactionDone, scopeRowsRange } from './sync-state/idb.js';
import { readPlan, readItem, type BatchPlanRecord, type BatchItemRecord } from './sync-state/batch-journal.js';
import { DEFAULT_MAX_RECORD_BYTES } from './sync-state/codec.js';
import type { createLocalBatchStore } from './bookmark-batch-local-store.js';

/** Storage compatibility only: the retired namespace is never registered or used as live cloud authority. */
const LEGACY_LOCAL_PARTITION = JSON.stringify(['production', 'local-bookmark-manager', 'https://local.invalid', 'local', 'local', 'local', 'local', 1]);
export async function migrateLegacyLocalBatches(destination: ReturnType<typeof createLocalBatchStore>, factory: IDBFactory) {
  if (!(await factory.databases()).some(database => database.name === DATABASE_NAME)) return;
  const source = await requestValue(factory.open(DATABASE_NAME));
  try {
    if (!source.objectStoreNames.contains(STORES.batchPlans) || !source.objectStoreNames.contains(STORES.batchItems)) return;
    const range = scopeRowsRange(LEGACY_LOCAL_PARTITION);
    const read = source.transaction([STORES.batchPlans, STORES.batchItems], 'readonly'), readDone = transactionDone(read);
    const [rawPlans, rawItems] = await Promise.all([
      requestValue(read.objectStore(STORES.batchPlans).getAll(range)), requestValue(read.objectStore(STORES.batchItems).getAll(range)),
    ]);
    await readDone;
    const plans = rawPlans.map(row => readPlan(row, LEGACY_LOCAL_PARTITION, DEFAULT_MAX_RECORD_BYTES));
    const items = rawItems.map(row => readItem(row, LEGACY_LOCAL_PARTITION, DEFAULT_MAX_RECORD_BYTES));
    if (!plans.length && !items.length) return;
    // Copy durably first. A crash before source cleanup only repeats an identical import.
    await destination.importLegacy(plans, items);
    const cleanup = source.transaction([STORES.batchPlans, STORES.batchItems], 'readwrite'), cleanupDone = transactionDone(cleanup);
    const [latestPlans, latestItems] = await Promise.all([
      requestValue(cleanup.objectStore(STORES.batchPlans).getAll(range)), requestValue(cleanup.objectStore(STORES.batchItems).getAll(range)),
    ]);
    const same = <T extends BatchPlanRecord | BatchItemRecord>(before: readonly T[], after: readonly T[]) =>
      before.length === after.length && before.every((record, index) => JSON.stringify(record) === JSON.stringify(after[index]));
    if (!same(plans, latestPlans.map(row => readPlan(row, LEGACY_LOCAL_PARTITION, DEFAULT_MAX_RECORD_BYTES)))
      || !same(items, latestItems.map(row => readItem(row, LEGACY_LOCAL_PARTITION, DEFAULT_MAX_RECORD_BYTES)))) {
      cleanup.abort(); await cleanupDone.catch(() => undefined); throw new Error('local_batch_migration_conflict');
    }
    cleanup.objectStore(STORES.batchPlans).delete(range); cleanup.objectStore(STORES.batchItems).delete(range);
    await cleanupDone;
  } finally { source.close(); }
}

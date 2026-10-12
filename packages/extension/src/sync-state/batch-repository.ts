import { createBatchJournal } from './batch-journal.js';
import { requireActiveScope } from './idb.js';
import { STORES } from './schema.js';
import { scopeKey, validateScope } from './scope-key.js';
import type { SyncScope } from './types.js';
import type { SyncStoreRuntime } from './runtime.js';
export * from './batch-journal.js';

type Journal = ReturnType<typeof createBatchJournal>;
/** Account batches keep their active-scope check in the same write transaction. */
export function createBatchRepository(ctx: SyncStoreRuntime) {
  const journal = createBatchJournal({ ...ctx, guardStores: [STORES.scopes],
    requirePartition: async (tx, key) => { await requireActiveScope(tx, key); } });
  const keyFor = (scope: SyncScope) => scopeKey(validateScope(scope));
  return {
    commitBatchPlan: (scope: SyncScope, input: Parameters<Journal['commitBatchPlan']>[1]) => journal.commitBatchPlan(keyFor(scope), input),
    listBatchPlans: (scope: SyncScope) => journal.listBatchPlans(keyFor(scope)),
    readBatchPlan: (scope: SyncScope, id: string) => journal.readBatchPlan(keyFor(scope), id),
    settleBatchItem: (scope: SyncScope, input: Parameters<Journal['settleBatchItem']>[1]) => journal.settleBatchItem(keyFor(scope), input),
    settleBatchPlan: (scope: SyncScope, input: Parameters<Journal['settleBatchPlan']>[1]) => journal.settleBatchPlan(keyFor(scope), input),
  };
}

import type { createSyncStateStore, SyncScope } from './sync-state-store.js';
type SyncStore = ReturnType<typeof createSyncStateStore>;
type Journal = ReturnType<typeof import('./sync-state/batch-journal.js').createBatchJournal>;

export interface BoundBatchJournal {
  commitBatchPlan(input: Parameters<Journal['commitBatchPlan']>[1]): ReturnType<Journal['commitBatchPlan']>;
  listBatchPlans(): ReturnType<Journal['listBatchPlans']>;
  readBatchPlan(id: string): ReturnType<Journal['readBatchPlan']>;
  settleBatchItem(input: Parameters<Journal['settleBatchItem']>[1]): ReturnType<Journal['settleBatchItem']>;
  settleBatchPlan(input: Parameters<Journal['settleBatchPlan']>[1]): ReturnType<Journal['settleBatchPlan']>;
}
export type BatchCloudOwner = { readonly store: SyncStore; readonly scope: SyncScope };
export type BatchOwner = BatchCloudOwner | { readonly local: BoundBatchJournal; readonly cloud?: BatchCloudOwner };
export interface BatchContext {
  readonly journal: BoundBatchJournal;
  /** Cloud authority is an optional attachment; native work never invents an account identity. */
  readonly cloud?: { readonly store: SyncStore; readonly scope: SyncScope };
}
export function batchContext(owner: BatchOwner): BatchContext {
  if ('local' in owner) return { journal: owner.local, cloud: owner.cloud };
  const { store, scope } = owner;
  return { cloud: owner, journal: {
    commitBatchPlan: input => store.commitBatchPlan(scope, input), listBatchPlans: () => store.listBatchPlans(scope),
    readBatchPlan: id => store.readBatchPlan(scope, id), settleBatchItem: input => store.settleBatchItem(scope, input),
    settleBatchPlan: input => store.settleBatchPlan(scope, input),
  } };
}

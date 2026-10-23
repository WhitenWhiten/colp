import type { Operation, SyncPushResult } from '@know-n/colp/types';
import type { PushSequenceTransaction } from './sync-push-repository-postgres.js';

/** Run under the same collection/sequence locks as the mutation and receipt.
 * A missing or deferred dependency never permits speculative execution.
 * System-authored canonical operations have no client sequence receipt. */
export async function evaluatePushDependencies(operation: Operation, batchId: string,
  transaction: PushSequenceTransaction) {
  const dependencies = [...new Set(operation.dependencies ?? [])];
  if (dependencies.length === 0) return null;
  const tx = transaction.databaseTransaction;
  const receipts = await tx.selectFrom('sync_sequence_receipts').select(['operation_id', 'status'])
    .where('collection_id', '=', transaction.authority.collectionId)
    .where('operation_id', 'in', dependencies).execute();
  const statuses = new Map(receipts.map(row => [row.operation_id, row.status]));
  const absent = dependencies.filter(id => !statuses.has(id));
  const canonical = absent.length === 0 ? [] : await tx.selectFrom('operations').select('operation_id')
    .where('collection_id', '=', transaction.authority.collectionId).where('operation_id', 'in', absent).execute();
  const committed = new Set(canonical.map(row => row.operation_id));
  const failed = receipts.some(row => row.status === 'rejected');
  const pending = dependencies.some(id => statuses.get(id) === 'deferred' || !statuses.has(id) && !committed.has(id));
  if (!failed && !pending) return null;
  const status = failed ? 'rejected' as const : 'deferred' as const;
  const result: SyncPushResult = { batchId, serverCursor: 'sync-unchanged', results: [{
    opId: operation.opId, sequence: operation.sequence, status,
    code: failed ? 'dependency_failed' : 'dependency_pending', warnings: [],
  }] };
  return { status, result };
}

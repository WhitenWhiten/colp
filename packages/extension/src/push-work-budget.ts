import { bootstrapBatchExclusion } from './outbound-push-batch.js';
import type { QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';
export const MAX_PUSH_DRAIN_OPERATIONS = 100;

export async function recordPushBatchDecision(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  queue: QueueOperation, negotiatedLimit: number, dispatchLimit: number) {
  await store.putScopeDiagnostic(scope, { kind: 'push_batch',
    code: queue.attempt || queue.retry.attempt ? 'retry' : bootstrapBatchExclusion(queue) ?? 'eligible',
    details: { negotiatedLimit, dispatchLimit } });
}

/** Conservative transport sizing; no correctness decision depends on timing. */
export function createPushWorkBudget(timeoutMs: number, initialOperations = 5) {
  const targetMs = Math.min(5_000, timeoutMs / 2);
  let millisecondsPerOperation = targetMs / Math.max(1, Math.min(50, initialOperations));
  let observed = false;
  return {
    limit(maximum: number, remainingMs: number) {
      const budget = Math.min(targetMs, Math.max(1, remainingMs));
      return Math.max(1, Math.min(maximum, Math.floor(budget / millisecondsPerOperation)));
    },
    observe(durationMs: number, operations: number, unknown: boolean) {
      const sample = Math.max(1, durationMs) / operations;
      millisecondsPerOperation = observed ? Math.max(sample, millisecondsPerOperation * 0.25 + sample * 0.75) : sample;
      observed = true;
      if (unknown) millisecondsPerOperation = Math.max(millisecondsPerOperation, targetMs / Math.max(1, operations / 2));
    },
  };
}

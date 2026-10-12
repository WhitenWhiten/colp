import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getQueueByOpId' | 'getQueueReceipt'>;

/** Only the exact successful local predecessor may replace a provisional base. */
export async function resolveObservedBase(store: Store, scope: SyncScope, draft: JsonObject,
  colpId: string): Promise<string | null> {
  const revision = draft.baseRevision;
  if (typeof revision !== 'string') return null; // Legacy drafts discarded their observation.
  if (!revision.startsWith('local-')) return draft.targetId === colpId ? revision : null;
  const predecessor = await store.getQueueByOpId(scope, revision.slice('local-'.length));
  if (!predecessor || predecessor.status !== 'terminal') return null;
  const receipt = await store.getQueueReceipt(scope, predecessor.sequence);
  if (receipt?.kind !== 'terminal' || receipt.opId !== predecessor.opId
      || receipt.operationDigest !== predecessor.digest) return null;
  const results = receipt.result?.results;
  const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined;
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.opId !== predecessor.opId || result.sequence !== predecessor.sequence
      || result.status !== 'applied' && result.status !== 'rebased'
      || typeof result.revision !== 'string') return null;
  const target = result.targetId ?? predecessor.payload.targetId;
  return target === colpId ? result.revision : null;
}

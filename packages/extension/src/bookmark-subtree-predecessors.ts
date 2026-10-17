import { subtreeDeleteSource } from '@know-n/colp/sync/canonical';
import type { HealStore, EventDependency } from './bookmark-event-heal.js';
import type { JsonObject, SyncScope } from './sync-state-store.js';

/** Resolve only the captured members through their exact local predecessor receipts. */
export async function resolveSubtreePredecessors(store: HealStore, scope: SyncScope,
  targetId: string, observation: readonly JsonObject[]): Promise<
    { source: ReturnType<typeof subtreeDeleteSource> } | { blocked: EventDependency }> {
  const members: { id: string; revision: string }[] = [];
  for (const member of observation) {
    const nativeId = String(member.nativeId), originalId = String(member.colpId), revision = String(member.revision);
    let opId = revision.startsWith('local-') ? revision.slice(6)
      : originalId.startsWith('pending-') ? originalId.slice(8) : undefined;
    if (!opId) { members.push({ id: originalId, revision }); continue; }
    const event = await store.getBookmarkEvent(scope, opId);
    if (event?.opId) opId = event.opId;
    const queued = await store.getQueueByOpId(scope, opId);
    const receipt = queued?.status === 'terminal' ? await store.getQueueReceipt(scope, queued.sequence) : null;
    const results = receipt?.result?.results;
    const result = Array.isArray(results) && results.length === 1 ? results[0] : undefined;
    if (!queued || !result || typeof result !== 'object' || Array.isArray(result)
        || receipt?.operationDigest !== queued.digest || receipt.opId !== opId
        || result.opId !== opId || result.sequence !== queued.sequence
        || result.status !== 'applied' && result.status !== 'rebased' || typeof result.revision !== 'string') {
      return { blocked: { nativeId, opId } };
    }
    const id = typeof result.targetId === 'string' ? result.targetId : queued.payload.targetId;
    if (typeof id !== 'string' || !originalId.startsWith('pending-') && id !== originalId) {
      throw new Error('subtree_observation_unavailable');
    }
    members.push({ id, revision: result.revision });
  }
  if (!members.some(member => member.id === targetId)) throw new Error('subtree_observation_unavailable');
  return { source: subtreeDeleteSource(targetId, members) };
}

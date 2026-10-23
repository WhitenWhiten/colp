import { identityFromCreateReceipt } from '../bookmark-create-receipt-identity.js';
import type { JsonObject, SyncScope, createSyncStateStore } from '../sync-state-store.js';
import type { CanonicalCreate, ReceiptEvidence } from './receipt-sync.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>, 'getQueueByOpId' | 'getQueueReceipt' | 'listBookmarkEventsByNative'>
  & Parameters<typeof identityFromCreateReceipt>[0];

const record = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
/** Sync clocks and native event clocks are separate; allow a little skew before "after the move" fails closed. */
const MOVE_SKEW_MS = 5_000;

/** The first result of a Push receipt, when the server applied it. */
function applied(result: JsonObject | undefined): boolean {
  const row = Array.isArray(result?.results) ? result.results[0] : undefined;
  return record(row) && (row.status === 'applied' || row.status === 'rebased');
}

/**
 * Canonical evidence from the local Sync engine, for receipts only. A create
 * counts once its Push was applied (the engine's own create receipt); a move
 * counts when a queued move of this bookmark into the destination, staged after
 * the observed move, was applied. Anything less is not evidence yet.
 */
export function syncReceiptEvidence(store: Store, scope: SyncScope): ReceiptEvidence {
  return {
    async create(nativeId): Promise<CanonicalCreate | null> {
      const identity = await identityFromCreateReceipt(store, scope, nativeId);
      if (!identity?.createOpId) return store.getRetainedCreateReceipt(scope, nativeId);
      const queued = await store.getQueueByOpId(scope, identity.createOpId);
      if (!queued) return store.getRetainedCreateReceipt(scope, nativeId);
      const payload = record(queued?.payload.payload) ? queued.payload.payload : undefined;
      const node = record(payload?.node) ? payload.node : undefined;
      if (queued.status !== 'terminal' || !node || node.kind !== 'bookmark'
          || typeof node.url !== 'string' || typeof node.title !== 'string') return null;
      return { nodeId: identity.colpId, operationId: identity.createOpId, url: node.url, title: node.title,
        tags: Array.isArray(node.tags) ? node.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        parentNodeId: typeof payload?.parentId === 'string' ? payload.parentId : null };
    },
    async move(nativeId, destinationNativeId, since) {
      let after = 0;
      for (;;) {
        const page = await store.listBookmarkEventsByNative(scope, nativeId, after, 1_000);
        for (const event of page) {
          const context = record(event.details.context) ? event.details.context : undefined;
          if (event.kind !== 'move' || !event.opId || context?.targetParentNativeId !== destinationNativeId
            || Date.parse(event.occurredAt) < since - MOVE_SKEW_MS) continue;
          const queued = await store.getQueueByOpId(scope, event.opId);
          if (queued?.status === 'terminal' && applied((await store.getQueueReceipt(scope, queued.sequence))?.result)) return event.opId;
        }
        if (page.length < 1_000) return null;
        after = page[page.length - 1]!.ordinal;
      }
    },
  };
}

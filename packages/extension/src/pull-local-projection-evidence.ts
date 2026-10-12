import type { PullBookmarkApi } from './pull-applier-types.js';
import type { JsonObject, MappingInput, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;
type Native = Awaited<ReturnType<PullBookmarkApi['get']>>[number];

/** Validate a later local post-state without promoting a pending inbox mapping. */
export async function advancedSelfProjectionIsProven(store: Store, scope: SyncScope, mapping: MappingInput,
  native: Native | undefined, originalParentNativeId: string, afterSequence: number): Promise<boolean> {
  if (!native || native.id !== mapping.nativeId) return false;
  let observedProjection = mapping;
  let pendingEvidence = false;
  let pendingMoveParent: string | undefined;
  let afterOrdinal = 0;
  for (;;) {
    const events = await store.listBookmarkEventsByStatus(scope, 'pending', afterOrdinal, 1_000);
    for (const event of events) {
      const draft = object(event.details.draft); const projected = object(event.details.mapping);
      if (event.nativeId !== mapping.nativeId || projected?.nativeId !== mapping.nativeId
          || projected.colpId !== mapping.colpId) continue;
      if (!(event.kind === 'change' && draft?.type === 'update_node_content'
          || event.kind === 'move' && draft?.type === 'move_node')) continue;
      const context = object(event.details.context);
      if (event.kind === 'move' && (typeof context?.targetParentNativeId !== 'string'
          || context.targetParentNativeId !== projected.parentNativeId)) continue;
      observedProjection = projected as unknown as MappingInput;
      pendingEvidence = true;
      if (event.kind === 'move') pendingMoveParent = String(context!.targetParentNativeId);
    }
    if (events.length < 1_000) break;
    afterOrdinal = events.at(-1)!.ordinal;
  }
  const content = observedProjection.projection.content;
  if (!content || native.parentId !== (observedProjection.parentNativeId ?? originalParentNativeId)
      || native.title !== content.title || native.url !== content.url) return false;
  const projection = await matchingProjectionOperation(store, scope, mapping, afterSequence);
  if (!projection && !pendingEvidence) return false;
  if (native.parentId === originalParentNativeId) return true;
  const parent = await store.getMappingByNativeId(scope, native.parentId);
  if (!parent) return false;
  if (pendingMoveParent) return pendingMoveParent === native.parentId;
  let move: QueueOperation | undefined;
  for await (const queued of queueAfter(store, scope, afterSequence, projection?.sequence)) {
    if (queued.status !== 'rejected' && queued.payload.type === 'move_node'
        && queued.payload.targetId === mapping.colpId) move = queued;
  }
  return Boolean(move && object(move.payload.payload)?.newParentId === parent.colpId
    && (move.status !== 'terminal' || await successfulProjectionReceipt(store, scope, move)));
}

async function matchingProjectionOperation(store: Store, scope: SyncScope, mapping: MappingInput,
  afterSequence: number): Promise<QueueOperation | null> {
  for await (const queued of queueAfter(store, scope, afterSequence)) {
    if (queued.status === 'rejected' || queued.payload.targetId !== mapping.colpId
        || queued.payload.type !== 'move_node' && queued.payload.type !== 'update_node_content') continue;
    if (queued.operationRevision === mapping.projection.revision) return queued;
    if (queued.status === 'terminal' && await successfulProjectionReceipt(store, scope, queued,
      mapping.projection.revision)) return queued;
  }
  return null;
}

async function successfulProjectionReceipt(store: Store, scope: SyncScope, queued: QueueOperation,
  revision?: string): Promise<boolean> {
  const receipt = await store.getQueueReceipt(scope, queued.sequence);
  const results = receipt?.result?.results;
  const result = Array.isArray(results) && results.length === 1 ? object(results[0]) : undefined;
  return receipt?.kind === 'terminal' && receipt.opId === queued.opId && receipt.operationDigest === queued.digest
    && result?.opId === queued.opId && result.sequence === queued.sequence
    && (result.status === 'applied' || result.status === 'rebased') && typeof result.revision === 'string'
    && (revision === undefined || result.revision === revision)
    && (result.targetId === undefined || result.targetId === queued.payload.targetId);
}

async function* queueAfter(store: Store, scope: SyncScope, afterSequence: number,
  throughSequence = Number.MAX_SAFE_INTEGER): AsyncGenerator<QueueOperation> {
  let after = afterSequence;
  for (;;) {
    const page = await store.listQueue(scope, undefined, after, 1_000);
    for (const queued of page) { if (queued.sequence > throughSequence) return; yield queued; }
    if (page.length < 1_000) return;
    after = page.at(-1)!.sequence;
  }
}
function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

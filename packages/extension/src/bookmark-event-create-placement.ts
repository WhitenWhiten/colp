import type { BookmarkCreatePlacementRecord, CreatePlacementConsumeResult } from './bookmark-create-placement.js';
import type { BookmarkEventNode } from './bookmark-event-codec.js';
import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

export async function resolveCreatePlacement(input: {
  readonly resolve?: (nativeId: string, node: BookmarkEventNode) => Promise<CreatePlacementConsumeResult | undefined>;
  readonly complete?: (intentId: string, nativeId?: string) => Promise<void>;
  readonly markAttention?: (intentId: string) => Promise<void>;
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope;
  readonly nativeId: string; readonly node: BookmarkEventNode; readonly parentNativeId: string;
}): Promise<{ readonly intent?: BookmarkCreatePlacementRecord; readonly context?: JsonObject; readonly hold?: string }> {
  if (!input.resolve) return {};
  const result = await input.resolve(input.nativeId, input.node);
  if (!result) return {};
  // Local saves also reserve placement for crash recovery, without claiming a
  // cloud collection. If that bookmark later enters the sync boundary, capture
  // its current native placement normally and leave its local receipt intact.
  const candidates = result.state === 'ready' ? [result.intent] : result.candidates;
  if (candidates.length > 0 && candidates.every(intent => intent.collectionId === undefined)) {
    return {};
  }
  if (result.state === 'unproven') {
    await placementAttention(input.store, input.scope, input.nativeId, result.candidates);
    return { hold: IDENTITY_UNPROVEN };
  }
  const intent = result.intent;
  if (intent.collectionId !== input.scope.collectionId || intent.targetParentNativeId !== input.parentNativeId
      || (intent.mode !== 'top' && intent.mode !== 'bottom') || intent.expectedIndex !== (input.node.index ?? 0)
      || intent.batchSize < 1 || intent.batchOrder < 0 || intent.batchOrder >= intent.batchSize
      || intent.title !== input.node.title || intent.url !== input.node.url) {
    await input.markAttention?.(intent.intentId);
    await placementAttention(input.store, input.scope, input.nativeId, [intent]);
    return { hold: IDENTITY_UNPROVEN };
  }
  return { intent, context: { version: 1, mode: intent.mode, targetParentNativeId: intent.targetParentNativeId,
    collectionId: intent.collectionId, batchId: intent.batchId, batchOrder: intent.batchOrder,
    batchSize: intent.batchSize, expectedIndex: intent.expectedIndex, intentId: intent.intentId } };
}

export async function completeCreatePlacement(input: {
  readonly complete?: (intentId: string, nativeId?: string) => Promise<void>;
  readonly intent?: BookmarkCreatePlacementRecord; readonly outcome: string;
}): Promise<void> {
  if (input.intent && (input.outcome === 'staged' || input.outcome === 'duplicate')) await input.complete?.(input.intent.intentId, input.intent.nativeId);
}

/**
 * The save cannot be tied to one placement reservation. It is captured where
 * the browser put it but held as one item (`recovery_identity_unproven`) until
 * someone decides; later saves keep uploading.
 */
const IDENTITY_UNPROVEN = 'recovery_identity_unproven';

async function placementAttention(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  nativeId: string, candidates: readonly BookmarkCreatePlacementRecord[]): Promise<void> {
  await store.putScopeDiagnostic(scope, { kind: 'bookmark_create_placement', code: 'identity_unproven',
    details: { nativeId, candidateCount: candidates.length } }).catch(() => undefined);
}

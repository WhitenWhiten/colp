/**
 * A-F1: a plain browser create names a sibling it was captured next to
 * (`afterId`/`beforeId`). When another device deletes or moves that sibling
 * first, the server answers 409 `position_context_stale` for every replay, and
 * nothing rewrote the anchor: the create stayed lane head for ever with an
 * identical payload while every later upload waited behind it.
 *
 * A stale answer is a definitive refusal (the server executed nothing and the
 * attempt was cleared), so the create may be re-authored under the same opId
 * and sequence with a new idempotency identity. A create whose attempt is still
 * bound may already have executed; it is never touched here.
 */
import { LOCAL_FAILURE_HOLD_ATTEMPTS } from './push-local-failure.js';
import { isPlacementRefusal } from './placement-refusal.js';
import { rebaseStaleCreatePlacement } from './create-placement-rebase.js';
import { rebaseTombstonedCreate } from './tombstone-parent-rebase.js';
import type { PlacementRefreshOutcome } from './durable-sync-engine-types.js';
import type { JsonObject, MappingInput, QueueOperation, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

/** Stale answers in a row after which the anchors are dropped even though the local mirror still lists them. */
export const STALE_ANCHOR_REAUTHOR_ATTEMPTS = LOCAL_FAILURE_HOLD_ATTEMPTS;

const ANCHORS = ['afterId', 'beforeId'] as const;

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** Whether the mirrored sibling still lives under the destination parent. */
async function liveUnderParent(store: Pick<Store, 'getMappingByColpId'>, scope: SyncScope, anchorId: string,
  parentId: string, parent: MappingInput | null): Promise<boolean> {
  const mapped = await store.getMappingByColpId(scope, anchorId);
  if (!mapped) return false;
  if (mapped.parentColpId !== undefined) return mapped.parentColpId === parentId;
  return parent !== null && mapped.parentNativeId !== undefined && mapped.parentNativeId === parent.nativeId;
}

/**
 * Drops the anchors the mirror no longer lists under the create's parent, and
 * every anchor once the server has refused the placement `STALE_ANCHOR_REAUTHOR_ATTEMPTS`
 * times in a row. Returns the row to send: re-authored, or the argument itself.
 */
export async function rebaseStaleCreateAnchors(input: {
  readonly store: Pick<Store, 'getMappingByColpId' | 'rebaseClaimedPush'>; readonly scope: SyncScope;
  readonly queue: QueueOperation; readonly ownerId: string; readonly fence: number;
  readonly digestJson: (value: unknown) => string;
}): Promise<QueueOperation> {
  const { store, scope, queue } = input;
  if (queue.payload.type !== 'create_node' || queue.attempt !== undefined || queue.retry.attempt === 0) return queue;
  const inner = asObject(queue.payload.payload);
  if (!inner || ANCHORS.every((key) => inner[key] === undefined)) return queue;
  const refusedRepeatedly = isPlacementRefusal(queue.recovery?.code)
    && queue.retry.attempt >= STALE_ANCHOR_REAUTHOR_ATTEMPTS;
  const next: Record<string, unknown> = { ...inner };
  const parentId = typeof inner.parentId === 'string' ? inner.parentId : undefined;
  const parent = parentId === undefined ? null : await store.getMappingByColpId(scope, parentId);
  for (const key of ANCHORS) {
    const id = next[key];
    if (id === undefined) continue;
    const keep = !refusedRepeatedly && typeof id === 'string' && parentId !== undefined
      && await liveUnderParent(store, scope, id, parentId, parent);
    if (!keep) delete next[key];
  }
  if (ANCHORS.every((key) => next[key] === inner[key])) return queue;
  const payload = { ...queue.payload, payload: next as JsonObject };
  return store.rebaseClaimedPush(scope, queue.sequence, input.ownerId, input.fence, {
    payload, digest: `sha256:${input.digestJson(payload)}`,
    idempotencyKey: `${queue.opId}.anchors.${queue.retry.attempt}`, baseRevision: queue.baseRevision,
  });
}

/**
 * Every re-anchoring a retried create may need, in order: a tombstoned parent,
 * the saved placement intent, then sibling anchors that are no longer live.
 */
export async function rebaseRetriedCreate(input: {
  readonly store: Store; readonly scope: SyncScope; readonly queue: QueueOperation; readonly ownerId: string;
  readonly fence: number; readonly digestJson: (value: unknown) => string;
  readonly refreshPlacement?: (() => Promise<PlacementRefreshOutcome | void>) | undefined;
  readonly readChildrenOrder?: ((parentNativeId: string) => Promise<readonly string[]>) | undefined;
  readonly defer: (code: string) => Promise<'unknown'>;
}): Promise<QueueOperation | 'terminal' | 'unknown' | 'recovery'> {
  const { queue } = input;
  const parent = await rebaseTombstonedCreate({ store: input.store, scope: input.scope, queue,
    ownerId: input.ownerId, fence: input.fence, refreshPlacement: input.refreshPlacement, digestJson: input.digestJson });
  if (typeof parent === 'string' || parent.digest !== queue.digest || parent.idempotencyKey !== queue.idempotencyKey) return parent;
  const placed = await rebaseStaleCreatePlacement({ store: input.store, scope: input.scope, queue: parent,
    ownerId: input.ownerId, fence: input.fence, digestJson: input.digestJson,
    readChildrenOrder: input.readChildrenOrder, defer: input.defer });
  if (typeof placed === 'string') return placed;
  return rebaseStaleCreateAnchors({ store: input.store, scope: input.scope, queue: placed,
    ownerId: input.ownerId, fence: input.fence, digestJson: input.digestJson });
}

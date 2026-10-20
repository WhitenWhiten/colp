import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'listQueueByTarget' | 'listBookmarkEventsByNative' | 'pullOperationsCovered'>;

/** A later captured placement keeps its native destination while Pull advances
 * the earlier remote parent/revision. Neither its queue nor its receipt changes. */
export async function pendingLocalMoveForEvent(store: Store, scope: SyncScope, mapping: {
  readonly colpId: string; readonly nativeId: string;
}, parent: { readonly nativeId: string; readonly colpId: string },
event: Extract<SyncPullEventV02, { kind: 'operation' }>): Promise<boolean> {
  let ordinal = 0, captured: JsonObject | undefined;
  for (;;) {
    const page = await store.listBookmarkEventsByNative(scope, mapping.nativeId, ordinal, 1_000);
    for (const row of page) {
      if (row.status !== 'pending' || row.kind !== 'move') continue;
      const draft = object(row.details.draft), projected = object(row.details.mapping);
      if (draft?.type === 'move_node' && draft.targetId === mapping.colpId
          && projected?.colpId === mapping.colpId) captured = row.details;
    }
    if (page.length < 1_000) break;
    ordinal = page.at(-1)!.ordinal;
  }
  // Only the newest captured placement may protect this destination. An older
  // move to the same folder is not proof of a subsequent unobserved return.
  if (captured) return object(captured.context)?.targetParentNativeId === parent.nativeId
    && object(captured.mapping)?.parentNativeId === parent.nativeId;
  const rows = (await store.listQueueByTarget(scope, mapping.colpId))
    .filter(row => row.status !== 'rejected' && row.echoApplied !== true
      && row.payload.type === 'move_node' && row.payload.targetId === mapping.colpId);
  const covered = new Set(await store.pullOperationsCovered(scope, rows.map(row => row.opId)));
  if (event.operation.replicaId === scope.replicaId) covered.add(event.operation.opId);
  if (event.operation.source?.adapterProfile === 'known-conflict-resolution') {
    for (const opId of event.operation.dependencies ?? []) covered.add(opId);
  }
  const latest = rows.filter(row => !covered.has(row.opId)).sort((left, right) => right.sequence - left.sequence)[0];
  return object(latest?.payload.payload)?.newParentId === parent.colpId;
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { JsonObject, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = Pick<ReturnType<typeof createSyncStateStore>,
  'listQueueByTarget' | 'listBookmarkEventsByNative' | 'pullOperationsCovered'>;
const LIVE_QUEUE = new Set(['pending', 'claimed', 'deferred', 'unknown']);

export async function queueHasPendingTarget(store: Store, scope: SyncScope, colpId: string) {
  const rows = await store.listQueueByTarget(scope, colpId);
  return rows.some((row) => row.payload.targetId === colpId && LIVE_QUEUE.has(row.status));
}

export async function hasPendingLocalMove(store: Store, scope: SyncScope,
  mapping: { readonly colpId: string; readonly nativeId: string }): Promise<boolean> {
  const moves = (await store.listQueueByTarget(scope, mapping.colpId)).filter(row =>
    row.payload.type === 'move_node' && row.status !== 'rejected' && row.echoApplied !== true
    && row.recovery?.resultStatus !== 'rejected');
  const covered = new Set(await store.pullOperationsCovered(scope, moves.map(row => row.opId)));
  if (moves.some(row => !covered.has(row.opId))) return true;
  let ordinal = 0;
  for (;;) {
    const page = await store.listBookmarkEventsByNative(scope, mapping.nativeId, ordinal, 1_000);
    if (page.some(event => event.status === 'pending' && event.kind === 'move')) return true;
    if (page.length < 1_000) return false;
    ordinal = page.at(-1)!.ordinal;
  }
}

/** Native fields authored by local work, including drafts not yet assigned a Sequence.
 * Queue and inbox rows come from the target indexes. Echo and conflict coverage is a
 * per-op fact or terminal event, not a scan of retained Pull history. */
export async function pendingLocalContentFields(store: Store, scope: SyncScope, mapping: {
  readonly colpId: string; readonly nativeId: string;
}, resolvedOperations: readonly string[] = []): Promise<JsonObject> {
  const applied = new Set(resolvedOperations);
  const rows = (await store.listQueueByTarget(scope, mapping.colpId))
    .filter((item) => item.status !== 'rejected' && item.echoApplied !== true && item.payload.type === 'update_node_content'
      && item.payload.targetId === mapping.colpId)
    .sort((left, right) => left.sequence - right.sequence);
  const uncovered = rows.filter((item) => !applied.has(item.opId)).map((item) => item.opId);
  for (const opId of await store.pullOperationsCovered(scope, uncovered)) applied.add(opId);
  const fields: Record<string, string> = {};
  for (const item of rows) if (!applied.has(item.opId)) overlayChangedFields(fields, item.payload.payload);
  let ordinal = 0;
  for (;;) {
    const page = await store.listBookmarkEventsByNative(scope, mapping.nativeId, ordinal, 1_000);
    for (const event of page) {
      if (event.status !== 'pending') continue;
      const draft = object(event.details.draft); const projected = object(event.details.mapping);
      if (draft?.type === 'update_node_content'
          && (draft.targetId === mapping.colpId || projected?.colpId === mapping.colpId)) {
        overlayChangedFields(fields, draft.payload);
      }
    }
    if (page.length < 1_000) break;
    ordinal = page.at(-1)!.ordinal;
  }
  return fields;
}

function overlayChangedFields(fields: Record<string, string>, payload: unknown) {
  const record = object(payload); const base = object(record?.base); const value = object(record?.value);
  for (const key of ['title', 'url']) {
    if (typeof value?.[key] === 'string' && value[key] !== base?.[key]) fields[key] = value[key];
  }
}
function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

/** A resolution supersedes only the local operations named by the authoritative effect. */
export async function pendingLocalContentForEvent(store: Store, scope: SyncScope,
  mapping: { readonly colpId: string; readonly nativeId: string }, event: Extract<SyncPullEventV02, { kind: 'operation' }>) {
  const resolved = event.operation.source?.adapterProfile === 'known-conflict-resolution'
    ? [...event.operation.dependencies ?? []] : [];
  if (event.operation.replicaId === scope.replicaId) resolved.push(event.operation.opId);
  return pendingLocalContentFields(store, scope, mapping, resolved);
}

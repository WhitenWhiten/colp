import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { IntentRecord, JsonObject, MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { NativeWriteNotStartedError } from './native-call-result.js';
import { nativeWritePreimage, prepareNativeWriteCheck, storedNativeWritePreimage } from './pull-native-write-boundary.js';
import { SyncFailureError } from './sync-failure-class.js';

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

/** Prepared move events must not overwrite an invocation reported by another
 * wake. The writer compares this entire admitted intent in its transaction. */
export async function markUnstartedMoveCall(store: ReturnType<typeof createSyncStateStore>,
  scope: SyncScope, eventId: string): Promise<void> {
  const intent = await store.getApplyIntent(scope, `intent:${eventId}`);
  if (!intent || intent.state !== 'intent_prepared' || intent.apiPhase !== 'intent_prepared'
      || intent.nativeResult !== 'not_started' || intent.replayState !== 'not_started'
      || intent.generation !== scope.generation || intent.expected.kind !== 'move'
      || intent.anchors?.rangeAction !== 'native_move' || intent.anchors.chromeMutation !== true
      || intent.apiResultEvidence || intent.nativeEventEvidence || intent.nativeResultConfirmation
      || intent.nativeWaitDecision || intent.waitReason) {
    throw new NativeWriteNotStartedError(new SyncFailureError('concurrent_local_mutation'));
  }
  await store.markPullBrowserCallStarted(scope, eventId, intent);
}

/** A proven non-call may admit a newer captured placement on its next wake.
 * Keep the old content/identity preimage: a move capture proves only placement.
 * The repository rechecks the complete intent before replacing those anchors. */
export async function readmitCapturedLocalMove(input: {
  readonly store: ReturnType<typeof createSyncStateStore>; readonly scope: SyncScope;
  readonly api: PullBookmarkApi; readonly mapping: MappingInput;
  readonly event: Extract<SyncPullEventV02, { kind: 'operation' }>;
  readonly intent: IntentRecord | null;
}): Promise<void> {
  const { intent, store, scope, mapping, api } = input;
  if (!intent || intent.state !== 'intent_prepared' || intent.apiPhase !== 'intent_prepared'
      || intent.nativeResult !== 'not_started' || intent.replayState !== 'not_started'
      || intent.generation !== scope.generation || intent.expected.kind !== 'move'
      || intent.nativeTargetId !== mapping.nativeId || intent.anchors?.rangeAction !== 'native_move'
      || intent.anchors.chromeMutation !== true || intent.apiResultEvidence || intent.nativeEventEvidence
      || intent.nativeResultConfirmation || intent.nativeWaitDecision || intent.waitReason) return;
  const prior = storedNativeWritePreimage(intent.anchors.nativePreimage);
  if (!prior || prior.id !== mapping.nativeId) return;
  const looked = await lookupBookmark(id => api.get(id), mapping.nativeId);
  if (looked.class !== 'present' || looked.nodes.length !== 1) return;
  const source = looked.nodes[0]!;
  if (source.id !== mapping.nativeId || !source.parentId
      || source.parentId === prior.parentId && source.index === prior.index) return;
  const parent = await store.getMappingByNativeId(scope, source.parentId);
  if (!parent || parent.rootNativeId !== mapping.rootNativeId
      || !await pendingLocalMoveForEvent(store, scope, mapping, parent, input.event)) return;
  const parentNative = await lookupBookmark(id => api.get(id), parent.nativeId);
  if (parentNative.class !== 'present' || parentNative.nodes.length !== 1) return;
  const preimage = { ...prior, parentId: source.parentId, index: source.index };
  const parentCheck = await prepareNativeWriteCheck({ store, scope, api, mapping: parent,
    preimage: parentNative.nodes[0]!, parent: true });
  const sourceCheck = await prepareNativeWriteCheck({ store, scope, api, mapping, preimage });
  try {
    await parentCheck();
    if (!await pendingLocalMoveForEvent(store, scope, mapping, parent, input.event)) {
      throw new SyncFailureError('concurrent_local_mutation');
    }
    await sourceCheck();
  } catch (error) { throw new NativeWriteNotStartedError(error); }
  await store.refreshUnstartedMovePreimage(scope, intent, nativeWritePreimage(preimage));
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

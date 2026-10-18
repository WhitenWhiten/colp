import { SnapshotItemPreconditionError } from './snapshot-item-precondition.js';
import { SyncFailureError } from './sync-failure-class.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import { nativeContent } from './pull-projection.js';
import { digest } from './pull-codec.js';
import { applyRemoteMappingContentUpdate } from './pull-native-content-barrier.js';
import { pendingLocalContentFields } from './pull-queue-facts.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { ProjectionIntent } from './recovery-overlay.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

export type RecoveryContentStore = Pick<ReturnType<typeof createSyncStateStore>,
  'getScope' | 'getMappingByColpId' | 'getMappingByNativeId' | 'stageBookmarkEvent' | 'getPullEvent' | 'listMountBindings'
  | 'listQueue' | 'listQueueByTarget' | 'listBookmarkEventsByNative' | 'pullOperationsCovered'
  | 'listBookmarkEventsByStatus' | 'listPullEvents' | 'putRemoteObservation'>;

/** Existing identities need content intents as well as newly materialized children. */
export function planSnapshotContentUpdates(incoming: readonly MappingInput[], live: readonly MappingInput[]): ProjectionIntent[] {
  const byId = new Map(live.map(mapping => [mapping.colpId, mapping]));
  const intents: ProjectionIntent[] = [];
  for (const mapping of incoming) {
    const prior = byId.get(mapping.colpId);
    if (!prior || virtualNativeId(mapping.nativeId) || prior.nativeId !== mapping.nativeId
        || mapping.nodeKind === 'separator' || mapping.rootRole
        || mapping.projection.content?.folderRole === 'root') continue;
    const content = nativeContent(mapping.projection.content ?? {});
    const baseline = nativeContent(prior.projection.content ?? {});
    if (Object.entries(content).every(([key, value]) => baseline[key] === value)) continue;
    intents.push({ intentId: `update:${mapping.colpId}`, kind: 'update', colpId: mapping.colpId,
      order: intents.length + 1, nativeId: mapping.nativeId, suppression: `recovery:update:${mapping.colpId}`,
      ...(typeof content.title === 'string' ? { title: content.title } : {}),
      ...(typeof content.url === 'string' ? { url: content.url } : {}) });
  }
  return intents;
}

export async function applySnapshotContent(input: {
  readonly store: RecoveryContentStore; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly incoming: MappingInput; readonly intent: ProjectionIntent; readonly cursor?: string;
}): Promise<MappingInput> {
  const { store, scope, incoming, intent, api } = input;
  const stored = await store.getMappingByColpId(scope, incoming.colpId);
  if (!stored || stored.nativeId !== incoming.nativeId) throw new SyncFailureError('snapshot_content_baseline_missing');
  // Locally authored content mappings can carry only the native parent. Keep
  // that placement identity when retaining the old content authority.
  const parent = !stored.parentColpId && stored.parentNativeId
    ? await store.getMappingByNativeId(scope, stored.parentNativeId) : null;
  const prior = parent ? { ...stored, parentColpId: parent.colpId } : stored;
  const desired: MappingInput = { ...incoming, projection: { ...incoming.projection,
    content: { ...incoming.projection.content,
      ...(intent.title === undefined ? {} : { title: intent.title }),
      ...(intent.url === undefined ? {} : { url: intent.url }) } } };
  const eventId = `snapshot-content:${incoming.colpId}:${incoming.projection.revision}`;
  // commitRecovery stamps echoApplied only after this projection. Terminal rows
  // are already settled, so they must not keep the snapshot as an observation.
  const resolvedOperations: string[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await store.listQueue(scope, 'terminal', afterSequence, 1_000);
    for (const row of page) resolvedOperations.push(row.opId);
    if (page.length < 1_000) break;
    afterSequence = page.at(-1)!.sequence;
  }
  const result = await applyRemoteMappingContentUpdate({ store, scope, api, mapping: prior,
    incomingMapping: desired, effectDigest: digest(desired), eventId, now: Date.now,
    mounts: await store.listMountBindings(scope),
    lookup: id => lookupBookmark(key => api.get(key), id),
    targetMissingError: async () => new SyncFailureError('snapshot_content_target_missing'),
    queuedLocal: await pendingLocalContentFields(store, scope, prior, resolvedOperations),
    observationCursor: input.cursor });
  if (result.rangeExit) await store.putRemoteObservation(scope, result.rangeExit.observation);
  return result.mapping;
}

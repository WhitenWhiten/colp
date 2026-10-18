import { SnapshotItemPreconditionError } from './snapshot-item-precondition.js';
import { SyncFailureError } from './sync-failure-class.js';
import { durableEventDetails, digestJson } from './bookmark-event-codec.js';
import { withinPrivateNativeBoundary } from './native-private-boundary.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { mappingMountActivity } from './pull-range-move.js';
import { nativeContent } from './pull-projection.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { virtualNativeId } from './projection-native-occupancy.js';
import type { ProjectionIntent } from './recovery-overlay.js';
import type { RecoveryContentStore } from './recovery-content.js';
import type { JsonObject, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';
import type { PullBookmarkApi } from './pull-applier-types.js';

type RecoveryPlacementStore = RecoveryContentStore & Pick<ReturnType<typeof createSyncStateStore>,
  'listQueueByTarget' | 'listBookmarkEventsByNative'>;

/** Existing native identities need a durable move intent when Snapshot changes their parent. */
export function planSnapshotPlacementUpdates(
  incoming: readonly MappingInput[], live: readonly MappingInput[],
): ProjectionIntent[] {
  const byColp = new Map(live.map((mapping) => [mapping.colpId, mapping]));
  const siblingOffsets = new Map<string | undefined, number>();
  const intents: ProjectionIntent[] = [];
  for (const mapping of incoming) {
    const index = siblingOffsets.get(mapping.parentColpId) ?? 0;
    if (mapping.nodeKind !== 'separator') siblingOffsets.set(mapping.parentColpId, index + 1);
    const prior = byColp.get(mapping.colpId);
    if (!prior || virtualNativeId(mapping.nativeId) || prior.nativeId !== mapping.nativeId
        || mapping.nodeKind === 'separator' || mapping.rootRole
        || mapping.projection.content?.folderRole === 'root'
        || !mapping.parentColpId || mapping.parentNativeId === prior.parentNativeId) continue;
    intents.push({ intentId: `move:${mapping.colpId}`, kind: 'move', colpId: mapping.colpId,
      order: intents.length + 1, nativeId: mapping.nativeId, parentColpId: mapping.parentColpId,
      ...(mapping.parentNativeId && !virtualNativeId(mapping.parentNativeId)
        ? { parentNativeId: mapping.parentNativeId } : {}),
      suppression: `recovery:move:${mapping.colpId}`,
      index });
  }
  return intents;
}

export async function applySnapshotPlacement(input: {
  readonly store: RecoveryPlacementStore; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly incoming: MappingInput; readonly intent: ProjectionIntent;
}): Promise<MappingInput> {
  const { store, scope, api, incoming, intent } = input;
  const prior = await store.getMappingByColpId(scope, incoming.colpId);
  if (!prior || prior.nativeId !== incoming.nativeId) throw new SyncFailureError('snapshot_placement_baseline_missing');
  const parentColpId = intent.parentColpId ?? incoming.parentColpId;
  if (!parentColpId) {
    throw new SyncFailureError('snapshot_placement_parent_missing');
  }
  const remoteParent = await store.getMappingByColpId(scope, parentColpId);
  const parentNativeId = intent.parentNativeId ?? remoteParent?.nativeId;
  if (!remoteParent || !parentNativeId || virtualNativeId(parentNativeId)
      || remoteParent.nativeId !== parentNativeId) {
    throw new SyncFailureError('snapshot_placement_parent_missing');
  }
  const mounts = await store.listMountBindings(scope);
  await assertPlacementBoundary(store, scope, api, prior, remoteParent, mounts);

  const looked = await lookupBookmark(id => api.get(id), prior.nativeId);
  if (looked.class === 'not_found') throw new SnapshotItemPreconditionError('snapshot_placement_target_missing', { nodeId: prior.colpId, nativeId: prior.nativeId });
  if (looked.class !== 'present') throw new Error(looked.message);
  const currentParentId = looked.nodes[0]?.parentId;
  const currentIndex = looked.nodes[0]?.index;
  if (currentParentId === parentNativeId
      && (intent.index === undefined || currentIndex === intent.index)) return mappingWithStoredNativeContent(incoming, prior);

  const pendingLocal = await hasPendingLocalMove(store, scope, prior);
  if (currentParentId !== prior.parentNativeId && currentParentId !== undefined) {
    const localParent = await store.getMappingByNativeId(scope, currentParentId);
    if (!localParent || virtualNativeId(localParent.nativeId)) {
      throw new SnapshotItemPreconditionError('snapshot_placement_local_identity_unproven', { nodeId: prior.colpId, nativeId: prior.nativeId });
    }
    await assertPlacementBoundary(store, scope, api, prior, localParent, mounts);
    if (!pendingLocal) await stageLocalMove(store, scope, prior, localParent);
  } else if (pendingLocal && currentParentId === undefined) {
    throw new SnapshotItemPreconditionError('snapshot_placement_local_identity_unproven', { nodeId: prior.colpId, nativeId: prior.nativeId });
  }

  await api.move(prior.nativeId, {
    parentId: parentNativeId,
    ...(intent.index === undefined ? {} : { index: intent.index }),
  });
  return mappingWithStoredNativeContent(incoming, prior);
}

function mappingWithStoredNativeContent(incoming: MappingInput, prior: MappingInput): MappingInput {
  const content = { ...(incoming.projection.content ?? {}), ...nativeContent(prior.projection.content ?? {}) };
  return { ...incoming, projection: { ...incoming.projection, content,
    digest: prior.projection.digest } };
}

async function assertPlacementBoundary(
  store: RecoveryPlacementStore, scope: SyncScope, api: PullBookmarkApi,
  source: MappingInput, destination: MappingInput, mounts: readonly MountBindingRecord[],
): Promise<void> {
  if (isNonChromeNativeId(source.nativeId) || isNonChromeNativeId(destination.nativeId)
      || mappingMountActivity(source, mounts) !== 'active'
      || mappingMountActivity(destination, mounts) !== 'active') {
    throw new SyncFailureError('snapshot_placement_boundary');
  }
  if (mounts.length > 0) {
    const sourceMount = mountFor(source, mounts); const destinationMount = mountFor(destination, mounts);
    if (!sourceMount || !destinationMount || sourceMount.status !== 'active'
        || destinationMount.status !== 'active' || sourceMount.mountId !== destinationMount.mountId) {
      throw new SyncFailureError('snapshot_placement_boundary');
    }
  }
  if (source.rootNativeId !== destination.rootNativeId) throw new SyncFailureError('snapshot_placement_boundary');
  const privateRoots = (await store.getScope(scope))?.privateRoots ?? [];
  if (privateRoots.length === 0) return;
  const lookup = (id: string) => lookupBookmark(key => api.get(key), id);
  if (await withinPrivateNativeBoundary({ store, scope, mapping: source, privateRoots, lookup })
      || await withinPrivateNativeBoundary({ store, scope, mapping: destination, privateRoots, lookup })) {
    throw new SyncFailureError('snapshot_placement_boundary');
  }
}

function mountFor(mapping: MappingInput, mounts: readonly MountBindingRecord[]) {
  return mounts.find((mount) => mount.mountId === mapping.mountId || mount.nativeRootId === mapping.rootNativeId);
}

async function hasPendingLocalMove(
  store: RecoveryPlacementStore, scope: SyncScope, mapping: MappingInput,
): Promise<boolean> {
  const queueRows = await store.listQueueByTarget(scope, mapping.colpId);
  if (queueRows.some((row) => row.status !== 'terminal' && row.status !== 'rejected' && row.echoApplied !== true
      && row.payload.type === 'move_node')) return true;
  const events = await store.listBookmarkEventsByNative(scope, mapping.nativeId);
  return events.some((event) => event.status === 'pending' && event.kind === 'move'
    && mappingOf(event.details)?.colpId === mapping.colpId);
}

async function stageLocalMove(
  store: RecoveryPlacementStore, scope: SyncScope, mapping: MappingInput, destination: MappingInput,
): Promise<void> {
  const source = mapping.parentColpId ? await store.getMappingByColpId(scope, mapping.parentColpId)
    : mapping.parentNativeId ? await store.getMappingByNativeId(scope, mapping.parentNativeId) : null;
  if (!source || !source.projection.childrenRevision || !destination.projection.childrenRevision) {
    throw new SyncFailureError('snapshot_placement_children_fence_missing');
  }
  const eventId = `snapshot-placement:${mapping.colpId}:${mapping.projection.revision}:${destination.colpId}`;
  const operation: JsonObject = {
    type: 'move_node', targetId: mapping.colpId, baseRevision: mapping.projection.revision, dependencies: [],
    payload: { newParentId: destination.colpId, baseSourceParentRevision: source.projection.childrenRevision,
      baseTargetParentRevision: destination.projection.childrenRevision },
  };
  const content = mapping.projection.content ?? {};
  const localMapping: MappingInput = {
    ...mapping, rootNativeId: destination.rootNativeId, parentNativeId: destination.nativeId,
    parentColpId: destination.colpId, projection: { ...mapping.projection, revision: `local-${eventId}`,
      digest: digestJson(content), content },
  };
  await store.stageBookmarkEvent(scope, {
    eventId, dedupeKey: digestJson({ kind: 'move', nativeId: mapping.nativeId, operation }),
    occurredAt: new Date().toISOString(), kind: 'move', nativeId: mapping.nativeId,
    details: durableEventDetails({ snapshotPlacementBarrier: true, operation, context: {
      sourceParentNativeId: source.nativeId, targetParentNativeId: destination.nativeId,
    }, mapping: localMapping as unknown as JsonObject }),
  });
}

function mappingOf(details: JsonObject): MappingInput | undefined {
  const raw = details.mapping;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as unknown as MappingInput : undefined;
}

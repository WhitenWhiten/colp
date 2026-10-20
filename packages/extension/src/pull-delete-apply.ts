import { SyncFailureError } from './sync-failure-class.js';
import { withinPrivateNativeBoundary } from './native-private-boundary.js';
import { lookupBookmark } from './bookmark-api-error.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { recordKns09Stop } from './kns-09-release.js';
import { remoteDeleteDecisionId, remoteDeleteMemberIds } from './remote-delete-policy.js';
import { hasUnsettledDeleteEdits } from './remote-delete-local-work.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { PullBookmarkApi } from './pull-applier-types.js';
import { isNonChromeNativeId, isProtectedNativeRoot, mayMutateNative, unmountedNativeId } from './pull-mount-apply.js';
import { collectRetainedNativeIds, executeRemoteDeleteMembers, type DeleteMember } from './native-delete-executor.js';
import { pauseBindingForMapping } from './sync-state/remote-observation.js';
import type { LocalSyncExclusionRecord } from './sync-state/remote-delete-repository.js';
import type {
  MappingInput, MountBindingRecord, RemoteObservationRecord, SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Event = Extract<SyncPullEventV02, { kind: 'operation' }>;
type Store = ReturnType<typeof createSyncStateStore>;

export interface RemoteDeletionApply {
  readonly observations: readonly Omit<RemoteObservationRecord, 'scopeKey'>[];
  readonly deleteNativeIds: readonly string[];
  readonly mappings: readonly MappingInput[];
  readonly rangeExit?: {
    readonly observation: Omit<RemoteObservationRecord, 'scopeKey'>;
    readonly exclusions: readonly Omit<LocalSyncExclusionRecord, 'scopeKey'>[];
    readonly unbindNativeIds: readonly string[];
    readonly mountBindings?: readonly Omit<MountBindingRecord, 'scopeKey'>[];
  };
}

export async function applyRemoteDeletion(input: {
  store: Store; scope: SyncScope; event: Event; eventId: string;
  mounts: readonly MountBindingRecord[]; api: PullBookmarkApi; now: number;
  requireMapping: (id: string, role: 'deletion') => Promise<MappingInput>;
  crash?: (boundary: string) => void;
  parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) =>
    Promise<MappingInput>;
}): Promise<RemoteDeletionApply> {
  const { event, mounts, api, store, scope } = input;
  const effect = event.effect;
  if (effect.kind !== 'node_deleted' && effect.kind !== 'subtree_deleted') throw new SyncFailureError('pull_effect_kind_invalid');
  const ids = remoteDeleteMemberIds(event);
  // Missing members have no proven native identity; process their mapped
  // siblings without inventing a native target from a remote id.
  const mappings = await Promise.all(ids.map(async (id): Promise<MappingInput> =>
    await currentPullMapping(store, scope, id) ?? { colpId: id, nativeId: unmountedNativeId(id),
      rootNativeId: unmountedNativeId(id),
      ...(id === (effect.kind === 'node_deleted' ? effect.tombstone.targetId : effect.rootTombstone.targetId)
        ? { parentColpId: effect.parentRevision.parentId } : {}),
      projection: { revision: 'deleted', digest: effect.effectDigest } }));
  const rootId = effect.kind === 'node_deleted' ? effect.tombstone.targetId : effect.rootTombstone.targetId;
  const root = mappings.find((row) => row.colpId === rootId);
  if (!root) throw new SyncFailureError('mapping_missing:subtree_root');
  if (!isNonChromeNativeId(root.nativeId) && await withinPrivateNativeBoundary({ store, scope, mapping: root,
    privateRoots: (await store.getScope(scope))?.privateRoots ?? [], lookup: id => lookupBookmark(native => api.get(native), id) })) {
    const revision = effect.kind === 'node_deleted' ? effect.tombstone.deleteRevision : effect.rootTombstone.deleteRevision;
    return { deleteNativeIds: [],
      observations: mappings.map(row => ({ colpId: row.colpId, remoteRevision: revision, cursor: event.cursor,
        kind: 'tombstone' as const, payload: { deleted: true }, sourceDigest: effect.effectDigest, observedAt: input.now })),
      mappings: [await input.parentRevisionMapping(effect.parentRevision)],
    };
  }
  const writable = mappings.some(row => !isNonChromeNativeId(row.nativeId) && mayMutateNative(row, mounts));
  const decision = await store.getRemoteDeleteDecision(scope, remoteDeleteDecisionId(input.eventId));
  if (writable && event.operation.replicaId !== scope.replicaId
      && (await store.getRemoteDeletePolicy(scope)).policy !== 'sync') {
    if (decision?.state !== 'applying') {
      recordKns09Stop('unconfirmedDelete', scope); throw new SyncFailureError('remote_delete_confirmation_required');
    }
  }
  const members: DeleteMember[] = mappings.map((row) => ({ colpId: row.colpId, nativeId: row.nativeId }));
  const outcome = await executeRemoteDeleteMembers({
    store, scope, api, mounts, intentId: `intent:${input.eventId}`, members, mappings, writable,
    ...(decision?.state === 'applying' ? { confirmedDecision: decision } : {}),
    ...(decision?.state === 'applying' ? {} : {
      retainLocalWork: (mapping: MappingInput, native: { readonly title?: string; readonly url?: string }) =>
        hasUnsettledDeleteEdits(store, scope, mapping, native),
    }),
    crash: input.crash,
  });
  const revision = effect.kind === 'node_deleted'
    ? effect.tombstone.deleteRevision : effect.rootTombstone.deleteRevision;
  const observations: Omit<RemoteObservationRecord, 'scopeKey'>[] = mappings.map((row) => ({
    colpId: row.colpId, remoteRevision: revision, cursor: event.cursor, kind: 'tombstone',
    payload: { deleted: true }, sourceDigest: effect.effectDigest, observedAt: input.now,
    ...pauseBindingForMapping(row, mounts),
  }));
  const deletedSet = new Set(outcome.deletedNativeIds);
  const retainedRoots = [...new Set([...outcome.retainedNativeIds, ...outcome.protectedNativeIds])];
  const retainedRange = retainedRoots.length
    ? await collectRetainedNativeIds(api, retainedRoots, deletedSet) : [];
  const deleteColp = new Set(ids);
  await retainUnmappedAncestors(input, retainedRange, deleteColp);
  const retainedBoundary = mappings.find(row => !isNonChromeNativeId(row.nativeId))?.rootNativeId ?? root.rootNativeId;
  const exclusions: Omit<LocalSyncExclusionRecord, 'scopeKey'>[] = [];
  const unbindNativeIds: string[] = [];
  const virtualMappings: MappingInput[] = [];
  const decisionId = remoteDeleteDecisionId(input.eventId);
  for (const nativeId of retainedRange) {
    const mapping = await store.getMappingByNativeId(scope, nativeId)
      ?? mappings.find((row) => row.nativeId === nativeId);
    if (mapping && !deleteColp.has(mapping.colpId)) continue;
    exclusions.push({
      nativeId, decisionId, rootNativeId: mapping?.rootNativeId ?? retainedBoundary,
      generation: scope.generation, sourceKind: 'remote_delete',
      ...(mapping ? { priorColpId: mapping.colpId } : {}),
    });
    if (mapping && deleteColp.has(mapping.colpId) && !isNonChromeNativeId(mapping.nativeId)) {
      unbindNativeIds.push(mapping.nativeId);
      virtualMappings.push(virtualTombstoneMapping(mapping));
    }
  }
  for (const row of mappings) {
    if (!outcome.protectedNativeIds.includes(row.nativeId) && !outcome.retainedNativeIds.includes(row.nativeId)) {
      continue;
    }
    if (unbindNativeIds.includes(row.nativeId)) continue;
    if (isNonChromeNativeId(row.nativeId)) continue;
    unbindNativeIds.push(row.nativeId);
    virtualMappings.push(virtualTombstoneMapping(row));
    if (!exclusions.some((item) => item.nativeId === row.nativeId)) {
      exclusions.push({
        nativeId: row.nativeId, decisionId, rootNativeId: row.rootNativeId,
        generation: scope.generation, sourceKind: 'remote_delete', priorColpId: row.colpId,
      });
    }
  }
  const parentRevision = await parentRevisionFor(input, effect.parentRevision, unbindNativeIds);
  const mountBindings = tombstonedMountBindings(scope, mounts, mappings, outcome.protectedNativeIds, event.cursor);
  const deleteNativeIds = outcome.deletedNativeIds.filter((nativeId) => !unbindNativeIds.includes(nativeId)
    && !isProtectedNativeRoot(nativeId, mounts));
  const observation = observations[0];
  const rangeExit = observation && (exclusions.length || unbindNativeIds.length || mountBindings.length)
    ? {
      observation, exclusions, unbindNativeIds,
      ...(mountBindings.length ? { mountBindings } : {}),
    } : undefined;
  return { observations, deleteNativeIds, mappings: [...virtualMappings, parentRevision], rangeExit };
}

function virtualTombstoneMapping(row: MappingInput): MappingInput {
  const { scopeKey: _scopeKey, parentNativeId: _parentNativeId, ...rest } =
    row as MappingInput & { readonly scopeKey?: string };
  return {
    ...rest, nativeId: unmountedNativeId(row.colpId),
    ...(row.parentColpId ? { parentNativeId: unmountedNativeId(row.parentColpId) } : {}),
  };
}

async function parentRevisionFor(input: {
  parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) =>
    Promise<MappingInput>;
}, revision: { readonly parentId: string; readonly childrenRevision: string },
  unbindNativeIds: readonly string[]): Promise<MappingInput> {
  const parent = await input.parentRevisionMapping(revision);
  if (!unbindNativeIds.includes(parent.nativeId)) return parent;
  return { ...virtualTombstoneMapping(parent), projection: { ...parent.projection,
    childrenRevision: revision.childrenRevision } };
}

function tombstonedMountBindings(scope: SyncScope, mounts: readonly MountBindingRecord[],
  mappings: readonly MappingInput[], protectedNativeIds: readonly string[], cursor: string):
  Omit<MountBindingRecord, 'scopeKey'>[] {
  if (!protectedNativeIds.length) return [];
  const tombstoned = new Set(mappings.filter((row) => protectedNativeIds.includes(row.nativeId)).map((row) => row.colpId));
  const updates: Omit<MountBindingRecord, 'scopeKey'>[] = [];
  for (const mount of mounts) {
    if (mount.status !== 'active' || !mount.remoteMountNodeId || !tombstoned.has(mount.remoteMountNodeId)) continue;
    const { scopeKey: _scopeKey, ...binding } = mount as MountBindingRecord & { readonly scopeKey?: string };
    updates.push({
      ...binding, status: 'detached',
      pauseBaseline: {
        generation: scope.generation, boundaryVersion: mount.boundaryVersion,
        lastAppliedCursor: cursor, completeness: 'complete',
      },
    });
  }
  return updates;
}

/** A missing remote-root mapping must not leave retained native ancestors uploadable again. */
async function retainUnmappedAncestors(input: { store: Store; scope: SyncScope; api: PullBookmarkApi;
  mounts: readonly MountBindingRecord[] }, retained: string[], deletedColpIds: ReadonlySet<string>) {
  const included = new Set(retained);
  for (const nativeId of [...retained]) {
    let current = nativeId; const seen = new Set<string>();
    while (!seen.has(current) && seen.size < 256) {
      seen.add(current);
      const looked = await lookupBookmark(id => input.api.get(id), current);
      if (looked.class === 'not_found') break;
      if (looked.class !== 'present') throw new Error(looked.message);
      const parent = looked.nodes[0]?.parentId;
      if (!parent || isProtectedNativeRoot(parent, input.mounts)) break;
      const mapping = await input.store.getMappingByNativeId(input.scope, parent);
      if (mapping && !deletedColpIds.has(mapping.colpId)) break;
      if (!included.has(parent)) { included.add(parent); retained.push(parent); }
      current = parent;
    }
  }
}

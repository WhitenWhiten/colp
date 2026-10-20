import { captureRejoinParents, createRejoinQueue } from './scope-rejoin-parents.js';
import { reconcileRejoinOrders } from './scope-rejoin-order.js';
import { digestJson } from './bookmark-event-codec.js';
import { queueRejoinOperation } from './scope-rejoin-queue.js';
import { protectedRejoinDeletions, rejoinPlacement } from './scope-rejoin-placement.js';
import { materializeUnmountedRejoinMembers, rejoinMemberMappings } from './scope-rejoin-materialize.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { applyRejoinMutation, type RejoinChrome, type RejoinNative } from './scope-rejoin-mutation.js';
import { compareRejoinFacts } from './scope-transition.js';
import { observationValidForPause } from './sync-state/remote-observation.js';
import type { JsonObject, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

export async function applyRejoinObservations(input: {
  readonly store: Store; readonly scope: SyncScope; readonly mount: MountBindingRecord;
} & RejoinChrome): Promise<{ readonly applied: number; readonly unknown: number; readonly conflicts: number }> {
  const { store, scope, mount } = input;
  const commandId = `rejoin:${mount.mountId}`;
  const plan = { commandId, kind: 'rejoin' as const, confirmationVersion: mount.boundaryVersion,
    baselineDigest: mount.pauseBaseline?.lastAppliedCursor ?? null, dependencies: [], mountId: mount.mountId };
  await store.beginScopeCommandPlan(scope, { ...plan, phase: 'comparing', updatedAt: Date.now() });
  let all = await store.listMappings(scope);
  await captureRejoinParents(input, rejoinMemberMappings(all, mount));
  all = await store.listMappings(scope);
  const materialized = await materializeUnmountedRejoinMembers(input, all);
  all = await store.listMappings(scope);
  const mappings = rejoinMemberMappings(all, mount);
  const observations = new Map((await store.listRemoteObservations(scope))
    .filter(row => observationValidForPause(row, mount.pauseBaseline)).map(row => [row.colpId, row]));
  const protectedDeletions = await protectedRejoinDeletions(input, mappings);
  const liveQueue = new Set(['pending', 'claimed', 'deferred', 'unknown', 'gap', 'blocked', 'set_aside']);
  const pendingTargets = new Set((await store.listQueue(scope)).flatMap((row) =>
    liveQueue.has(row.status) && typeof row.payload.targetId === 'string' ? [row.payload.targetId] : []));
  const optimistic = (mapping: MappingInput) => mapping.projection.revision.startsWith('local-')
    || pendingTargets.has(mapping.colpId);
  const byNative = new Map(mappings.map((row) => [row.nativeId, row]));
  for (const mapping of mappings) {
    if (!optimistic(mapping)) continue;
    let current: MappingInput | undefined = mapping;
    const seen = new Set<string>();
    while (current && !seen.has(current.nativeId)) {
      seen.add(current.nativeId);
      protectedDeletions.add(current.nativeId);
      current = current.parentNativeId ? byNative.get(current.parentNativeId) : undefined;
    }
  }
  const baselineKnown = mount.pauseBaseline?.completeness === 'complete' && mount.pauseBaseline.generation === scope.generation;
  let applied = materialized.applied; let unknown = materialized.unknown;
  let conflicts = baselineKnown ? await reconcileRejoinOrders(input, mappings, [...observations.values()]) : 0;
  const considered: string[] = [];
  if (!baselineKnown) unknown++;
  if (baselineKnown) for (const mapping of mappings) {
    if (mapping.nativeId === mount.nativeRootId || mapping.nativeId.startsWith('sidecar:')) continue;
    considered.push(mapping.colpId);
    if (isNonChromeNativeId(mapping.nativeId) || mapping.colpId.startsWith('pending-')) { unknown++; continue; }
    // A local-* revision or a live outbound op is not an authoritative pause baseline.
    if (optimistic(mapping)) { unknown++; continue; }
    const observation = observations.get(mapping.colpId);
    const native = await input.getNative(mapping.nativeId);
    const baseline = contentOf(mapping.projection.content, mapping.nodeKind);
    const local = native ? contentOf(native, mapping.nodeKind) : null;
    const remote = { ...baseline, ...contentOf(observation?.payload, mapping.nodeKind, true) };
    const localEdited = local !== null && digestJson(local) !== digestJson(baseline);
    const remoteDeleted = observation?.kind === 'tombstone';
    const keys = Object.keys(baseline);
    const sameFieldFork = !!local && keys.some(key =>
      local[key] !== baseline[key] && remote[key] !== baseline[key] && local[key] !== remote[key]);
    const bothChangedDistinctFields = !!local
      && keys.some(key => local[key] !== baseline[key] && remote[key] === baseline[key])
      && keys.some(key => remote[key] !== baseline[key] && local[key] === baseline[key]);
    const remoteParent = typeof observation?.payload.parentId === 'string' ? observation.payload.parentId : mapping.parentColpId;
    const parent = all.find(row => row.colpId === remoteParent);
    const localMoved = native?.parentId !== undefined && native.parentId !== mapping.parentNativeId;
    const remoteMoved = remoteParent !== mapping.parentColpId;
    const outcome = compareRejoinFacts({
      baselineKnown, localEqualsBaseline: local !== null && digestJson(local) === digestJson(baseline),
      remoteEqualsBaseline: digestJson(remote) === digestJson(baseline),
      sameFieldFork: sameFieldFork || localMoved && remoteMoved && native?.parentId !== parent?.nativeId,
      bothChangedDistinctFields, remoteDeleted, localEdited,
    });
    if (outcome === 'baseline_unknown') { unknown++; continue; }
    if (outcome === 'conflict') { conflicts++; continue; }
    if (outcome === 'retain_local_edit' || outcome === 'apply_delete_policy') {
      const policy = (await store.getRemoteDeletePolicy(scope)).policy;
      if (localEdited || protectedDeletions.has(mapping.nativeId) || policy === 'confirm') { conflicts++; continue; }
      if (policy === 'keep_local') {
        await store.putLocalSyncExclusion(scope, { nativeId: mapping.nativeId, decisionId: commandId,
          rootNativeId: mount.nativeRootId, generation: scope.generation, priorColpId: mapping.colpId });
      } else if (native) {
        if (!input.removeNative) { unknown++; continue; }
        await applyRejoinMutation(input, mapping, 'remove', {}, native);
      }
      await store.deleteMapping(scope, mapping.nativeId); applied++; continue;
    }
    if (!local || !native) { unknown++; continue; }
    const merged = { ...remote };
    for (const key of keys) if (local[key] !== baseline[key]) merged[key] = local[key]!;
    const landed = outcome === 'apply_remote' ? remote : outcome === 'typed_merge' ? merged : local;
    if (remoteMoved && (!parent || isNonChromeNativeId(parent.nativeId) || !input.moveNative)) { unknown++; continue; }
    const localPlacement = localMoved && !remoteMoved
      ? await rejoinPlacement(input, mapping, native, all) : undefined;
    if (localMoved && !remoteMoved && !localPlacement) { unknown++; continue; }
    if ((outcome === 'apply_remote' || outcome === 'typed_merge') && digestJson(local) !== digestJson(landed)) {
      if (!input.updateNative) { unknown++; continue; }
      await applyRejoinMutation(input, mapping, 'change', landed, native);
    }
    if (remoteMoved && native.parentId !== parent!.nativeId) {
      await applyRejoinMutation(input, mapping, 'move',
        { parentId: parent!.nativeId, index: await destIndex(input, parent!.nativeId, native, observation?.payload, all) },
        native);
    }
    const revision = outcome === 'queue_local_at_baseline_revision'
      ? mapping.projection.revision : observation?.remoteRevision ?? mapping.projection.revision;
    if ((outcome === 'typed_merge' || outcome === 'queue_local_at_baseline_revision')
        && digestJson(landed) !== digestJson(remote)) {
      await queueRejoinOperation(store, scope, mapping, revision, 'update_node_content', { base: remote, value: landed });
    }
    if (localPlacement) await queueRejoinOperation(store, scope, mapping, revision, 'move_node', localPlacement);
    const after = await input.getNative(mapping.nativeId) ?? native;
    const chromeContent = contentOf(after, mapping.nodeKind);
    const { scopeKey: _key, ...rest } = mapping as MappingInput & { scopeKey?: string };
    const parentChanged = after.parentId !== undefined && after.parentId !== mapping.parentNativeId;
    const chromeParent = parentChanged ? all.find(row => row.nativeId === after.parentId) : undefined;
    const order = (await store.getMappingByNativeId(scope, mapping.nativeId))?.projection.childrenOrder;
    await store.putMapping(scope, { ...rest,
      ...(parentChanged ? { parentNativeId: after.parentId,
        ...(chromeParent ? { parentColpId: chromeParent.colpId } : {}) } : {}),
      projection: { ...mapping.projection, ...(order ? { childrenOrder: order } : {}), revision, resourceRevision: revision,
        content: { ...(mapping.projection.content ?? {}), ...chromeContent }, digest: digestJson(chromeContent) } });
    applied++;
  }
  if (!unknown && !conflicts && input.getChildren) {
    const queue = createRejoinQueue(input);
    for (const parent of mappings) if (parent.nodeKind === 'folder' && !isNonChromeNativeId(parent.nativeId)
      && await input.getNative(parent.nativeId)) await queue.reconcileOrder(parent.nativeId);
    await queue.flush();
  }
  await store.putScopeCommandPlan(scope, { ...plan, phase: unknown || conflicts ? 'pending' : 'active', updatedAt: Date.now() });
  if (!unknown && !conflicts && considered.length) await store.deleteRemoteObservations(scope, considered);
  return { applied, unknown, conflicts };
}

async function destIndex(input: RejoinChrome, destNativeId: string, native: RejoinNative,
  payload: JsonObject | undefined, all: readonly MappingInput[]): Promise<number> {
  if (native.parentId === destNativeId) return native.index ?? 0;
  const children = input.getChildren ? await input.getChildren(destNativeId) : undefined;
  const afterId = typeof payload?.afterId === 'string' ? payload.afterId : undefined;
  const after = afterId ? all.find(row => row.colpId === afterId) : undefined;
  if (after && children) {
    const index = children.findIndex(row => row.id === after.nativeId);
    if (index >= 0) return index + 1;
  }
  return children?.length ?? 0;
}

function contentOf(value: unknown, kind: MappingInput['nodeKind'], partial = false): JsonObject {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { ...(typeof row.title === 'string' ? { title: row.title } : partial ? {} : { title: '' }),
    ...(kind === 'bookmark' ? typeof row.url === 'string' ? { url: row.url } : partial ? {} : { url: '' } : {}) };
}

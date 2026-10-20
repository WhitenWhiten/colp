import { cachedRejoinAuthority, rejoinAttemptDigest, rejoinBoundaryDigest } from './scope-rejoin-authority.js';
import { assertRejoinBoundary } from './scope-rejoin-boundary.js';
import { currentRejoinDependencies } from './scope-rejoin-decisions.js';
import { remoteRejoinDeleteCandidate, stageRemoteRejoinDelete } from './scope-rejoin-remote-delete.js';
import { reconcileMissingRejoinDeletes } from './scope-rejoin-deletion.js';
import { captureRejoinParents, createRejoinQueue } from './scope-rejoin-parents.js';
import { reconcileRejoinOrders } from './scope-rejoin-order.js';
import { digestJson } from './bookmark-event-codec.js';
import { queueRejoinOperation } from './scope-rejoin-queue.js';
import { protectedRejoinDeletions, rejoinDeletionMembers, rejoinPlacement, removeRejoinDeletionMembers } from './scope-rejoin-placement.js';
import { materializeUnmountedRejoinMembers, rejoinMemberMappings } from './scope-rejoin-materialize.js';
import { parentFirst } from './scope-rejoin-members.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { applyRejoinMutation, rejoinMutationAuthority, rejoinNativeDigest, type RejoinChrome, type RejoinNative } from './scope-rejoin-mutation.js';
import { compareRejoinFacts } from './scope-transition.js';
import { observationValidForPause } from './sync-state/remote-observation.js';
import { isSettledRejection } from './sync-state/open-issue-facts.js';
import type { JsonObject, MappingInput, MountBindingRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

export async function applyRejoinObservations(input: {
  readonly store: Store; readonly scope: SyncScope; readonly mount: MountBindingRecord;
} & RejoinChrome): Promise<{ readonly applied: number; readonly unknown: number; readonly conflicts: number }> {
  input = cachedRejoinAuthority(input);
  const { store, scope, mount } = input;
  input = { ...input, expectedRejoinBoundary: rejoinBoundaryDigest(await store.getScope(scope)) };
  const commandId = `rejoin:${mount.mountId}`;
  const plan = { commandId, kind: 'rejoin' as const, confirmationVersion: mount.boundaryVersion,
    baselineDigest: rejoinAttemptDigest(mount, await store.getScope(scope)), dependencies: [] as string[], mountId: mount.mountId };
  const prior = await store.getScopeCommandPlan(scope, commandId);
  if (!prior || prior.baselineDigest !== plan.baselineDigest) {
    await store.putScopeCommandPlan(scope, { ...plan, phase: 'comparing', updatedAt: Date.now() });
  }
  const root = await store.getMappingByNativeId(scope, mount.nativeRootId);
  if (!root || root.colpId !== mount.remoteMountNodeId) return { applied: 0, unknown: 1, conflicts: 0 };
  if (!await input.getNative(root.nativeId)) return { applied: 0, unknown: 1, conflicts: 0 };
  await assertRejoinBoundary(input, root);
  const outstanding = (await currentRejoinDependencies(input)).filter(row => row.phase !== 'active' && row.phase !== 'pending');
  if (outstanding.length) return { applied: 0, unknown: 0, conflicts: outstanding.length };
  let all = await store.listMappings(scope);
  await captureRejoinParents(input, rejoinMemberMappings(all, mount));
  all = await store.listMappings(scope);
  const materialized = await materializeUnmountedRejoinMembers(input, all);
  all = await store.listMappings(scope);
  let mappings = rejoinMemberMappings(all, mount);
  const observations = new Map((await store.listRemoteObservations(scope))
    .filter(row => observationValidForPause(row, mount.pauseBaseline)).map(row => [row.colpId, row]));
  const baselineKnown = mount.pauseBaseline?.completeness === 'complete' && mount.pauseBaseline.generation === scope.generation;
  let applied = materialized.applied; let unknown = materialized.unknown;
  const deletions = baselineKnown ? await reconcileMissingRejoinDeletes(input, mappings, [...observations.values()])
    : { applied: 0, conflicts: 0, handled: new Set<string>() };
  applied += deletions.applied;
  let conflicts = deletions.conflicts + (baselineKnown ? await reconcileRejoinOrders(input, mappings, [...observations.values()]) : 0);
  // This comparison's own order application may have advanced folder projections.
  all = await store.listMappings(scope); mappings = rejoinMemberMappings(all, mount);
  const protection = await protectedRejoinDeletions(input, mappings), protectedDeletions = protection.protectedIds;
  const pendingTargets = await unsettledRejoinTargets(store, scope);
  const optimistic = (mapping: MappingInput) => mapping.projection.revision.startsWith('local-')
    || pendingTargets.has(mapping.colpId);
  const byNative = new Map(mappings.map((row) => [row.nativeId, row]));
  for (const mapping of mappings) if (optimistic(mapping)) protectedDeletions.add(mapping.nativeId);
  for (const id of protectedDeletions) {
    const parent = byNative.get(id)?.parentNativeId;
    if (parent && byNative.has(parent)) protectedDeletions.add(parent);
  }
  let deletionChanged = false;
  const considered: string[] = [];
  const removedNativeIds = new Set<string>();
  const reviewedNativeIds = new Set<string>();
  if (!baselineKnown) unknown++;
  if (baselineKnown) for (const mapping of parentFirst(mappings, mount.remoteMountNodeId)) {
    if (mapping.nativeId === mount.nativeRootId || mapping.nativeId.startsWith('sidecar:')
      || removedNativeIds.has(mapping.nativeId) || reviewedNativeIds.has(mapping.nativeId)) continue;
    considered.push(mapping.colpId);
    if (isNonChromeNativeId(mapping.nativeId) || mapping.colpId.startsWith('pending-')) { unknown++; continue; }
    // A local-* revision or a live outbound op is not an authoritative pause baseline.
    const observation = observations.get(mapping.colpId);
    if (optimistic(mapping) && observation?.kind !== 'tombstone') { unknown++; continue; }
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
      if (optimistic(mapping) || localEdited || protectedDeletions.has(mapping.nativeId) || policy === 'confirm') {
        const candidate = await remoteRejoinDeleteCandidate(input, mapping);
        await stageRemoteRejoinDelete(input, candidate);
        for (const member of candidate.evidence.members) reviewedNativeIds.add(member.nativeId);
        conflicts++; continue;
      }
      if (policy === 'keep_local') {
        await store.putLocalSyncExclusion(scope, { nativeId: mapping.nativeId, decisionId: commandId,
          rootNativeId: mount.nativeRootId, generation: scope.generation, priorColpId: mapping.colpId });
      } else {
        if (native && !input.removeNative) { unknown++; continue; }
        try {
          const members = rejoinDeletionMembers(protection.evidence, mapping.nativeId);
          // A descendant may have moved out remotely before its former
          // ancestor was deleted. Each frozen native identity needs its own
          // tombstone before the family is eligible for automatic deletion.
          if (members.some(row => observations.get(row.colpId)?.kind !== 'tombstone')
            || !native && members.some(row => protection.evidence.facts.get(row.nativeId)?.native)) {
            conflicts++; continue;
          }
          await removeRejoinDeletionMembers(input, protection.evidence, members);
          for (const removed of members) {
            removedNativeIds.add(removed.nativeId); considered.push(removed.colpId);
          }
          applied++; continue;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'rejoin_boundary_changed') throw error;
          deletionChanged = true; conflicts++; break;
        }
      }
      await store.commitRejoinProjection(scope, await rejoinMutationAuthority(input, mapping), null);
      applied++; continue;
    }
    if (!local || !native) { if (!deletions.handled.has(mapping.colpId)) unknown++; continue; }
    const merged = { ...remote };
    for (const key of keys) if (local[key] !== baseline[key]) merged[key] = local[key]!;
    const landed = outcome === 'apply_remote' ? remote : outcome === 'typed_merge' ? merged : local;
    if (remoteMoved && (!parent || isNonChromeNativeId(parent.nativeId) || !input.moveNative)) { unknown++; continue; }
    const localPlacement = localMoved && !remoteMoved
      ? await rejoinPlacement(input, mapping, native, all) : undefined;
    if (localMoved && !remoteMoved && !localPlacement) { unknown++; continue; }
    const projectionAuthority = await rejoinMutationAuthority(input, mapping, remoteMoved ? parent!.nativeId : undefined);
    let expectedNative = native;
    if ((outcome === 'apply_remote' || outcome === 'typed_merge') && digestJson(local) !== digestJson(landed)) {
      if (!input.updateNative) { unknown++; continue; }
      await applyRejoinMutation(input, mapping, 'change', landed, native);
      expectedNative = { ...native, ...landed };
    }
    if (remoteMoved && native.parentId !== parent!.nativeId) {
      const placement = { parentId: parent!.nativeId, index: await destIndex(input, parent!.nativeId, native, observation?.payload, all) };
      await applyRejoinMutation(input, mapping, 'move', placement, expectedNative);
      expectedNative = { ...expectedNative, ...placement };
    }
    const revision = outcome === 'queue_local_at_baseline_revision'
      ? mapping.projection.revision : observation?.remoteRevision ?? mapping.projection.revision;
    if ((outcome === 'typed_merge' || outcome === 'queue_local_at_baseline_revision')
        && digestJson(landed) !== digestJson(remote)) {
      await queueRejoinOperation(store, scope, mapping, revision, 'update_node_content', { base: remote, value: landed });
    }
    if (localPlacement) await queueRejoinOperation(store, scope, mapping, revision, 'move_node', localPlacement);
    const after = await input.getNative(mapping.nativeId);
    if (!after || rejoinNativeDigest(after) !== rejoinNativeDigest(expectedNative)) throw new Error('rejoin_boundary_changed');
    const chromeContent = contentOf(after, mapping.nodeKind);
    const { scopeKey: _key, ...rest } = mapping as MappingInput & { scopeKey?: string };
    const parentChanged = after.parentId !== undefined && after.parentId !== mapping.parentNativeId;
    const chromeParent = parentChanged ? all.find(row => row.nativeId === after.parentId) : undefined;
    const order = (await store.getMappingByNativeId(scope, mapping.nativeId))?.projection.childrenOrder;
    await store.commitRejoinProjection(scope, projectionAuthority, { ...rest,
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
  const decisions = await currentRejoinDependencies(input);
  plan.dependencies = decisions.map(row => row.commandId);
  if (decisions.some(row => row.phase !== 'active')) conflicts = Math.max(conflicts, 1);
  // Comparison is durable before activation. The caller commits this journal
  // and the mount together; a worker restart must still see unfinished work.
  await store.putScopeCommandPlan(scope, { ...plan, phase: unknown || conflicts ? 'pending' : 'applying',
    ...(deletionChanged ? { retryReason: 'rejoin_boundary_changed' } : {}), updatedAt: Date.now() });
  if (!unknown && !conflicts && considered.length) await store.deleteRemoteObservations(scope, considered);
  return { applied, unknown, conflicts };
}

/** A canonical-looking projection may still contain an edit queued by an earlier rejoin. */
async function unsettledRejoinTargets(store: Store, scope: SyncScope): Promise<Set<string>> {
  const targets = new Set<string>();
  for (let after = 0;;) {
    const page = await store.listQueue(scope, undefined, after, 1_000);
    // Resolution receipts alter protection only; authored bytes and rejected
    // receipts remain immutable history and must not hold a completed choice.
    for (const row of await store.filterResolvedQueueIssues(scope, page)) {
      if (row.echoApplied || isSettledRejection(row) || typeof row.payload.targetId !== 'string') continue;
      if (row.status === 'terminal') {
        const receipt = await store.getQueueReceipt(scope, row.sequence);
        const results = receipt?.result?.results;
        const result = Array.isArray(results) ? results.find(value =>
          value && typeof value === 'object' && !Array.isArray(value) && value.opId === row.opId) : undefined;
        // A terminal sequence alone says nothing about whether an authored
        // edit succeeded. Refusals and conflicts still own their local intent.
        if (result && typeof result === 'object' && !Array.isArray(result)
          && ['applied', 'rebased', 'noop'].includes(String(result.status))) continue;
      }
      targets.add(row.payload.targetId);
    }
    if (page.length < 1_000) return targets;
    after = page.at(-1)!.sequence;
  }
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

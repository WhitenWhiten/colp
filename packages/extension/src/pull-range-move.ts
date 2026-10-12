import type { SyncPullEventV02 } from '@know-n/colp/types';
import { lookupBookmarkChildren, type BookmarkNode } from './bookmark-api-error.js';
import { digest } from './pull-codec.js';
import { mappingFor } from './pull-projection.js';
import { classifyMountActivity, decideRangeTransition, isWritableActiveScope } from './scope-transition.js';
import { unmountedNativeId, isNonChromeNativeId } from './pull-mount-apply.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type {
  JsonObject, MappingInput, MountBindingRecord, RangeTransitionAction, RemoteObservationRecord,
  ScopeCommandPlanRecord, SyncScope, createSyncStateStore,
} from './sync-state-store.js';
import type { LocalSyncExclusionRecord } from './sync-state/remote-delete-repository.js';
import { pauseBindingForMapping } from './sync-state/remote-observation.js';
import { materializeIndependentSubtree } from './pull-range-materialize.js';
import { buildIndependentPlan } from './pull-range-plan.js';

const FROZEN_RANGE_ACTIONS: ReadonlySet<RangeTransitionAction> = new Set([
  'retain_local_copy', 'observe_only', 'await_dependency',
]);

type Store = ReturnType<typeof createSyncStateStore>;
type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;
type MoveEffect = Extract<OpEvent['effect'], { kind: 'node_moved' }>;

export interface RemoteMovePlan {
  readonly action: RangeTransitionAction;
  readonly chromeMutation: boolean;
  readonly persistObservation: boolean;
  readonly persistExclusion: boolean;
  readonly sourceBoundaryVersion: string | null;
  readonly destBoundaryVersion: string | null;
  readonly sourceGeneration: number;
  readonly destGeneration: number;
  readonly commandId: string;
}

export interface RemoteMovePlanFacts {
  readonly generation: number;
  readonly permissionConfirmed: boolean;
  readonly pendingLocalOperations?: boolean;
}

export interface PlannedMoveApply {
  readonly mappings: MappingInput[];
  readonly deleteNativeIds: readonly string[];
  readonly rangeExit?: {
    readonly observation: Omit<RemoteObservationRecord, 'scopeKey'>;
    readonly exclusion?: Omit<LocalSyncExclusionRecord, 'scopeKey'>;
    readonly exclusions?: readonly Omit<LocalSyncExclusionRecord, 'scopeKey'>[];
    readonly command?: Omit<ScopeCommandPlanRecord, 'scopeKey'>;
    readonly unbindNativeIds?: readonly string[];
    readonly mountBindings?: readonly Omit<MountBindingRecord, 'scopeKey'>[];
  };
  readonly createdNativeId?: string;
  readonly observations?: readonly Omit<RemoteObservationRecord, 'scopeKey'>[];
}

export function mappingMountActivity(mapping: MappingInput, mounts: readonly MountBindingRecord[]) {
  const mount = mountFor(mapping, mounts);
  if (!mount) return mounts.length === 0 ? classifyMountActivity({ status: 'active' })
    : classifyMountActivity({ present: false });
  return classifyMountActivity({
    status: mount.status,
    identityKnown: mount.remoteMountNodeId !== null,
    rejoinInFlight: mount.status === 'pending',
  });
}

export function planRemoteMove(input: {
  readonly event: OpEvent; readonly mapping: MappingInput; readonly parent: MappingInput;
  readonly mounts: readonly MountBindingRecord[]; readonly pendingLocalOperations: boolean;
  readonly generation: number; readonly permissionConfirmed: boolean;
}): RemoteMovePlan {
  const source = mountFor(input.mapping, input.mounts);
  const dest = mountFor(input.parent, input.mounts);
  const destKind = mappingMountActivity(input.parent, input.mounts);
  const destWritable = dest ? isWritableActiveScope({
    status: dest.status, identityKnown: dest.remoteMountNodeId !== null, rejoinInFlight: dest.status === 'pending',
  }) : destKind === 'active';
  const destObservation = destKind === 'detached' || destKind === 'unmounted' || destKind === 'private_local';
  const sidecar = input.mapping.nativeId.startsWith('sidecar:');
  const decision = decideRangeTransition({
    source: {
      kind: isNonChromeNativeId(input.mapping.nativeId) ? 'unmounted' : mappingMountActivity(input.mapping, input.mounts),
      generation: source?.pauseBaseline?.generation ?? input.generation,
    },
    destination: { kind: destKind, generation: dest?.pauseBaseline?.generation ?? input.generation },
    identityConfirmed: input.parent.nativeId.length > 0 && !isNonChromeNativeId(input.parent.nativeId),
    ancestorConfirmed: destWritable || destObservation,
    permissionConfirmed: input.permissionConfirmed,
    pendingLocalOperations: input.pendingLocalOperations,
  });
  return {
    action: sidecar ? 'observe_only' : decision.action,
    chromeMutation: !sidecar && decision.chromeMutation,
    persistObservation: decision.persistObservation, persistExclusion: decision.persistExclusion,
    sourceBoundaryVersion: source?.boundaryVersion ?? null, destBoundaryVersion: dest?.boundaryVersion ?? null,
    sourceGeneration: source?.pauseBaseline?.generation ?? input.generation,
    destGeneration: dest?.pauseBaseline?.generation ?? input.generation,
    commandId: `rx:${input.event.operation.opId}`,
  };
}

export function rangeActionOf(anchors: JsonObject | undefined): RangeTransitionAction | undefined {
  const value = anchors?.rangeAction;
  return typeof value === 'string' ? value as RangeTransitionAction : undefined;
}

export function frozenRangeAction(action: RangeTransitionAction | undefined): boolean {
  return action !== undefined && FROZEN_RANGE_ACTIONS.has(action);
}

export function rangePlanFromAnchors(anchors: JsonObject | undefined, commandId: string): RemoteMovePlan | undefined {
  const action = rangeActionOf(anchors);
  if (!action || !anchors) return undefined;
  return {
    action, commandId,
    chromeMutation: anchors.chromeMutation === true,
    persistObservation: anchors.persistObservation === true,
    persistExclusion: anchors.persistExclusion === true,
    sourceBoundaryVersion: typeof anchors.sourceBoundaryVersion === 'string' ? anchors.sourceBoundaryVersion : null,
    destBoundaryVersion: typeof anchors.destBoundaryVersion === 'string' ? anchors.destBoundaryVersion : null,
    sourceGeneration: typeof anchors.sourceGeneration === 'number' ? anchors.sourceGeneration : 0,
    destGeneration: typeof anchors.destGeneration === 'number' ? anchors.destGeneration : 0,
  };
}

export function moveAnchors(plan: RemoteMovePlan, extra: JsonObject): JsonObject {
  return {
    ...extra, rangeAction: plan.action, chromeMutation: plan.chromeMutation,
    persistObservation: plan.persistObservation, persistExclusion: plan.persistExclusion,
    sourceGeneration: plan.sourceGeneration, destGeneration: plan.destGeneration,
    ...(plan.sourceBoundaryVersion ? { sourceBoundaryVersion: plan.sourceBoundaryVersion } : {}),
    ...(plan.destBoundaryVersion ? { destBoundaryVersion: plan.destBoundaryVersion } : {}),
  };
}

export function resolvePersistedMovePlan(persisted: RemoteMovePlan | undefined, current: RemoteMovePlan): RemoteMovePlan {
  if (!persisted) return current;
  if (!planDrifted(persisted, current)) return persisted;
  return frozenRangeAction(persisted.action) ? persisted : current;
}

export function boundaryDrifted(plan: RemoteMovePlan, mapping: MappingInput, parent: MappingInput,
  mounts: readonly MountBindingRecord[], facts: RemoteMovePlanFacts): boolean {
  return planDrifted(plan, planRemoteMove({
    event: { operation: { opId: plan.commandId.startsWith('rx:') ? plan.commandId.slice(3) : plan.commandId } } as OpEvent,
    mapping, parent, mounts, pendingLocalOperations: facts.pendingLocalOperations === true,
    generation: facts.generation, permissionConfirmed: facts.permissionConfirmed,
  }));
}

export async function applyPlannedMove(input: {
  readonly store: Store; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly event: OpEvent; readonly mapping: MappingInput; readonly parent: MappingInput;
  readonly plan: RemoteMovePlan; readonly now: number; readonly cursor: string;
  readonly eventId: string;
  readonly recoverCreated: () => Promise<import('./native-create-executor.js').NativeCreateOutcome>;
  readonly nativeIndex: (afterId: string | null, beforeId: string | null) => Promise<number>;
  readonly parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) =>
    Promise<MappingInput>;
  readonly crash?: (boundary: string) => void;
  readonly permissionGranted?: boolean;
}): Promise<PlannedMoveApply> {
  if (input.plan.action === 'await_dependency') throw new Error('range_dependency_pending');
  const effect = input.event.effect as MoveEffect;
  const revisions = await Promise.all(effect.parentRevisions.map(input.parentRevisionMapping));
  if (input.plan.action === 'native_move' && input.plan.chromeMutation) {
    await refuseDriftedChromeMove(input);
    await input.api.move(input.mapping.nativeId, {
      parentId: input.parent.nativeId,
      index: await input.nativeIndex(effect.placement.afterId, effect.placement.beforeId),
    });
    return {
      mappings: [mappingFor(effect.node, input.mapping.nativeId, input.parent.nativeId, input.parent.colpId,
        input.mapping.projection.childrenRevision ?? null, input.parent.rootNativeId), ...revisions],
      deleteNativeIds: [],
    };
  }
  const listed = await input.store.listMappings(input.scope);
  const verified = verifiedSubtree(input.mapping, listed);
  const { mapped: subtree, extras } = input.plan.persistExclusion
    ? await unionChromeSubtree({ api: input.api, store: input.store, scope: input.scope },
      input.mapping, listed, verified)
    : { mapped: verified, extras: [] as ChromeExtra[] };
  const deleteNativeIds = liveChromeNativeIds(subtree);
  const destRoot = unmountedNativeId(input.parent.colpId);
  const descendants = unmountedDescendantMappings(subtree, input.mapping, destRoot);
  const pause = input.plan.persistObservation
    ? pauseBindingForMapping(input.mapping, await input.store.listMountBindings(input.scope)) : {};
  if (input.plan.action === 'materialize_independent' && input.plan.chromeMutation) {
    await refuseDriftedChromeMove(input);
    const rangeExit = rangeExitFacts(input, effect, 'placement', subtree, extras, pause,
      buildIndependentPlan({
        mapping: input.mapping, parent: input.parent, subtree, plan: input.plan,
        mounts: await input.store.listMountBindings(input.scope),
      }).nodes.map((row) => row.colpId));
    const materialized = await materializeIndependentSubtree({
      store: input.store, scope: input.scope, api: input.api, event: input.event, eventId: input.eventId,
      mapping: input.mapping, parent: input.parent, plan: input.plan, subtree, now: input.now, cursor: input.cursor,
      recoverCreated: input.recoverCreated, parentRevisionMapping: input.parentRevisionMapping, pause,
      crash: input.crash, permissionGranted: input.permissionGranted,
    });
    return { ...materialized, rangeExit };
  }
  return {
    mappings: input.plan.persistExclusion || isNonChromeNativeId(input.mapping.nativeId)
      ? [mappingFor(effect.node, input.mapping.nativeId.startsWith('sidecar:')
        ? input.mapping.nativeId : unmountedNativeId(effect.node.id), input.parent.nativeId, input.parent.colpId,
        input.mapping.projection.childrenRevision ?? null, destRoot),
        ...(input.plan.persistExclusion ? descendants : []), ...revisions]
      : revisions,
    deleteNativeIds: input.plan.persistExclusion ? deleteNativeIds : [],
    rangeExit: input.plan.persistObservation ? rangeExitFacts(input, effect, 'placement', subtree, extras, pause) : undefined,
  };
}

function mountFor(mapping: MappingInput, mounts: readonly MountBindingRecord[]) {
  return mounts.find((item) => item.mountId === mapping.mountId || item.nativeRootId === mapping.rootNativeId);
}

function planDrifted(left: RemoteMovePlan, right: RemoteMovePlan): boolean {
  return left.action !== right.action || left.sourceBoundaryVersion !== right.sourceBoundaryVersion
    || left.destBoundaryVersion !== right.destBoundaryVersion
    || left.sourceGeneration !== right.sourceGeneration || left.destGeneration !== right.destGeneration;
}

async function refuseDriftedChromeMove(input: {
  readonly store: Store; readonly scope: SyncScope; readonly plan: RemoteMovePlan;
  readonly mapping: MappingInput; readonly parent: MappingInput;
}): Promise<void> {
  const mounts = await input.store.listMountBindings(input.scope);
  if (boundaryDrifted(input.plan, input.mapping, input.parent, mounts, {
    generation: input.scope.generation,
    permissionConfirmed: (await input.store.getScope(input.scope))?.rootStatus !== 'permission_required',
  })) throw new Error('range_dependency_pending');
}

function verifiedSubtree(root: MappingInput, mappings: readonly MappingInput[]): MappingInput[] {
  const byNative = new Map(mappings.map((row) => [row.nativeId, row]));
  const byColp = new Map(mappings.map((row) => [row.colpId, row]));
  return mappings.filter((candidate) => candidate.nativeId === root.nativeId
    || ancestorReaches(candidate, root, byNative, byColp));
}

function ancestorReaches(candidate: MappingInput, root: MappingInput,
  byNative: Map<string, MappingInput>, byColp: Map<string, MappingInput>): boolean {
  const seen = new Set<string>();
  let current: MappingInput | undefined = candidate;
  while (current) {
    if (current.nativeId === root.nativeId || current.colpId === root.colpId) return current !== candidate;
    if (seen.has(current.nativeId)) return false;
    seen.add(current.nativeId);
    current = (current.parentNativeId ? byNative.get(current.parentNativeId) : undefined)
      ?? (current.parentColpId ? byColp.get(current.parentColpId) : undefined);
  }
  return false;
}

type ChromeExtra = { readonly nativeId: string; readonly rootNativeId: string };

function liveChromeNativeIds(subtree: readonly MappingInput[]): string[] {
  return subtree.filter((row) => !isNonChromeNativeId(row.nativeId)).map((row) => row.nativeId);
}

async function unionChromeSubtree(context: {
  readonly api: PullBookmarkApi; readonly store: Store; readonly scope: SyncScope;
}, root: MappingInput, mappings: readonly MappingInput[], verified: readonly MappingInput[]): Promise<{
    mapped: MappingInput[]; extras: ChromeExtra[];
  }> {
  const mapped = [...verified];
  if (isNonChromeNativeId(root.nativeId)) return { mapped, extras: [] };
  const byNative = new Map(mappings.map((row) => [row.nativeId, row]));
  const included = new Set(mapped.map((row) => row.nativeId));
  const extras: ChromeExtra[] = [];
  const seen = new Set<string>();
  const pending = [root.nativeId];
  while (pending.length) {
    const nativeId = pending.shift()!;
    if (seen.has(nativeId)) continue;
    seen.add(nativeId);
    const children = await rangeChildren(context, root, nativeId);
    for (const child of children) {
      pending.push(child.id);
      if (included.has(child.id)) continue;
      included.add(child.id);
      const row = byNative.get(child.id);
      if (row) mapped.push(row);
      else extras.push({ nativeId: child.id, rootNativeId: root.rootNativeId });
    }
  }
  return { mapped, extras };
}

/**
 * SR-02 follow-up: `getChildren` failures are classified instead of being answered with `[]` (the
 * previous `.catch(() => [])`), because an empty answer is a *claim* that this folder has no
 * children - and the range exit persists exclusions/observations derived from it. `not_found` is the
 * one failure that legitimately means "nothing left to walk here" (the folder is already gone
 * locally); it leaves a diagnostic naming the folder so the narrowed extras can be reconciled
 * instead of silently shrinking the exit. `permission_denied` / `managed_not_writable` /
 * `other_failure` keep their raw message and surface, so the existing FREEZE/offline classification
 * decides instead of a decision built on a half-read local fact set.
 */
async function rangeChildren(context: {
  readonly api: PullBookmarkApi; readonly store: Store; readonly scope: SyncScope;
}, root: MappingInput, nativeId: string): Promise<readonly BookmarkNode[]> {
  const looked = await lookupBookmarkChildren((id) => context.api.getChildren(id), nativeId);
  if (looked.class === 'present') return looked.nodes;
  if (looked.class !== 'not_found') throw new Error(looked.message);
  const isRoot = nativeId === root.nativeId;
  await context.store.putScopeDiagnostic(context.scope, { kind: 'pull_range_extras',
    code: isRoot ? 'root_missing' : 'subtree_folder_missing',
    details: { nativeId, colpId: root.colpId, rootNativeId: root.rootNativeId,
      ...(isRoot ? {} : { ancestorNativeId: root.nativeId }) } });
  return [];
}

function unmountedDescendantMappings(subtree: readonly MappingInput[], root: MappingInput,
  destRootNativeId: string): MappingInput[] {
  const subtreeColp = new Set(subtree.map((row) => row.colpId));
  const rows: MappingInput[] = [];
  for (const row of subtree) {
    if (row.colpId === root.colpId || row.nativeId === root.nativeId || isNonChromeNativeId(row.nativeId)) continue;
    const { scopeKey: _scopeKey, ...current } = row as MappingInput & { readonly scopeKey?: string };
    rows.push({
      ...current, nativeId: unmountedNativeId(current.colpId), rootNativeId: destRootNativeId,
      ...(current.parentColpId && subtreeColp.has(current.parentColpId)
        ? { parentNativeId: unmountedNativeId(current.parentColpId) } : {}),
    });
  }
  return rows;
}

function rangeExitFacts(input: {
  readonly mapping: MappingInput; readonly parent: MappingInput; readonly plan: RemoteMovePlan;
  readonly now: number; readonly cursor: string; readonly scope: SyncScope;
}, effect: MoveEffect, kind: RemoteObservationRecord['kind'],
  subtree: readonly MappingInput[], extras: readonly ChromeExtra[] = [],
  pause: ReturnType<typeof pauseBindingForMapping> = {},
  dependencies: readonly string[] = []): NonNullable<PlannedMoveApply['rangeExit']> {
  const observation = {
    colpId: effect.node.id, remoteRevision: effect.node.revision, cursor: input.cursor, kind,
    payload: { parentId: effect.placement.parentId, destNativeId: input.parent.nativeId,
      afterId: effect.placement.afterId, beforeId: effect.placement.beforeId },
    sourceDigest: digest({ effectId: effect.effectDigest, action: input.plan.action }),
    observedAt: input.now, ...pause,
  };
  const exclusions = input.plan.persistExclusion
    ? [
      ...subtree.filter((row) => !isNonChromeNativeId(row.nativeId)).map((row) => ({
        nativeId: row.nativeId, decisionId: input.plan.commandId,
        rootNativeId: row.rootNativeId, generation: input.scope.generation,
        sourceKind: 'range_exit' as const, priorColpId: row.colpId,
      })),
      // Unmapped Chrome descendants: nativeId exclusion only; do not invent a colpId.
      ...extras.map((row) => ({
        nativeId: row.nativeId, decisionId: input.plan.commandId,
        rootNativeId: row.rootNativeId, generation: input.scope.generation,
        sourceKind: 'range_exit' as const,
      })),
    ] : [];
  const command = {
    commandId: input.plan.commandId, kind: 'rangeExit' as const,
    confirmationVersion: input.plan.destBoundaryVersion ?? input.plan.sourceBoundaryVersion ?? '0',
    baselineDigest: observation.sourceDigest, phase: 'applying' as const,
    dependencies: [...dependencies], updatedAt: input.now, mountId: input.mapping.mountId,
  };
  return { observation, ...(exclusions[0] ? { exclusion: exclusions[0] } : {}),
    ...(exclusions.length ? { exclusions } : {}), command };
}

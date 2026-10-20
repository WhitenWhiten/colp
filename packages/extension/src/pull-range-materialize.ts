import { SyncFailureError } from './sync-failure-class.js';
/**
 * Dest copies are new natives via T-02. Source IDs stay excluded and must not
 * be reused as dest identity.
 */
import type { SyncPullEventV02 } from '@know-n/colp/types';
import { executeNativeCreate, type NativeCreateOutcome } from './native-create-executor.js';
import { mappingFor } from './pull-projection.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { digest } from './pull-codec.js';
import { scopeKey } from './sync-state/scope-key.js';
import { createCheckedPullNative } from './pull-native-create-boundary.js';
import {
  buildIndependentPlan, persistIndependentPlan, planFromAnchors, type IndependentSubtreeNode,
} from './pull-range-plan.js';
import type { PullBookmarkApi } from './pull-applier-types.js';
import type { MappingInput, RemoteObservationRecord, SyncScope, createSyncStateStore } from './sync-state-store.js';
type Store = ReturnType<typeof createSyncStateStore>;
type MoveEffect = Extract<Extract<SyncPullEventV02, { kind: 'operation' }>['effect'], { kind: 'node_moved' }>;
type PauseObservation = {
  readonly pauseGeneration?: number; readonly pauseBoundaryVersion?: string; readonly pauseCursor?: string | null;
};

export async function materializeIndependentSubtree(input: {
  readonly store: Store; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly event: Extract<SyncPullEventV02, { kind: 'operation' }>; readonly eventId: string;
  readonly mapping: MappingInput; readonly parent: MappingInput;
  readonly plan: {
    readonly commandId: string; readonly action: string;
    readonly sourceBoundaryVersion: string | null; readonly destBoundaryVersion: string | null;
  };
  readonly subtree: readonly MappingInput[];
  readonly now: number; readonly cursor: string;
  readonly recoverCreated: () => Promise<NativeCreateOutcome>;
  readonly parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) =>
    Promise<MappingInput>;
  readonly pause: PauseObservation;
  readonly crash?: (boundary: string) => void;
  readonly permissionGranted?: boolean;
}): Promise<{
  readonly mappings: MappingInput[]; readonly deleteNativeIds: readonly string[];
  readonly createdNativeId: string; readonly observations: readonly Omit<RemoteObservationRecord, 'scopeKey'>[];
}> {
  const effect = input.event.effect as MoveEffect;
  const mounts = await input.store.listMountBindings(input.scope);
  const built = buildIndependentPlan({
    mapping: input.mapping, parent: input.parent, subtree: input.subtree, plan: input.plan, mounts,
  });
  const intent = await input.store.getApplyIntent(input.scope, `intent:${input.eventId}`);
  const plan = planFromAnchors(intent?.anchors, built);
  await persistIndependentPlan(input.store, input.scope, input.eventId, plan, input.now);
  if (input.permissionGranted === false) throw new SyncFailureError('permission_revoked');
  const destByColp = new Map<string, string>([[input.parent.colpId, input.parent.nativeId]]);
  const destMappings: MappingInput[] = [];
  const observations: Omit<RemoteObservationRecord, 'scopeKey'>[] = [];
  const byColp = new Map(input.subtree.map((row) => [row.colpId, row]));
  for (const node of plan.nodes) {
    const parentNativeId = node.parentColpId ? destByColp.get(node.parentColpId) : input.parent.nativeId;
    if (!parentNativeId || isNonChromeNativeId(parentNativeId)) throw new SyncFailureError('range_dependency_pending');
    const parent = destMappings.find(row => row.colpId === node.parentColpId) ?? input.parent;
    const created = await createDestNative(input, node, parentNativeId, parent);
    if (created === node.sourceNativeId) throw new SyncFailureError('native_result_unknown');
    destByColp.set(node.colpId, created);
    destMappings.push(destMapping(input, node, created, parentNativeId, byColp.get(node.colpId)));
    if (node.colpId !== effect.node.id) {
      observations.push({
        colpId: node.colpId, remoteRevision: node.revision, cursor: input.cursor, kind: 'placement',
        payload: { parentId: node.parentColpId ?? input.parent.colpId, destNativeId: created },
        sourceDigest: digest({ effectId: effect.effectDigest, action: input.plan.action, colpId: node.colpId }),
        observedAt: input.now, ...pauseFields(input.pause),
      });
    }
  }
  const rootNative = destByColp.get(effect.node.id);
  if (!rootNative) throw new SyncFailureError('native_result_unknown');
  const revisions = await Promise.all(effect.parentRevisions.map(input.parentRevisionMapping));
  const deleteNativeIds = input.subtree.filter((row) => !isNonChromeNativeId(row.nativeId)).map((row) => row.nativeId);
  return {
    mappings: [...destMappings, ...revisions], deleteNativeIds, createdNativeId: rootNative, observations,
  };
}

async function createDestNative(input: {
  readonly store: Store; readonly scope: SyncScope; readonly api: PullBookmarkApi;
  readonly event: Extract<SyncPullEventV02, { kind: 'operation' }>; readonly eventId: string;
  readonly parent: MappingInput; readonly plan: { readonly commandId: string; readonly destBoundaryVersion: string | null };
  readonly recoverCreated: () => Promise<NativeCreateOutcome>;
  readonly crash?: (boundary: string) => void;
  readonly permissionGranted?: boolean;
}, node: IndependentSubtreeNode, parentNativeId: string, parent: MappingInput): Promise<string> {
  const effect = input.event.effect as MoveEffect;
  if (node.nodeKind === 'separator') return `sidecar:${node.colpId}`;
  if (node.colpId === effect.node.id) {
    const recovered = await input.recoverCreated();
    if (recovered.result !== 'applied_with_evidence') {
      throw new Error(recovered.result === 'failed' ? recovered.code : 'native_result_unknown');
    }
    return recovered.nativeId;
  }
  const title = typeof node.content?.title === 'string' ? node.content.title : undefined;
  const url = node.nodeKind === 'bookmark' && typeof node.content?.url === 'string' ? node.content.url : undefined;
  const outcome = await executeNativeCreate({
    scope: input.scope, store: input.store, api: input.api,
    intentId: `intent:${input.eventId}:range:${node.colpId}`,
    owner: {
      scopeKey: scopeKey(input.scope), generation: input.scope.generation, commandId: input.plan.commandId,
      eventId: input.eventId, colpId: node.colpId, substep: 'range-materialize',
    },
    parentNativeId, expected: { ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) },
    liveWorkKind: 'create', crash: input.crash, permissionGranted: input.permissionGranted,
    create: () => createCheckedPullNative({ ...input, parent, parentColpId: parent.colpId,
      expectedBoundaryVersion: input.plan.destBoundaryVersion ?? undefined,
      parentProof: { kind: 'create_receipt', eventId: input.eventId,
        intentId: parent.colpId === effect.node.id ? `intent:${input.eventId}` : `intent:${input.eventId}:range:${parent.colpId}`,
        commandId: parent.colpId === effect.node.id ? 'pull' : input.plan.commandId },
      details: { parentId: parentNativeId, index: Math.max(0, node.position),
        ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) },
    }),
  });
  if (outcome.result !== 'applied_with_evidence') {
    throw new Error(outcome.result === 'failed' ? outcome.code : 'native_result_unknown');
  }
  return outcome.nativeId;
}

function destMapping(input: { readonly event: Extract<SyncPullEventV02, { kind: 'operation' }>;
  readonly mapping: MappingInput; readonly parent: MappingInput; },
  node: IndependentSubtreeNode, destNativeId: string, parentNativeId: string, prior: MappingInput | undefined):
  MappingInput {
  const effect = input.event.effect as MoveEffect;
  if (node.colpId === effect.node.id) {
    const mapped = mappingFor(effect.node, destNativeId, input.parent.nativeId, input.parent.colpId,
      input.mapping.projection.childrenRevision ?? null, input.parent.rootNativeId);
    return { ...mapped, ...(input.parent.mountId ? { mountId: input.parent.mountId } : {}) };
  }
  const { scopeKey: _scopeKey, ...current } = (prior ?? {
    nativeId: node.sourceNativeId, colpId: node.colpId, rootNativeId: input.parent.rootNativeId,
    nodeKind: node.nodeKind,
    projection: { revision: node.revision, childrenRevision: node.childrenRevision ?? null, digest: digest(node.content ?? {}),
      ...(node.content ? { content: node.content } : {}) },
  }) as MappingInput & { readonly scopeKey?: string };
  return {
    ...current, nativeId: destNativeId, parentNativeId, rootNativeId: input.parent.rootNativeId,
    ...(input.parent.mountId ? { mountId: input.parent.mountId } : {}),
    ...(node.parentColpId ? { parentColpId: node.parentColpId } : {}),
  };
}

function pauseFields(observation: PauseObservation): Pick<RemoteObservationRecord,
  'pauseGeneration' | 'pauseBoundaryVersion' | 'pauseCursor'> | Record<string, never> {
  if (observation.pauseGeneration === undefined || observation.pauseBoundaryVersion === undefined
      || observation.pauseCursor === undefined) return {};
  return {
    pauseGeneration: observation.pauseGeneration, pauseBoundaryVersion: observation.pauseBoundaryVersion,
    pauseCursor: observation.pauseCursor,
  };
}

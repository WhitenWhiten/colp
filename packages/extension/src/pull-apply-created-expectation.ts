import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { PullApplierOptions } from './pull-applier-types.js';
import { digest } from './pull-codec.js';
import { createExpectation, sidecarExpectation } from './pull-create-evidence.js';
import { isNonChromeNativeId, planCreated, planRestored, unmountedNativeId } from './pull-mount-apply.js';
import { provisionalSelfCreateMapping } from './pull-self-create.js';
import type { MappingInput } from './sync-state-store.js';
import { SyncFailureError } from './sync-failure-class.js';

type OperationEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;

/** Runtime closures the create/restore expectation needs from the applier. */
export interface CreatedExpectationDeps {
  readonly options: PullApplierOptions;
  requireMapping(colpId: string, role: 'parent'): Promise<MappingInput>;
  selfCreateProjection(event: OperationEvent, existing: MappingInput, parent: MappingInput): Promise<MappingInput>;
  nativeIndex(afterId: string | null, beforeId: string | null): Promise<number>;
  parentChildren(colpId: string, parentNativeId: string): Promise<readonly { readonly id: string }[]>;
}

export async function expectedCreateLike(event: OperationEvent, deps: CreatedExpectationDeps) {
  const { options } = deps;
  const effect = event.effect;
  if (effect.kind !== 'node_created' && effect.kind !== 'node_restored') throw new SyncFailureError('pull_effect_kind_invalid');
  if (effect.kind === 'node_created') {
    const plan = await planCreated(options.store, options.scope, event);
    if (plan.kind === 'need_authority') throw new SyncFailureError('need_authority');
    if (plan.kind === 'skip_unmounted') {
      return { eventKind: 'sidecar' as const, nativeId: unmountedNativeId(effect.node.id),
        parentNativeId: unmountedNativeId(effect.placement.parentId), details: { effectDigest: effect.effectDigest },
        anchors: {}, preStateDigest: digest(null) };
    }
    if (plan.kind === 'bind_structure') return { eventKind: 'sidecar' as const, nativeId: plan.mapping.nativeId,
      parentNativeId: plan.mapping.parentNativeId ?? plan.mapping.nativeId, details: { effectDigest: effect.effectDigest }, anchors: {}, preStateDigest: digest(null) };
    if (plan.kind === 'bind_mount') {
      return { eventKind: 'sidecar' as const, nativeId: plan.mount.nativeRootId, parentNativeId: plan.mount.nativeRootId,
        details: { effectDigest: effect.effectDigest }, anchors: {}, preStateDigest: digest(null) };
    }
    if (plan.kind === 'recovered_folder') {
      // Same evidence rule as the general create path: the recovered mount root is expected to
      // exist, so a vanished one is a divergence and a read fault must not become an empty digest.
      return createExpectation(effect, plan.mount.nativeRootId, 0,
        await deps.parentChildren(effect.placement.parentId, plan.mount.nativeRootId));
    }
  } else {
    const plan = await planRestored(options.store, options.scope, effect.placement.parentId);
    if (plan.kind === 'need_authority') throw new SyncFailureError('need_authority');
    if (plan.kind === 'skip_unmounted') {
      return { eventKind: 'sidecar' as const, nativeId: unmountedNativeId(effect.node.id),
        parentNativeId: unmountedNativeId(effect.placement.parentId), details: { effectDigest: effect.effectDigest },
        anchors: {}, preStateDigest: digest(null) };
    }
  }
  const parent = await deps.requireMapping(effect.placement.parentId, 'parent');
  if (effect.kind === 'node_created' && event.operation.replicaId === options.scope.replicaId) {
    const existing = await options.store.getMappingByColpId(options.scope, effect.node.id);
    const own = await options.store.getQueueByOpId(options.scope, event.operation.opId);
    if (existing && !isNonChromeNativeId(existing.nativeId) && own?.status === 'terminal'
        && own.payload.type === 'create_node') {
      const proven = await deps.selfCreateProjection(event, existing, parent);
      return sidecarExpectation(effect.effectDigest, proven, parent.nativeId);
    }
    const provisional = existing ? null : await provisionalSelfCreateMapping(options, event, parent);
    if (provisional) {
      const proven = await deps.selfCreateProjection(event, provisional, parent);
      return sidecarExpectation(effect.effectDigest, proven, parent.nativeId);
    }
  }
  const index = await deps.nativeIndex(effect.placement.afterId, effect.placement.beforeId);
  if (effect.node.kind === 'separator' && options.session.conversionPolicy?.separator === 'preserve_remote') {
    return { eventKind: 'sidecar' as const, nativeId: `sidecar:${effect.node.id}`, parentNativeId: parent.nativeId,
      details: { effectDigest: effect.effectDigest }, anchors: { afterId: effect.placement.afterId,
        beforeId: effect.placement.beforeId, index },
      preStateDigest: digest(await deps.parentChildren(effect.placement.parentId, parent.nativeId)) };
  }
  return createExpectation(effect, parent.nativeId, index,
    await deps.parentChildren(effect.placement.parentId, parent.nativeId));
}

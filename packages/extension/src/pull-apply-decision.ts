import { SyncFailureError, PULL_MAPPING_FAILURE, PULL_PREFLIGHT_FAILURE } from './sync-failure-class.js';
import type { SyncPullEventV02 } from '@know-n/colp/types';
import type { MappingInput } from './sync-state-store.js';
import type { PullApplierOptions } from './pull-applier-types.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { boundNativeId, isNonChromeNativeId, isRecoveryPlaceholder, planCreated, planRestored } from './pull-mount-apply.js';
import { planRemoteMove } from './pull-range-move.js';
import { queueHasPendingTarget } from './pull-queue-facts.js';
import { remoteDeleteMemberIds } from './remote-delete-policy.js';
import { provisionalSelfCreateMapping } from './pull-self-create.js';
import { removedSelfProjectionIsProven } from './pull-local-projection-evidence.js';
import { digest } from './pull-codec.js';

type OpEvent = Extract<SyncPullEventV02, { kind: 'operation' }>;
type MappingRole = 'anchor' | 'deletion' | 'parent' | 'parent_revision' | 'target';

export async function requirePullMapping(options: PullApplierOptions, colpId: string, role: MappingRole) {
  const value = await currentPullMapping(options.store, options.scope, colpId);
  if (value) return role === 'parent' ? mountedPullMapping(options, value) : value;
  throw new SyncFailureError(PULL_MAPPING_FAILURE[role], { nodeId: colpId });
}

/** Intent correlation, Chrome calls and replay must use the same bound parent. */
export async function mountedPullMapping(options: PullApplierOptions, mapping: MappingInput): Promise<MappingInput> {
  if (!isRecoveryPlaceholder(mapping.nativeId)) return mapping;
  const nativeId = boundNativeId(mapping, await options.store.listMountBindings(options.scope));
  return nativeId === mapping.nativeId ? mapping : { ...mapping, nativeId, rootNativeId: nativeId };
}

export async function preflightPullMapping(options: PullApplierOptions, colpId: string,
  stagedCreates: ReadonlySet<string>, role: 'member' | 'parent' | 'target') {
  const mapping = await options.store.getMappingByColpId(options.scope, colpId);
  if (!mapping && !stagedCreates.has(colpId)) throw new SyncFailureError(PULL_PREFLIGHT_FAILURE[role], { nodeId: colpId });
  return mapping && role === 'parent' ? mountedPullMapping(options, mapping) : mapping;
}

export async function requirePullAnchor(options: PullApplierOptions, colpId: string | null,
  nativeParentId: string, stagedCreates: ReadonlySet<string>, stagedParents?: ReadonlyMap<string, string>) {
  if (!colpId) return;
  const stagedParentId = stagedParents?.get(colpId);
  if (stagedParentId !== undefined) {
    const parent = await preflightPullMapping(options, stagedParentId, stagedCreates, 'parent');
    if (parent?.nativeId !== nativeParentId) throw new SyncFailureError('anchor_parent_mismatch');
    return;
  }
  if (stagedCreates.has(colpId)) return;
  const anchor = await requirePullMapping(options, colpId, 'anchor');
  if (anchor.parentNativeId !== nativeParentId) throw new SyncFailureError('anchor_parent_mismatch');
}

export async function preflightPullDependencies(options: PullApplierOptions, event: OpEvent,
  stagedCreates: ReadonlySet<string>,
  selfCreateProjection: (event: OpEvent, existing: MappingInput, parent: MappingInput) => Promise<MappingInput>,
  stagedParents?: ReadonlyMap<string, string>,
): Promise<void> {
  const effect = event.effect;
  if (await missingTerminalSelfDeletion(options, event)
      || await removedSelfProjectionIsProven(options.store, options.scope, event)) return;
  if (effect.kind === 'node_restored') {
    const plan = await planRestored(options.store, options.scope, effect.placement.parentId);
    if (plan.kind === 'skip_unmounted') return;
    if (plan.kind === 'need_authority') {
      if (!stagedCreates.has(effect.placement.parentId)) throw new SyncFailureError('need_authority');
      return;
    }
    // A restored node whose parent mapping is not staged yet is set aside by
    // the apply path. Any other preflight failure is real and must not be
    // mistaken for that specific, recoverable item condition.
    const parent = await preflightPullMapping(options, effect.placement.parentId, stagedCreates, 'parent')
      .catch((error: unknown) => {
        if (error instanceof SyncFailureError && error.code === PULL_PREFLIGHT_FAILURE.parent) return null;
        throw error;
      });
    if (parent) {
      for (const anchor of [effect.placement.afterId, effect.placement.beforeId]) {
        await requirePullAnchor(options, anchor, parent.nativeId, stagedCreates, stagedParents).catch((error: unknown) => {
          if (error instanceof SyncFailureError && error.code === PULL_MAPPING_FAILURE.anchor) return;
          throw error;
        });
      }
    }
    return;
  }
  if (effect.kind === 'node_created') {
    const plan = await planCreated(options.store, options.scope, event);
    if (plan.kind === 'need_authority') throw new SyncFailureError('need_authority');
    if (plan.kind === 'skip_unmounted' || plan.kind === 'bind_structure' || plan.kind === 'bind_mount' || plan.kind === 'recovered_folder') return;
    const parent = await preflightPullMapping(options, effect.placement.parentId, stagedCreates, 'parent');
    const own = event.operation.replicaId === options.scope.replicaId
      ? await options.store.getQueueByOpId(options.scope, event.operation.opId) : null;
    const existing = own?.status === 'terminal' && own.payload.type === 'create_node'
      ? await options.store.getMappingByColpId(options.scope, effect.node.id) : null;
    if (parent && existing && !isNonChromeNativeId(existing.nativeId)) {
      // This receipt's native already exists. Validate its identity/post-state;
      // a later local move of its old anchor cannot require a new Chrome create.
      await selfCreateProjection(event, existing, parent); return;
    }
    if (parent && !existing) {
      const provisional = await provisionalSelfCreateMapping(options, event, parent);
      if (provisional) { await selfCreateProjection(event, provisional, parent); return; }
    }
    if (parent) { await requirePullAnchor(options, effect.placement.afterId, parent.nativeId, stagedCreates, stagedParents);
      await requirePullAnchor(options, effect.placement.beforeId, parent.nativeId, stagedCreates, stagedParents); } return; }
  if (effect.kind === 'node_content_updated' || effect.kind === 'node_moved' || effect.kind === 'node_deleted') {
    await preflightPullMapping(options, effect.kind === 'node_deleted' ? effect.tombstone.targetId : effect.node.id, stagedCreates, 'target');
    if (effect.kind === 'node_moved') { const parent = await preflightPullMapping(options, effect.placement.parentId, stagedCreates, 'parent');
      if (parent) { await requirePullAnchor(options, effect.placement.afterId, parent.nativeId, stagedCreates, stagedParents);
        await requirePullAnchor(options, effect.placement.beforeId, parent.nativeId, stagedCreates, stagedParents); }
      const target = await options.store.getMappingByColpId(options.scope,
        effect.node.id);
      if (target && parent) {
        const mounts = await options.store.listMountBindings(options.scope);
        const plan = planRemoteMove({
          event, mapping: target, parent, mounts, generation: options.scope.generation,
          permissionConfirmed: (await options.store.getScope(options.scope))?.rootStatus !== 'permission_required',
          pendingLocalOperations: await queueHasPendingTarget(options.store, options.scope, target.colpId),
        });
        if (plan.action === 'await_dependency') throw new SyncFailureError('range_dependency_pending');
      }
    }
    return;
  }
  const members = 'members' in effect ? effect.members : [];
  for (const member of members ?? []) await preflightPullMapping(options, member, stagedCreates, 'member');
}

export async function missingTerminalSelfDeletion(options: PullApplierOptions, event: OpEvent) {
  const ids = remoteDeleteMemberIds(event); if (!ids.length || event.operation.replicaId !== options.scope.replicaId) return false;
  const queued = await options.store.getQueueByOpId(options.scope, event.operation.opId);
  if (queued?.status !== 'terminal') return false;
  const mappings = await Promise.all(ids.map((id) => currentPullMapping(options.store, options.scope, id)));
  return mappings.every((mapping) => !mapping);
}

export async function commitMissingTerminalSelfDeletion(options: PullApplierOptions, eventId: string, event: OpEvent,
  parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) => Promise<MappingInput>) {
  await options.store.recordPullApiEvidence(options.scope, eventId, { operationId: event.operation.opId,
    recovery: 'self_echo' });
  await options.store.commitPullEvent(options.scope, eventId, { mappings: [await parentRevisionMapping(
    event.effect.kind === 'node_deleted' || event.effect.kind === 'subtree_deleted'
      ? event.effect.parentRevision : unreachableDeletion())],
  apiResultEvidence: { operationId: event.operation.opId, recovery: 'self_echo' } });
}

/** Settle an acknowledged update superseded by a captured local removal, even after its mapping is gone. */
export async function commitRemovedSelfProjection(options: PullApplierOptions, eventId: string, event: OpEvent,
  now: number,
  parentRevisionMapping: (revision: { readonly parentId: string; readonly childrenRevision: string }) => Promise<MappingInput>,
): Promise<boolean> {
  if (!await removedSelfProjectionIsProven(options.store, options.scope, event)) return false;
  const current = await options.store.getPullEvent(options.scope, eventId);
  if (current?.state === 'staged') {
    options.crash?.('before_intent');
    await options.store.preparePullIntent(options.scope, eventId, {
      intentId: `intent:${eventId}`, correlationId: digest({ eventId, recovery: 'local_removal' }),
      operationId: event.operation.opId, eventId, effectId: event.effect.effectId,
      expected: { kind: 'sidecar', nativeId: `removed:${event.operation.opId}` },
      expiresAt: now + 300_000, generation: options.scope.generation,
    });
  }
  options.crash?.('after_intent');
  if (current?.state === 'staged' || current?.state === 'intent_prepared') {
    await options.store.markPullBrowserCallStarted(options.scope, eventId);
  }
  await options.store.recordPullApiEvidence(options.scope, eventId, { operationId: event.operation.opId, recovery: 'local_removal' });
  await options.store.commitPullEvent(options.scope, eventId, {
    mappings: event.effect.kind === 'node_created' ? [await parentRevisionMapping(event.effect.parentRevision)] : [],
    apiResultEvidence: { recovery: 'local_removal' } });
  return true;
}

function unreachableDeletion(): never { throw new SyncFailureError('pull_effect_kind_invalid'); }

import type { SyncPullEventV02 } from '@know-n/colp/types';
import { placedChildOrder } from './bookmark-child-order.js';
import { childOrderFromProjection } from './bookmark-reorder-diff.js';
import { currentPullMapping } from './pull-mapping-view.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { mappingMountActivity } from './pull-range-move.js';
import { requirePullMapping } from './pull-apply-decision.js';
import type { PullApplierOptions } from './pull-applier-types.js';
import type { MappingInput } from './sync-state-store.js';

/** Keep the parent revision and its effect-derived sibling order in one mapping write. */
export function parentRevisionMappingFor(options: PullApplierOptions) {
  return async (revision: { readonly parentId: string; readonly childrenRevision: string },
    event?: Extract<SyncPullEventV02, { kind: 'operation' }>, nativeId?: string): Promise<MappingInput> => {
    const parent = await requirePullMapping(options, revision.parentId, 'parent_revision');
    const { scopeKey: _scopeKey, ...mapping } = parent as MappingInput & { readonly scopeKey?: string };
    const order = event ? await pullChildOrder(options, parent, event, nativeId) : undefined;
    return { ...mapping, projection: { ...parent.projection, ...(order ? { childrenOrder: order } : {}),
      childrenRevision: revision.childrenRevision } };
  };
}

/** Advance the recorded order from the remote effect, never from a later user tree. */
export async function pullChildOrder(options: PullApplierOptions, parent: MappingInput,
  event: Extract<SyncPullEventV02, { kind: 'operation' }>, createdNativeId?: string): Promise<readonly string[] | undefined> {
  const previous = childOrderFromProjection(parent.projection);
  if (!previous || mappingMountActivity(parent, await options.store.listMountBindings(options.scope)) !== 'active') return previous;
  if (event.operation.replicaId === options.scope.replicaId
    && await options.store.getQueueByOpId(options.scope, event.operation.opId)) return previous;
  const effect = event.effect;
  const targetId = effect.kind === 'node_deleted' ? effect.tombstone.targetId
    : effect.kind === 'subtree_deleted' ? effect.rootTombstone.targetId : effect.node.id;
  const nativeId = createdNativeId ?? (await currentPullMapping(options.store, options.scope, targetId))?.nativeId;
  if (!nativeId || isNonChromeNativeId(nativeId)) return previous;
  if (effect.kind === 'node_deleted' || effect.kind === 'subtree_deleted') return previous.filter(id => id !== nativeId);
  if (effect.kind === 'node_content_updated') return previous;
  if (effect.placement.parentId !== parent.colpId) return previous.filter(id => id !== nativeId);
  const after = effect.placement.afterId
    ? await currentPullMapping(options.store, options.scope, effect.placement.afterId) : null;
  const before = effect.placement.beforeId
    ? await currentPullMapping(options.store, options.scope, effect.placement.beforeId) : null;
  return placedChildOrder(previous, nativeId, { ...(after ? { afterNativeId: after.nativeId } : {}),
    ...(before ? { beforeNativeId: before.nativeId } : {}) });
}

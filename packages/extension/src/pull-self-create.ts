import { canonicalOperationDigest } from '@know-n/colp/sync/canonical';
import type { Operation, SyncPullEventV02 } from '@know-n/colp/types';
import { plannedCreateNativeId } from './bookmark-event-codec.js';
import type { PullApplierOptions } from './pull-applier-types.js';
import type { MappingInput } from './sync-state-store.js';
import { mappingFor } from './pull-projection.js';
import { virtualNativeId } from './projection-native-occupancy.js';

/** A first-sync create owns a native bookmark even before its Push receipt exists. */
export async function provisionalSelfCreateMapping(options: PullApplierOptions,
  event: Extract<SyncPullEventV02, { kind: 'operation' }>, parent: MappingInput) {
  if (event.operation.replicaId !== options.scope.replicaId || event.effect.kind !== 'node_created') return null;
  const provisional = await options.store.getMappingByColpId(options.scope, `pending-${event.operation.opId}`);
  if (provisional) return provisional;
  const nativeId = plannedCreateNativeId(event.operation.opId);
  if (!nativeId) return null;
  const queued = await options.store.getQueueByOpId(options.scope, event.operation.opId);
  if (!queued || queued.payload.type !== 'create_node') return null;
  if (queued.sequence !== event.operation.sequence
      || canonicalOperationDigest(queued.payload as unknown as Operation) !== event.effect.operationDigest) {
    throw new Error('pull_source_binding_invalid');
  }
  const current = await options.store.getMappingByNativeId(options.scope, nativeId);
  if (current && current.colpId !== event.effect.node.id && !current.colpId.startsWith('pending-')) {
    throw new Error('mapping_identity_collision');
  }
  const canonical = await options.store.getMappingByColpId(options.scope, event.effect.node.id);
  if (canonical && canonical.nativeId !== nativeId && !virtualNativeId(canonical.nativeId)) {
    throw new Error('mapping_identity_collision');
  }
  return mappingFor(event.effect.node, nativeId, parent.nativeId, parent.colpId,
    event.effect.nodeChildrenRevision, parent.rootNativeId);
}

/** Recovery may inspect local edits only when this replica durably authored the create. */
export async function hasQueuedSelfCreate(options: PullApplierOptions,
  event: Extract<SyncPullEventV02, { kind: 'operation' }>): Promise<boolean> {
  if (event.operation.replicaId !== options.scope.replicaId || event.effect.kind !== 'node_created') return false;
  const queued = await options.store.getQueueByOpId(options.scope, event.operation.opId);
  return !!queued && queued.status !== 'rejected' && queued.payload.type === 'create_node'
    && queued.sequence === event.operation.sequence
    && canonicalOperationDigest(queued.payload as unknown as Operation) === event.effect.operationDigest;
}

import type {
  JsonObject, MappingInput, MountBindingRecord, RecoveryNodeRecord, RemoteObservationRecord,
  SyncScope, createSyncStateStore,
} from './sync-state-store.js';

type Store = ReturnType<typeof createSyncStateStore>;

/** Remote descendants of `mount.remoteMountNodeId`. Local mapping cardinality is not a substitute. */
export async function countRemoteMountDescendants(
  store: Store, scope: SyncScope, mount: MountBindingRecord,
): Promise<number> {
  if (!mount.remoteMountNodeId) throw new Error('mount_not_bound');
  const header = await store.getRecoveryHeader(scope);
  if (header?.complete) {
    const nodes = (await store.listRecoveryNodes(scope)).filter((node) => node.snapshotId === header.snapshotId);
    return snapshotDescendantCount(nodes, mount.remoteMountNodeId);
  }
  const mappings = await store.listMappings(scope);
  const observations = await store.listRemoteObservations(scope);
  return deviceFactDescendantCount(mount, mappings, observations);
}

function snapshotDescendantCount(nodes: readonly RecoveryNodeRecord[], remoteMountNodeId: string): number {
  const byId = new Map(nodes.map((node) => [node.colpId, node]));
  let count = 0;
  let hasMountNode = false;
  for (const node of nodes) {
    if (node.colpId === remoteMountNodeId) { hasMountNode = true; continue; }
    if (hasAncestor(node.parentId, remoteMountNodeId, byId)) count += 1;
  }
  if (count === 0 && !hasMountNode) throw new Error('remote_subtree_unknown');
  return count;
}

function deviceFactDescendantCount(
  mount: MountBindingRecord, mappings: readonly MappingInput[],
  observations: readonly RemoteObservationRecord[],
): number {
  const remoteMountNodeId = mount.remoteMountNodeId!;
  const members = new Set<string>([remoteMountNodeId]);
  for (const mapping of mappings) {
    if (!mappingBelongsToMount(mapping, mount) || isLocalOnlyIdentity(mapping)) continue;
    if (mapping.nativeId === mount.nativeRootId || mapping.colpId === remoteMountNodeId) continue;
    members.add(mapping.colpId);
  }
  const live = observations.filter((row) => row.kind !== 'tombstone');
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of live) {
      if (members.has(row.colpId)) continue;
      const parent = observationParentId(row.payload);
      if (!parent || !members.has(parent)) continue;
      members.add(row.colpId);
      grew = true;
    }
  }
  let count = 0;
  for (const id of members) if (id !== remoteMountNodeId) count += 1;
  if (count === 0 && !mappings.some(row => row.colpId === remoteMountNodeId && !isLocalOnlyIdentity(row))
    && !live.some(row => row.colpId === remoteMountNodeId)) throw new Error('remote_subtree_unknown');
  return count;
}

function mappingBelongsToMount(mapping: MappingInput, mount: MountBindingRecord): boolean {
  return mapping.mountId === mount.mountId || mapping.rootNativeId === mount.nativeRootId;
}

function isLocalOnlyIdentity(mapping: MappingInput): boolean {
  return mapping.colpId.startsWith('pending-') || mapping.projection.revision.startsWith('local-');
}

function observationParentId(payload: JsonObject): string | null {
  if (typeof payload.parentId === 'string') return payload.parentId;
  const placement = payload.placement;
  if (placement && typeof placement === 'object' && !Array.isArray(placement)
      && typeof (placement as JsonObject).parentId === 'string') {
    return (placement as JsonObject).parentId as string;
  }
  return null;
}

function hasAncestor(
  start: string | null, ancestor: string, byId: Map<string, { readonly parentId: string | null }>,
): boolean {
  const seen = new Set<string>();
  let current = start;
  while (current) {
    if (current === ancestor) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

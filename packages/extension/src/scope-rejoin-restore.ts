import { assertRejoinCanonicalBoundary } from './scope-rejoin-boundary.js';
import { rejoinAuthority, remoteChildren, remoteIndex, snapshotMapping } from './scope-rejoin-authority.js';
import { isNonChromeNativeId } from './pull-mount-apply.js';
import { observationEvidenceDigest, type RejoinRestoreChange, type RejoinRestoreEvidence,
  type RejoinRestoreOrder } from './sync-state/rejoin-decision-repository.js';
import type { RejoinOrderInput } from './scope-rejoin-order.js';
import type { MissingRejoinGroup } from './scope-rejoin-deletion.js';
import type { MappingInput, MountBindingRecord } from './sync-state-store.js';

/** Freeze the full subtree, newly introduced ancestors, and their authoritative sibling order. */
export async function planRejoinRestore(input: RejoinOrderInput, group: MissingRejoinGroup): Promise<RejoinRestoreEvidence> {
  const snapshot = await rejoinAuthority(input);
  if (!snapshot || !group.remote?.length) throw new Error('rejoin_remote_order_unavailable');
  if (group.blockedByLocalMove) throw new Error('rejoin_waiting_local_move');
  const { byId } = remoteIndex(snapshot);
  const all = await input.store.listMappings(input.scope);
  const byColp = new Map(all.map(row => [row.colpId, strip(row)]));
  const mounts = await input.store.listMountBindings(input.scope);
  const byRoot = new Map(mounts.flatMap(mount => mount.remoteMountNodeId ? [[mount.remoteMountNodeId, mount] as const] : []));
  const included = new Map(group.remote.map(row => [row.nodeId, row]));
  for (const row of group.remote) {
    let id = row.parentId; const seen = new Set<string>();
    while (id && !byRoot.has(id) && !byColp.has(id)) {
      if (seen.has(id)) throw new Error('rejoin_remote_tree_invalid');
      seen.add(id); const parent = byId.get(id);
      if (!parent || parent.kind !== 'folder') throw new Error('rejoin_remote_tree_invalid');
      included.set(parent.nodeId, parent); id = parent.parentId;
    }
  }
  function destination(nodeId: string): MountBindingRecord {
    let id: string | null = nodeId; const seen = new Set<string>();
    while (id) {
      if (seen.has(id)) throw new Error('rejoin_remote_tree_invalid');
      seen.add(id);
      const mount = byRoot.get(id); if (mount) return mount;
      id = byId.get(id)?.parentId ?? byColp.get(id)?.parentColpId ?? null;
    }
    throw new Error('rejoin_destination_unavailable');
  }
  const changes = new Map<string, RejoinRestoreChange>();
  const parentIds = new Set<string>();
  for (const fact of included.values()) {
    if (fact.privateLocal || fact.managed) throw new Error('rejoin_boundary_changed');
    const before = byColp.get(fact.nodeId) ?? null;
    const mount = destination(fact.nodeId);
    const live = before && !isNonChromeNativeId(before.nativeId) ? await input.getNative(before.nativeId) : undefined;
    const after = live ? before! : snapshotMapping(fact, mount);
    changes.set(fact.nodeId, { before, after });
    if (fact.parentId) parentIds.add(fact.parentId);
    if (fact.kind === 'folder') parentIds.add(fact.nodeId);
  }
  const orders: RejoinRestoreOrder[] = [];
  for (const parentId of parentIds) {
    const fact = byId.get(parentId);
    if (!fact) throw new Error('rejoin_remote_tree_invalid');
    const children = remoteChildren(snapshot, parentId).map(row => row.nodeId);
    orders.push({ parentId, children, childrenRevision: fact.childrenRevision! });
    const before = byColp.get(parentId) ?? null;
    const current = changes.get(parentId)?.after ?? before;
    if (!current) continue;
    const order = children.map(id => changes.get(id)?.after.nativeId ?? byColp.get(id)?.nativeId ?? `unmounted:${id}`);
    changes.set(parentId, { before, after: { ...current,
      projection: { ...current.projection, childrenOrder: order, childrenRevision: fact.childrenRevision! } } });
  }
  const projected = new Map(all.map(row => [row.colpId, row as MappingInput]));
  for (const change of changes.values()) projected.set(change.after.colpId, change.after);
  await assertRejoinCanonicalBoundary(input, [...projected.values()],
    [...changes.values()].map(change => change.after), group.boundaryDigest);
  return { changes: [...changes.values()], orders,
    observationDigest: observationEvidenceDigest(await input.store.listRemoteObservations(input.scope)) };
}
function strip(value: MappingInput & { readonly scopeKey?: string }): MappingInput {
  const { scopeKey: _key, ...rest } = value; return rest;
}

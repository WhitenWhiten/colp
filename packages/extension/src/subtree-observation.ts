import { subtreeDeleteSource } from '@know-n/colp/sync/canonical';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

/** Capture once, before dropping native mappings; never recompute at upload. */
export function mappedSubtreeDeleteSource(rootId: string, mappings: readonly MappingInput[]) {
  const byNative = new Map(mappings.map(row => [row.nativeId, row.colpId]));
  const children = new Map<string, MappingInput[]>();
  for (const row of mappings) {
    const parent = row.parentColpId ?? (row.parentNativeId ? byNative.get(row.parentNativeId) : undefined);
    if (parent) {
      const siblings = children.get(parent) ?? []; siblings.push(row); children.set(parent, siblings);
    }
  }
  const root = mappings.find(row => row.colpId === rootId);
  if (!root) throw new Error('subtree_observation_unavailable');
  const members: { id: string; revision: string }[] = [];
  const pending = [root]; const seen = new Set<string>();
  while (pending.length) {
    const row = pending.pop()!;
    if (seen.has(row.colpId)) throw new Error('subtree_observation_unavailable');
    seen.add(row.colpId);
    if (/^(pending-|local-)/u.test(row.colpId) || row.projection.revision.startsWith('local-')) {
      throw new Error('subtree_observation_unavailable');
    }
    members.push({ id: row.colpId, revision: row.projection.revision });
    for (const child of children.get(row.colpId) ?? []) pending.push(child);
  }
  return subtreeDeleteSource(rootId, members);
}

export async function scopeSubtreeDeleteSource(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope,
  rootId: string) {
  return mappedSubtreeDeleteSource(rootId, await remoteSubtreeMappings(store, scope));
}

export async function remoteSubtreeMappings(store: ReturnType<typeof createSyncStateStore>, scope: SyncScope): Promise<MappingInput[]> {
  const header = await store.getRecoveryHeader(scope);
  const rows: MappingInput[] = header?.complete ? (await store.listRecoveryNodes(scope))
    .filter(row => row.snapshotId === header.snapshotId).map(row => ({ ...row.mapping,
      ...(row.parentId ? { parentColpId: row.parentId } : {}) })) : await store.listMappings(scope);
  if (!header?.complete) {
    const byId = new Map(rows.map(row => [row.colpId, row]));
    for (const observation of await store.listRemoteObservations(scope)) {
      if (observation.kind === 'tombstone') { byId.delete(observation.colpId); continue; }
      const prior = byId.get(observation.colpId);
      const payload = observation.payload;
      const placement = payload.placement;
      const parentId = typeof payload.parentId === 'string' ? payload.parentId
        : placement && typeof placement === 'object' && !Array.isArray(placement)
          && typeof placement.parentId === 'string' ? placement.parentId : prior?.parentColpId;
      if (prior && !parentId) continue;
      byId.set(observation.colpId, { ...(prior ?? { nativeId: `sidecar:${observation.colpId}`,
        colpId: observation.colpId, rootNativeId: 'remote-observation' }),
      ...(parentId ? { parentColpId: parentId } : {}), projection: { ...(prior?.projection ?? { digest: observation.sourceDigest }),
        revision: observation.remoteRevision } });
    }
    return [...byId.values()];
  }
  return rows;
}

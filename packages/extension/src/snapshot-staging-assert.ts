import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type RecoveryNode = {
  readonly colpId: string; readonly parentId: string | null; readonly position: string;
  readonly kind: 'Folder' | 'Bookmark' | 'Separator'; readonly mapping: MappingInput;
};

export async function assertCompleteSnapshotStaging(
  store: Pick<ReturnType<typeof createSyncStateStore>, 'exportScope'>,
  scope: SyncScope, rootId: string,
): Promise<void> {
  const exported = await store.exportScope(scope);
  const nodes = exported.recoveryNodes as unknown as RecoveryNode[];
  const ids = new Set(nodes.map((node) => node.colpId));
  const byId = new Map(nodes.map((node) => [node.colpId, node]));
  const roots = nodes.filter((node) => node.parentId === null);
  const placements = new Set<string>();
  const placementDuplicate = nodes.filter((node) => node.parentId !== null).some((node) => {
    const key = `${node.parentId}\u0000${node.position}`;
    if (placements.has(key)) return true; placements.add(key); return false;
  });
  if (ids.size !== nodes.length || roots.length !== 1 || roots[0]?.colpId !== rootId
      || nodes.some((node) => node.parentId !== null
        && (!ids.has(node.parentId) || byId.get(node.parentId)?.kind !== 'Folder')) || placementDuplicate
      || nodes.some((node) => node.mapping.colpId !== node.colpId
        || node.mapping.parentColpId !== (node.parentId ?? undefined)
        || node.mapping.nodeKind !== node.kind.toLowerCase()
        || (node.mapping.nodeKind === 'folder' && node.mapping.projection.childrenRevision == null))) {
    throw new Error('snapshot_graph_incomplete');
  }
  for (const node of nodes) {
    const ancestors = new Set<string>([node.colpId]); let parentId = node.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) throw new Error('snapshot_graph_incomplete');
      ancestors.add(parentId); parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

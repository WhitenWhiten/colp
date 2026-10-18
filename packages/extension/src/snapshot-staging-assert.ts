import { readOpenSyncIssues, snapshotIssueProtectionIds, type SyncIssueStore } from './sync-issues.js';
import { SyncFailureError } from './sync-failure-class.js';
import type { MappingInput, SyncScope, createSyncStateStore } from './sync-state-store.js';

type RecoveryNode = {
  readonly colpId: string; readonly parentId: string | null; readonly position: string;
  readonly kind: 'Folder' | 'Bookmark' | 'Separator'; readonly mapping: MappingInput; readonly snapshotChildrenRevision?: string;
};

export async function assertCompleteSnapshotStaging(
  store: Pick<ReturnType<typeof createSyncStateStore>, 'exportScope'> & SyncIssueStore,
  scope: SyncScope, rootId: string,
): Promise<void> {
  const exported = await store.exportScope(scope);
  const nodes = exported.recoveryNodes as unknown as RecoveryNode[];
  const live = await store.listMappings?.(scope) ?? [];
  const prior = new Map(live.map(row => [row.colpId, row]));
  const protectedIds = snapshotIssueProtectionIds(live, nodes.map(node => node.mapping), (await readOpenSyncIssues(store, scope)).roots);
  const retained = (node: RecoveryNode) => protectedIds.has(node.colpId)
    && prior.get(node.colpId)?.nativeId === node.mapping.nativeId
    && prior.get(node.colpId)?.projection.digest === node.mapping.projection.digest;
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
        || node.mapping.parentColpId !== (node.parentId ?? undefined) && !retained(node)
        || node.mapping.nodeKind !== node.kind.toLowerCase()
        || (node.mapping.nodeKind === 'folder' && (node.snapshotChildrenRevision ?? node.mapping.projection.childrenRevision) == null))) {
    throw new SyncFailureError('snapshot_graph_incomplete');
  }
  for (const node of nodes) {
    const ancestors = new Set<string>([node.colpId]); let parentId = node.parentId;
    while (parentId !== null) {
      if (ancestors.has(parentId)) throw new SyncFailureError('snapshot_graph_incomplete');
      ancestors.add(parentId); parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

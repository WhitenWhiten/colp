import { NodeConflictError } from '../domain/index.js';
import type { LockedNodeRow } from './ports.js';

export interface RestoreLiveNodeReader {
  getNode(collectionId: string, nodeId: string): Promise<LockedNodeRow | null>;
  listLiveNodes?(collectionId: string): Promise<readonly LockedNodeRow[]>;
}

/**
 * Optional restore-side cache of live LockedNodeRow. When listLiveNodes is
 * omitted, every lookup goes to getNode (unit doubles). After a successful
 * move/update/delete, drop the touched ids and parent folders — and cached
 * children of those parents, because a sibling rebalance can rewrite
 * resourceRevision.
 */
export interface RestoreLiveNodeLookup {
  get(collectionId: string, nodeId: string): Promise<LockedNodeRow | null>;
  invalidateTouched(
    nodeIds: readonly string[],
    parentFolderIds: readonly (string | null | undefined)[],
  ): void;
}

export async function createRestoreLiveNodeLookup(
  nodes: RestoreLiveNodeReader,
  collectionId: string,
): Promise<RestoreLiveNodeLookup> {
  const listed = nodes.listLiveNodes
    ? await nodes.listLiveNodes(collectionId)
    : null;
  const cache = listed ? new Map(listed.map((row) => [row.id, row])) : null;

  return {
    async get(cid, nodeId) {
      const hit = cache?.get(nodeId);
      if (hit) return hit;
      const fresh = await nodes.getNode(cid, nodeId);
      if (cache && fresh && fresh.deletedAt === null) cache.set(fresh.id, fresh);
      return fresh;
    },
    invalidateTouched(nodeIds, parentFolderIds) {
      if (!cache) return;
      const parents = new Set<string>();
      for (const id of nodeIds) cache.delete(id);
      for (const id of parentFolderIds) {
        if (typeof id !== 'string' || id.length < 1) continue;
        parents.add(id);
        cache.delete(id);
      }
      if (parents.size === 0) return;
      for (const [id, row] of [...cache.entries()]) {
        if (row.parentId !== null && parents.has(row.parentId)) cache.delete(id);
      }
    },
  };
}

export async function requireLiveNode(
  liveNodes: RestoreLiveNodeLookup,
  collectionId: string,
  nodeId: string,
): Promise<LockedNodeRow> {
  const node = await liveNodes.get(collectionId, nodeId);
  if (!node || node.deletedAt !== null) {
    throw new NodeConflictError('revision_conflict', 'A restore target node is no longer live.');
  }
  return node;
}

export async function requireLiveFolder(
  liveNodes: RestoreLiveNodeLookup,
  collectionId: string,
  folderId: string,
): Promise<LockedNodeRow> {
  const node = await requireLiveNode(liveNodes, collectionId, folderId);
  if (node.kind !== 'folder') {
    throw new NodeConflictError('revision_conflict', 'A restore parent is not a live folder.');
  }
  return node;
}

export async function isCurrentDescendant(
  liveNodes: RestoreLiveNodeLookup,
  collectionId: string,
  ancestorId: string,
  nodeId: string,
): Promise<boolean> {
  let current = await liveNodes.get(collectionId, nodeId);
  const seen = new Set<string>();
  while (current && current.parentId) {
    if (current.parentId === ancestorId) return true;
    if (seen.has(current.parentId)) return false;
    seen.add(current.parentId);
    current = await liveNodes.get(collectionId, current.parentId);
  }
  return false;
}

export async function childOnPath(
  liveNodes: RestoreLiveNodeLookup,
  collectionId: string,
  ancestorId: string,
  descendantId: string,
): Promise<string | null> {
  let cursor = descendantId;
  let current = await liveNodes.get(collectionId, cursor);
  while (current && current.parentId) {
    if (current.parentId === ancestorId) return cursor;
    cursor = current.parentId;
    current = await liveNodes.get(collectionId, cursor);
  }
  return null;
}

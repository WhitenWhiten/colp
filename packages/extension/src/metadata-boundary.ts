import type { IngressBoundary } from './bookmark-event-ingress.js';
import { folderIsInSyncRange, type FolderTreeNode } from './save-folder.js';

/** All fields use the same complete native ancestry; missing/cyclic ancestry fails closed. */
export function createMetadataBoundary(tree: readonly FolderTreeNode[], boundary: IngressBoundary) {
  const nodes = new Map<string, FolderTreeNode>(), pending = tree.map(node => ({ node, parentId: undefined as string | undefined }));
  for (let i = 0; i < pending.length; i++) {
    const { node, parentId } = pending[i]!;
    if (nodes.has(node.id)) throw new Error('metadata_tree_invalid');
    nodes.set(node.id, { ...node, parentId: node.parentId ?? parentId });
    for (const child of node.children ?? []) pending.push({ node: child, parentId: node.id });
  }
  const allowed = (mapping: { readonly nativeId: string }) => {
    if (boundary.rootStatus !== 'ready') return false;
    let node = nodes.get(mapping.nativeId);
    if (!node) return false;
    const parents: string[] = [], seen = new Set<string>();
    while (node) {
      if (seen.has(node.id) || seen.size >= 256 || node.unmodifiable) return false;
      seen.add(node.id);
      if (!node.parentId) break;
      parents.push(node.parentId); node = nodes.get(node.parentId);
      if (!node) return false;
    }
    return folderIsInSyncRange(mapping.nativeId, parents, boundary.selectedNative, boundary.privateNative);
  };
  return { nodes, allowed };
}

/** Recheck the mapping and live native ancestry inside the request's subscription lock. */
export async function assertMetadataTarget(mapping: { readonly nativeId: string; readonly colpId: string },
  expected: FolderTreeNode | undefined, deps: {
    readonly assertCurrent: () => Promise<void>;
    readonly mapping: () => Promise<{ readonly colpId: string } | null>;
    readonly boundary: () => Promise<IngressBoundary>;
    readonly node: (id: string) => Promise<FolderTreeNode | undefined>;
  }): Promise<void> {
  await deps.assertCurrent();
  const live = await deps.mapping();
  if (!live || live.colpId !== mapping.colpId) throw new Error('metadata_mapping_changed');
  const boundary = await deps.boundary();
  if (boundary.rootStatus !== 'ready') throw new Error('metadata_boundary_changed');
  const parents: string[] = [], seen = new Set<string>();
  let id: string | undefined = mapping.nativeId;
  while (id) {
    if (seen.has(id) || seen.size >= 256) throw new Error('metadata_boundary_changed');
    seen.add(id);
    const node = await deps.node(id);
    if (!node || node.unmodifiable || (id === mapping.nativeId
      && (node.dateAdded !== expected?.dateAdded || node.url !== expected?.url))) throw new Error('metadata_boundary_changed');
    id = node.parentId;
    if (id) parents.push(id);
  }
  if (!folderIsInSyncRange(mapping.nativeId, parents, boundary.selectedNative, boundary.privateNative)) throw new Error('metadata_boundary_changed');
  await deps.assertCurrent();
}

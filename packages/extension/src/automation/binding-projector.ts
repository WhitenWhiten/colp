import type { CompiledRule, FolderRef } from '@know-n/colp/automation';
import type { LocalFolder, LocalRule } from './runtime-profile.js';

/**
 * Canonical ↔ native projection for automation rules.
 *
 * Bundles name folders by canonical identity (serverUuid, collectionId,
 * nodeId); only this browser knows which native folder holds that node, through
 * the Sync mapping. A folder without a live mapping is unresolved: the rule is
 * blocked and the save keeps its own destination. Nothing here looks a folder
 * up by title or path.
 */
export interface ProjectionDeps {
  /** The current Sync scope's mapping for a canonical node. */
  mappingByColpId(colpId: string): Promise<{ readonly nativeId: string; readonly nodeKind?: string } | null>;
  mappingByNativeId(nativeId: string): Promise<{ readonly colpId: string; readonly nodeKind?: string } | null>;
  nativeNode(nativeId: string): Promise<{ readonly id: string; readonly title: string; readonly parentId?: string; readonly url?: string } | null>;
}

export async function projectFolder(folder: FolderRef, collectionId: string, deps: ProjectionDeps): Promise<LocalFolder> {
  if (folder.collectionId !== collectionId) return { status: 'unresolved', folder, reason: 'otherCollection' };
  const mapping = await deps.mappingByColpId(folder.nodeId);
  if (!mapping || (mapping.nodeKind !== undefined && mapping.nodeKind !== 'folder')) {
    return { status: 'unresolved', folder, reason: mapping ? 'notFolder' : 'unmapped' };
  }
  const node = await deps.nativeNode(mapping.nativeId);
  if (!node) return { status: 'unresolved', folder, reason: 'deleted' };
  if (node.url !== undefined) return { status: 'unresolved', folder, reason: 'notFolder' };
  return { status: 'resolved', folder, nativeId: node.id, title: node.title };
}

/** Every folder role of a rule, resolved against the current collection. */
export async function projectRule(rule: CompiledRule, collectionId: string, deps: ProjectionDeps): Promise<LocalRule> {
  const folders: Record<string, LocalFolder> = {};
  for (const [role, binding] of Object.entries(rule.nativeBindingHints)) {
    if (binding.kind === 'folder') folders[role] = await projectFolder(binding.folder, collectionId, deps);
  }
  return { rule, folders };
}

export interface CanonicalLocation {
  /** The mapped native parent, when the parent belongs to this collection. */
  readonly parent?: FolderRef;
  /** Mapped folders from the parent upwards, nearest first, up to the first unmapped one (server `ancestorIds`). */
  readonly ancestors: readonly FolderRef[];
}

const MAX_ANCESTORS = 128;

/** Where a native folder sits canonically. Unmapped folders are outside the collection: no parent, no ancestors. */
export async function canonicalLocation(nativeParentId: string, context: { readonly serverUuid: string; readonly collectionId: string },
  deps: ProjectionDeps): Promise<CanonicalLocation> {
  const ref = (nodeId: string): FolderRef => ({ serverUuid: context.serverUuid, collectionId: context.collectionId, nodeId });
  const chain: FolderRef[] = [];
  const seen = new Set<string>();
  let current: string | undefined = nativeParentId;
  while (current && !seen.has(current) && chain.length < MAX_ANCESTORS) {
    seen.add(current);
    const mapping = await deps.mappingByNativeId(current);
    if (!mapping || (mapping.nodeKind !== undefined && mapping.nodeKind !== 'folder')) break;
    chain.push(ref(mapping.colpId));
    current = (await deps.nativeNode(current))?.parentId;
  }
  const parent = chain[0];
  return parent ? { parent, ancestors: chain } : { ancestors: [] };
}

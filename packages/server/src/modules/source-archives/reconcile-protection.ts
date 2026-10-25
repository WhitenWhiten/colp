import { SourceArchiveError } from './codec.js';
import type { ManagedSaveState, ManagedSlot } from './managed-copies.js';
import type { ManagedReconcilePorts } from './reconcile.js';

/** Inspect current canonical ancestry, including roles associated after the original operation. */
export async function assertManagedDescendants(state: ManagedSaveState, collectionId: string, nodeId: string,
  slot: ManagedSlot | null, ports: Pick<ManagedReconcilePorts, 'read'>) {
  const parents = new Map<string, string | null>();
  for (const binding of Object.values(state.bindings)) {
    if (binding.collectionId !== collectionId || binding.node.nodeId === nodeId) continue;
    if (slot?.kind === 'folder' && binding.slot.kind === 'bookmark' && binding.slot.copy.purpose === 'sourceArchive'
      && binding.slot.copy.content.site === slot.source.site && binding.slot.copy.content.identityVersion === slot.source.identityVersion
      && binding.slot.copy.sourceAccount === slot.source.sourceAccount && binding.slot.copy.sourceCollectionId === slot.source.sourceCollectionId) continue;
    const current = await ports.read(collectionId, binding.node.nodeId);
    if (!current || current.deleted) continue;
    let id: string | null = current.parentId;
    const seen = new Set<string>();
    while (id) {
      if (id === nodeId) throw new SourceArchiveError('source_copy_protected');
      if (seen.has(id) || seen.size >= 256 || parents.size >= 10000) throw new SourceArchiveError('source_capacity');
      seen.add(id);
      if (!parents.has(id)) parents.set(id, (await ports.read(collectionId, id))?.parentId ?? null);
      id = parents.get(id) ?? null;
    }
  }
}

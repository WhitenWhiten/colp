import { sourceConnectionKey } from './site-registry.js';
import { SourceArchiveError } from './codec.js';
import { managedSlotKey, type ManagedSaveCommand, type ManagedSaveState, type ManagedNode } from './managed-copies.js';
/** Only immutable v1 association keys prove which old canonical node belongs to a source role. */
export function adoptLegacyManagedCopy(managed: ManagedSaveState, legacy: { folders: Record<string, ManagedNode>; copies: Record<string, ManagedNode> }, command: ManagedSaveCommand) {
  const slot = command.slot;
  const copy = slot.kind === 'bookmark' && slot.copy.purpose === 'sourceArchive' ? slot.copy : null;
  if (slot.kind === 'bookmark' && !copy) return;
  const source = slot.kind === 'folder' ? slot.source : { site: copy!.content.site, identityVersion: copy!.content.identityVersion,
    sourceAccount: copy!.sourceAccount, sourceCollectionId: copy!.sourceCollectionId };
  const connection = sourceConnectionKey(source), role = managedSlotKey(command.collectionId, slot);
  if (Object.hasOwn(managed.bindings, role)) return;
  const candidates = Object.entries(slot.kind === 'folder' ? legacy.folders : legacy.copies).flatMap(([key, node]) => {
    let parts: unknown; try { parts = JSON.parse(key); } catch { throw new SourceArchiveError('source_legacy_association_review_required'); }
    if (!Array.isArray(parts) || parts[0] !== connection) return [];
    if (slot.kind === 'folder') return parts[1] === command.collectionId && parts[3] === source.sourceCollectionId ? [node] : [];
    if (parts[1] !== slot.copy.content.itemId) return [];
    if (parts[2] === 'single') throw new SourceArchiveError('source_legacy_association_review_required');
    return parts[2] === command.collectionId && parts[4] === source.sourceCollectionId ? [node] : [];
  });
  const unique = [...new Map(candidates.map(node => [node.nodeId, node])).values()];
  if (unique.length > 1) throw new SourceArchiveError('source_legacy_association_review_required');
  const node = unique[0]; if (!node) return;
  if (node.parentId !== command.parentId) throw new SourceArchiveError('source_mapping_migration_required');
  managed.bindings[role] = { slot, collectionId: command.collectionId, node, state: 'active' };
}

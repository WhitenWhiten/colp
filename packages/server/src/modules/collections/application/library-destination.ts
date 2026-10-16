import { CollectionsError } from '../domain/index.js';
import type { LockedNodeRow, ProductCollectionCanonicalPorts } from './ports.js';

/** Product writes belong under a browser role folder; sync retains its own admission rules. */
export async function assertLibraryDestination(
  ports: Pick<ProductCollectionCanonicalPorts, 'nodes'>,
  collection: { readonly id: string; readonly isLibrary?: boolean },
  parent: LockedNodeRow,
): Promise<void> {
  if (!collection.isLibrary) return;
  const seen = new Set<string>();
  let current: LockedNodeRow | null = parent;
  while (current && current.collectionId === collection.id && current.deletedAt === null && !seen.has(current.id)) {
    if (current.folderRole === 'bookmarks-bar' || current.folderRole === 'other-bookmarks') return;
    if (current.isRoot || !current.parentId) break;
    seen.add(current.id);
    current = await ports.nodes.getNode(collection.id, current.parentId);
  }
  throw new CollectionsError('invalid_node_parent', 'Choose a browser folder inside your bookmark library.');
}

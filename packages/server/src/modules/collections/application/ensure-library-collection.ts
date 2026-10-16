import { generateOpaqueId, generateRevisionToken } from '../domain/index.js';
import { bootstrapCanonicalOwnedCollection } from './canonical-owned-collection-bootstrap.js';
import type { CanonicalOwnedCollectionBootstrapPorts } from './ports.js';
import type { CanonicalMutationInput } from '../domain/canonical-mutation.js';

export interface LibraryCollection {
  readonly id: string;
  readonly title: string;
  readonly rootNodeId: string;
  readonly library: true;
  readonly bookmarksBarId: string;
  readonly otherBookmarksId: string;
}
export interface LibraryOwner {
  readonly principalId: string;
  readonly subjectId: string;
}
export interface LibraryCollectionPorts {
  readonly bootstrap: CanonicalOwnedCollectionBootstrapPorts;
  find(ownerSubjectId: string): Promise<LibraryCollection | null>;
  mutate(input: CanonicalMutationInput): Promise<unknown>;
}
export interface LibraryCollectionUnitOfWork {
  /** Serializes ensures for this owner; the database also enforces uniqueness. */
  execute<T>(owner: LibraryOwner, work: (ports: LibraryCollectionPorts) => Promise<T>): Promise<T>;
}

/** Library, root and browser role folders become visible in one canonical transaction. */
export async function ensureLibraryCollection(
  unitOfWork: LibraryCollectionUnitOfWork,
  owner: LibraryOwner,
): Promise<LibraryCollection> {
  return unitOfWork.execute(owner, async (ports) => {
    const existing = await ports.find(owner.subjectId);
    if (existing) return existing;
    const id = generateOpaqueId();
    const rootNodeId = generateOpaqueId();
    const bookmarksBarId = generateOpaqueId();
    const otherBookmarksId = generateOpaqueId();
    const actor = { ...owner, principalType: 'account' as const };
    await bootstrapCanonicalOwnedCollection(ports.bootstrap, {
      actor, collectionId: id, rootNodeId, isLibrary: true, kind: 'bookmarks',
      title: 'Bookmarks', summary: null,
      operationId: generateOpaqueId(), domainEventId: generateOpaqueId(), outboxId: generateOpaqueId(),
      resourceRevision: generateRevisionToken(), contentRevision: generateRevisionToken(),
      policyRevision: generateRevisionToken(), rootResourceRevision: generateRevisionToken(),
      rootChildrenRevision: generateRevisionToken(),
    });
    for (const folder of [
      { id: bookmarksBarId, title: 'Bookmarks bar', role: 'bookmarks-bar' },
      { id: otherBookmarksId, title: 'Other bookmarks', role: 'other-bookmarks' },
    ]) {
      await ports.mutate({
        operationId: generateOpaqueId(), collectionId: id, actor,
        automationContext: { origin: 'system' },
        mutation: {
          action: 'create', target: { collectionId: id, resourceId: folder.id, resourceKind: 'node' },
          parentId: rootNodeId,
          fields: { kindFields: { kind: 'folder', title: folder.title, folderRole: folder.role,
            description: null, tags: [], visibility: 'inherit' }, extensions: {} },
        },
      });
    }
    return { id, title: 'Bookmarks', rootNodeId, library: true, bookmarksBarId, otherBookmarksId };
  });
}

import type { ProductPublicCollectionPage, ProductPublicCollectionNode, ProductPublicCollectionQueryPorts } from './product-public-query.js';

export interface PublicFolderShareTree {
  readonly shareId: string; readonly collectionId: string; readonly ownerSubjectId: string;
  readonly title: string; readonly description: string | null; readonly rootId: string;
  readonly updatedAt: string; readonly revision: string;
  readonly nodes: readonly ProductPublicCollectionNode[];
  readonly relations: NonNullable<ProductPublicCollectionPage['relations']>;
}
export interface PublicFolderShareReadPort { load(slug: string, includeRelations?: boolean): Promise<PublicFolderShareTree | null> }
export class FolderSharePublicReadError extends Error {
  constructor(readonly code: 'invalid_cursor' | 'snapshot_expired' | 'resource_not_found') { super(code); }
}

/** Share capability grants only the filtered subtree, even when its owner is signed in. */
export async function getProductPublicFolderSharePage(ports: ProductPublicCollectionQueryPorts, input: {
  slug: string; limit: number; cursor?: string; includeRelations?: boolean;
}): Promise<ProductPublicCollectionPage | null> {
  const tree = await ports.folderShares?.load(input.slug, input.includeRelations);
  if (!tree) return null;
  const context = { version: 'folder-share-page-v1', slug: input.slug, shareId: tree.shareId,
    limit: input.limit, relations: input.includeRelations === true };
  const total = tree.nodes.length + (input.includeRelations ? tree.relations.length : 0);
  let offset = 0;
  let expiresAt = Date.now() + 15 * 60_000;
  if (input.cursor) {
    const verified = ports.cursors.product.verify(input.cursor, context);
    if (!verified.valid) throw new FolderSharePublicReadError('invalid_cursor');
    let position: { offset?: unknown; revision?: unknown; expiresAt?: unknown };
    try { position = JSON.parse(verified.nextPosition); } catch { throw new FolderSharePublicReadError('invalid_cursor'); }
    if (!position || typeof position !== 'object' || !Number.isSafeInteger(position.offset) || Number(position.offset) < 1 || Number(position.offset) >= total
      || !Number.isSafeInteger(position.expiresAt)) throw new FolderSharePublicReadError('invalid_cursor');
    if (position.revision !== tree.revision || Number(position.expiresAt) <= Date.now()) throw new FolderSharePublicReadError('snapshot_expired');
    offset = Number(position.offset); expiresAt = Number(position.expiresAt);
  }
  const owner = await ports.owners.findByOwnerSubjectId(tree.ownerSubjectId);
  if (!owner || owner.ownerSubjectId !== tree.ownerSubjectId || !owner.displayName) throw new FolderSharePublicReadError('resource_not_found');
  let avatarUrl: string | null = null;
  try {
    const url = new URL(owner.avatarUrl ?? '');
    if (url.protocol === 'https:' && !url.username && !url.password) avatarUrl = url.href;
  } catch { /* No public avatar. */ }
  const end = offset + input.limit;
  const cursor = end < total ? ports.cursors.product.sign({ ...context,
    nextPosition: JSON.stringify({ offset: end, revision: tree.revision, expiresAt }) }) : null;
  return {
    collection: { id: tree.collectionId, slug: input.slug, title: tree.title, summary: tree.description,
      kind: 'bookmarks', rootNodeId: tree.rootId, updatedAt: tree.updatedAt, access: 'public',
      folderShare: true, viewCount: 0, curatorNote: null,
      owner: { profileId: owner.profileId, handle: owner.handle, displayName: owner.displayName, avatarUrl }, faviconCdnAllowed: false },
    nodes: tree.nodes.slice(offset, end),
    ...(input.includeRelations ? { relations: tree.relations.slice(Math.max(0, offset - tree.nodes.length), Math.max(0, end - tree.nodes.length)) } : {}),
    page: { cursor, hasMore: cursor !== null, sequence: Math.floor(offset / input.limit) + 1 },
  };
}

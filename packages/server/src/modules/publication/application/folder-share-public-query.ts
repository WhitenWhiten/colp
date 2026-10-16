import type { ProductPublicCollectionPage, ProductPublicCollectionNode, ProductPublicCollectionQueryPorts } from './product-public-query.js';

export interface FolderSharePosition { readonly phase: 'nodes' | 'relations'; readonly after: string }
export interface PublicFolderSharePage {
  readonly shareId: string; readonly collectionId: string; readonly ownerSubjectId: string;
  readonly title: string; readonly description: string | null; readonly rootId: string;
  readonly updatedAt: string;
  readonly nodes: readonly ProductPublicCollectionNode[];
  readonly relations: NonNullable<ProductPublicCollectionPage['relations']>;
  readonly nextPosition: FolderSharePosition | null;
}
export interface PublicFolderShareReadPort {
  load(slug: string, input: { limit: number; includeRelations: boolean; position?: FolderSharePosition }): Promise<PublicFolderSharePage | null>;
}
export class FolderSharePublicReadError extends Error {
  constructor(readonly code: 'invalid_cursor' | 'snapshot_expired' | 'resource_not_found') { super(code); }
}

/** Live keyset pages recheck policy; unrelated sync writes never invalidate a cursor. */
export async function getProductPublicFolderSharePage(ports: ProductPublicCollectionQueryPorts, input: {
  slug: string; limit: number; cursor?: string; includeRelations?: boolean;
}): Promise<ProductPublicCollectionPage | null> {
  const context = { version: 'folder-share-page-v2', slug: input.slug,
    limit: input.limit, relations: input.includeRelations === true };
  let position: FolderSharePosition | undefined;
  let sequence = 1, expiresAt = Date.now() + 15 * 60_000;
  if (input.cursor) {
    const verified = ports.cursors.product.verify(input.cursor, context);
    if (!verified.valid) throw new FolderSharePublicReadError('invalid_cursor');
    let parsed: { phase?: unknown; after?: unknown; sequence?: unknown; expiresAt?: unknown };
    try { parsed = JSON.parse(verified.nextPosition); } catch { throw new FolderSharePublicReadError('invalid_cursor'); }
    if (!parsed || typeof parsed !== 'object' || !['nodes', 'relations'].includes(String(parsed.phase))
      || (parsed.phase === 'relations' && !input.includeRelations)
      || typeof parsed.after !== 'string' || parsed.after.length > 128
      || !Number.isSafeInteger(parsed.sequence) || Number(parsed.sequence) < 2
      || !Number.isSafeInteger(parsed.expiresAt)) throw new FolderSharePublicReadError('invalid_cursor');
    if (Number(parsed.expiresAt) <= Date.now()) throw new FolderSharePublicReadError('snapshot_expired');
    position = { phase: parsed.phase as FolderSharePosition['phase'], after: parsed.after };
    sequence = Number(parsed.sequence); expiresAt = Number(parsed.expiresAt);
  }
  const tree = await ports.folderShares?.load(input.slug, {
    limit: input.limit, includeRelations: input.includeRelations === true, ...(position ? { position } : {}),
  });
  if (!tree) return null;
  const owner = await ports.owners.findByOwnerSubjectId(tree.ownerSubjectId);
  if (!owner || owner.ownerSubjectId !== tree.ownerSubjectId || !owner.displayName) throw new FolderSharePublicReadError('resource_not_found');
  let avatarUrl: string | null = null;
  try {
    const url = new URL(owner.avatarUrl ?? '');
    if (url.protocol === 'https:' && !url.username && !url.password) avatarUrl = url.href;
  } catch { /* No public avatar. */ }
  const cursor = tree.nextPosition ? ports.cursors.product.sign({ ...context,
    nextPosition: JSON.stringify({ ...tree.nextPosition, sequence: sequence + 1, expiresAt }) }) : null;
  return {
    collection: { id: tree.collectionId, slug: input.slug, title: tree.title, summary: tree.description,
      kind: 'bookmarks', rootNodeId: tree.rootId, updatedAt: tree.updatedAt, access: 'public',
      folderShare: true, viewCount: 0, curatorNote: null,
      owner: { profileId: owner.profileId, handle: owner.handle, displayName: owner.displayName, avatarUrl }, faviconCdnAllowed: false },
    nodes: tree.nodes,
    ...(input.includeRelations ? { relations: tree.relations } : {}),
    page: { cursor, hasMore: cursor !== null, sequence },
  };
}

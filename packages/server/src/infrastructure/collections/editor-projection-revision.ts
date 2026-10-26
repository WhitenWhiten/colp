import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import { attachBookmarkPreviewImages } from '../../modules/collections/index.js';
import { findBookmarkIconObjectIdsByNodeIds } from './bookmark-icon-postgres.js';
import { createPostgresLinkPreviewReadPort } from './link-preview-read-postgres.js';

export interface EditorProjectionOptions {
  readonly linkPreviews?: boolean;
  readonly productOrigin?: string;
}

/** Hash current image/share references, including worker changes that do not advance contentRevision. */
export async function loadEditorProjectionRevision(
  transaction: DatabaseTransaction,
  collectionId: string,
  options: EditorProjectionOptions,
): Promise<string> {
  const nodes = await transaction.selectFrom('nodes')
    .select(['id', 'kind', 'url'])
    .select(sql<boolean>`EXISTS (SELECT 1 FROM folder_shares s WHERE s.collection_id = nodes.collection_id AND s.node_id = nodes.id AND s.revoked_at IS NULL)`.as('shared'))
    .where('collection_id', '=', collectionId)
    .where('deleted_at', 'is', null)
    .where('is_root', '=', false)
    .where('kind', 'in', ['bookmark', 'folder'])
    .orderBy(sql`id COLLATE "C"`)
    .execute();
  const [icons, previews] = await Promise.all([
    findBookmarkIconObjectIdsByNodeIds(transaction, nodes.filter(node => node.kind === 'bookmark').map(node => node.id)),
    attachBookmarkPreviewImages(options.linkPreviews ? createPostgresLinkPreviewReadPort(transaction) : undefined,
      options.productOrigin, nodes),
  ]);
  return createHash('sha256').update(JSON.stringify(nodes.map((node, index) => [
    node.id, node.shared, icons.get(node.id) ?? null,
    (previews[index] as { previewImage?: unknown } | undefined)?.previewImage ?? null,
  ]))).digest('hex');
}

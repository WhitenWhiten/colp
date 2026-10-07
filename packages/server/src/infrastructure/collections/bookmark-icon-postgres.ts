import { overlaySharedFaviconObjectIds } from './favicon-shared-projection.js';
import type { Kysely } from 'kysely';
import type {
  BookmarkIconReadPort,
  BookmarkIconRow,
  BookmarkIconWritePort,
} from '../../modules/collections/index.js';
import type { DatabaseSchema } from '../database/runtime.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';

function mapRow(row: {
  node_id: string;
  collection_id: string;
  object_id: string;
  content_type: string;
  byte_size: number;
  digest_sha256: Buffer;
  created_at: Date;
  updated_at: Date;
}): BookmarkIconRow {
  return {
    nodeId: row.node_id,
    collectionId: row.collection_id,
    objectId: row.object_id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    digestSha256: Buffer.from(row.digest_sha256),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function deleteBookmarkIconsForNodeIds(
  transaction: DatabaseTransaction,
  nodeIds: readonly string[],
): Promise<void> {
  if (nodeIds.length === 0) return;
  await transaction
    .deleteFrom('bookmark_icons')
    .where('node_id', 'in', [...nodeIds])
    .execute();
}

export async function deleteBookmarkIconsForCollection(
  transaction: DatabaseTransaction,
  collectionId: string,
): Promise<void> {
  await transaction
    .deleteFrom('bookmark_icons')
    .where('collection_id', '=', collectionId)
    .execute();
}

/** Empty `nodeIds` must not issue SQL. Missing ids are omitted from the map. */
export async function findBookmarkIconObjectIdsByNodeIds(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
  nodeIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (nodeIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('bookmark_icons')
    .select(['node_id', 'object_id'])
    .where('node_id', 'in', [...nodeIds])
    .execute();
  return overlaySharedFaviconObjectIds(db, nodeIds, new Map(rows.map((row) => [row.node_id, row.object_id])));
}

export function createPostgresBookmarkIconReadPort(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
): BookmarkIconReadPort {
  return {
    findObjectIdsByNodeIds: (nodeIds) => findBookmarkIconObjectIdsByNodeIds(db, nodeIds),
  };
}

export function createPostgresBookmarkIconWritePort(
  transaction: DatabaseTransaction,
): BookmarkIconWritePort {
  return {
    async findByNodeId(nodeId) {
      const row = await transaction
        .selectFrom('bookmark_icons')
        .selectAll()
        .where('node_id', '=', nodeId)
        .executeTakeFirst();
      return row ? mapRow(row) : null;
    },
    async findObjectIdsByNodeIds(nodeIds) {
      return findBookmarkIconObjectIdsByNodeIds(transaction, nodeIds);
    },
    async upsert(row) {
      // Durable favicon attribution (content governance): record every object
      // as soon as it is bound to a bookmark. The row outlives later icon
      // replacement or deletion because object-store cleanup is best-effort,
      // so hide_public on the Collection/bookmark keeps blocking old object
      // URLs through bookmark_icon_objects.
      await transaction
        .insertInto('bookmark_icon_objects')
        .values({
          object_id: row.objectId,
          collection_id: row.collectionId,
          node_id: row.nodeId,
          created_at: new Date(),
        })
        .onConflict((oc) => oc.column('object_id').doNothing())
        .execute();
      await transaction
        .insertInto('bookmark_icons')
        .values({
          node_id: row.nodeId,
          collection_id: row.collectionId,
          object_id: row.objectId,
          content_type: row.contentType,
          byte_size: row.byteSize,
          digest_sha256: row.digestSha256,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        })
        .onConflict((oc) => oc
          .column('node_id')
          .doUpdateSet({
            object_id: row.objectId,
            content_type: row.contentType,
            byte_size: row.byteSize,
            digest_sha256: row.digestSha256,
            updated_at: row.updatedAt,
            collection_id: row.collectionId,
          }))
        .execute();
    },
    async deleteByNodeId(nodeId) {
      const existing = await transaction
        .selectFrom('bookmark_icons')
        .selectAll()
        .where('node_id', '=', nodeId)
        .executeTakeFirst();
      if (!existing) return null;
      await transaction
        .deleteFrom('bookmark_icons')
        .where('node_id', '=', nodeId)
        .execute();
      return mapRow(existing);
    },
    async deleteByNodeIds(nodeIds) {
      await deleteBookmarkIconsForNodeIds(transaction, nodeIds);
    },
    async deleteByCollectionId(collectionId) {
      await deleteBookmarkIconsForCollection(transaction, collectionId);
    },
  };
}

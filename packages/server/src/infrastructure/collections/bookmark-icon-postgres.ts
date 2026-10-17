import { overlaySharedFaviconObjectIds } from './favicon-shared-projection.js';
import { sql, type Kysely } from 'kysely';
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

export interface BookmarkIconLookupOptions {
  /**
   * Each bookmark keeps its own object. Public readers need this: they may
   * see only part of a collection, and an object is served publicly only
   * while its own bookmark is published.
   */
  readonly perNode?: boolean;
}

export async function findBookmarkIconObjectIdsByNodeIds(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
  nodeIds: readonly string[],
  options: BookmarkIconLookupOptions = {},
): Promise<ReadonlyMap<string, string>> {
  if (nodeIds.length === 0) return new Map();
  const rows = options.perNode === true
    ? await db
      .selectFrom('bookmark_icons')
      .select(['node_id', 'object_id'])
      .where('node_id', 'in', [...nodeIds])
      .execute()
    : await sharedObjectIdsByNodeIds(db, nodeIds);
  return overlaySharedFaviconObjectIds(db, nodeIds, new Map(rows.map((row) => [row.node_id, row.object_id])));
}

/**
 * Every bookmark of a site usually stores the same icon bytes under its own
 * object, so a browser downloaded one copy per bookmark. Bookmarks in one
 * collection with byte-identical icons now share the lowest of their object
 * ids. An owner or member can read every bookmark in the collection, and
 * objects are never rewritten, so the shared id serves the same bytes.
 */
async function sharedObjectIdsByNodeIds(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
  nodeIds: readonly string[],
): Promise<Array<{ node_id: string; object_id: string }>> {
  const result = await sql<{ node_id: string; object_id: string }>`
    WITH wanted AS (
      SELECT node_id, collection_id, digest_sha256, object_id
        FROM bookmark_icons
       WHERE node_id = ANY(${[...nodeIds]}::text[])
    ), shared AS (
      SELECT i.collection_id, i.digest_sha256, min(i.object_id::text) AS object_id
        FROM bookmark_icons i
        JOIN nodes n ON n.id = i.node_id AND n.collection_id = i.collection_id
       WHERE (i.collection_id, i.digest_sha256) IN (SELECT collection_id, digest_sha256 FROM wanted)
         AND n.kind = 'bookmark'
         AND n.deleted_at IS NULL
       GROUP BY i.collection_id, i.digest_sha256
    )
    SELECT w.node_id, coalesce(s.object_id, w.object_id::text) AS object_id
      FROM wanted w
      LEFT JOIN shared s USING (collection_id, digest_sha256)
  `.execute(db);
  return result.rows;
}

export function createPostgresBookmarkIconReadPort(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
  options: BookmarkIconLookupOptions = {},
): BookmarkIconReadPort {
  return {
    findObjectIdsByNodeIds: (nodeIds) => findBookmarkIconObjectIdsByNodeIds(db, nodeIds, options),
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

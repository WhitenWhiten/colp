import { sql, type Kysely } from 'kysely';
import type { CollectionBookmarkCountReadPort } from '../../modules/collections/index.js';
import type { DatabaseTransaction } from '../database/unit-of-work.js';
import type { DatabaseSchema } from '../database/runtime.js';

/** One GROUP BY for the authorized page ids. Empty input does not query. */
export function createPostgresCollectionBookmarkCountReadPort(
  transaction: DatabaseTransaction | Kysely<DatabaseSchema>,
): CollectionBookmarkCountReadPort {
  return {
    async countBookmarks(collectionIds) {
      if (collectionIds.length === 0) return new Map();
      const rows = await sql<{ collection_id: string; bookmark_count: number }>`
        SELECT collection_id, count(*)::int AS bookmark_count
        FROM nodes
        WHERE collection_id = ANY(${sql.val([...collectionIds])}::text[])
          AND deleted_at IS NULL
          AND kind = 'bookmark'
        GROUP BY collection_id
      `.execute(transaction);
      return new Map(rows.rows.map((row) => [row.collection_id, row.bookmark_count]));
    },
  };
}

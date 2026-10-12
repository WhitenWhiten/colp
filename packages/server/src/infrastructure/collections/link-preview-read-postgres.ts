/**
 * LP-04 link preview read port: one query for ready, non-generic targets by
 * url key and one for owner vetoes by node id. Runs inside the caller's
 * transaction when given one (editor/children snapshots) or on the pool.
 */
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, DatabaseTransaction } from '../database/index.js';
import type { LinkPreviewReadPort, LinkPreviewReadyTarget } from '../../modules/collections/index.js';

export function createPostgresLinkPreviewReadPort(
  db: DatabaseTransaction | Kysely<DatabaseSchema>,
): LinkPreviewReadPort {
  return {
    async findReadyByUrlKeys(urlKeys) {
      if (urlKeys.length === 0) return new Map();
      const result = await sql<{ url_key: string; object_id: string; width: number; height: number }>`
        SELECT url_key, object_id, width, height FROM link_preview_targets
         WHERE url_key = ANY(${[...urlKeys]}::text[]) AND status = 'ready' AND NOT generic AND object_id IS NOT NULL
      `.execute(db);
      return new Map<string, LinkPreviewReadyTarget>(result.rows.map((row) => [
        row.url_key, { objectId: row.object_id, width: row.width, height: row.height },
      ]));
    },
    async findVetoedNodeIds(nodeIds) {
      if (nodeIds.length === 0) return new Set();
      const result = await sql<{ node_id: string }>`
        SELECT node_id FROM bookmark_preview_prefs WHERE node_id = ANY(${[...nodeIds]}::text[]) AND mode = 'none'
      `.execute(db);
      return new Set(result.rows.map((row) => row.node_id));
    },
  };
}

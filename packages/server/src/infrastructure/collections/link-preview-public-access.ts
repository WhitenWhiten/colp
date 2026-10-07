/**
 * LP-04 object-route gate. A preview UUID is a shared copy of one page URL.
 * Serve it only while at least one bookmark still exposes that URL to an
 * anonymous reader: public or unlisted collection, no private/protected
 * ancestor, no active hide_public on the bookmark or collection, and no
 * owner veto. Any other object id, including one that used to be public,
 * fails closed.
 */
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import {
  bookmarkHidePublicExistsSql,
  collectionHidePublicExistsSql,
} from '../governance/collection-control-sql.js';
import { PUBLICATION_TARGET_ACCESS_MAX_DEPTH } from '../publication/target-access-facts.js';

type Executor = Kysely<DatabaseSchema> | DatabaseTransaction;

export interface LinkPreviewPublicAccessOptions {
  readonly cancelBackend?: UnitOfWorkOptions['cancelBackend'];
}

const UUID_OBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function createPostgresLinkPreviewPublicAccess(
  db: Kysely<DatabaseSchema>,
  options: LinkPreviewPublicAccessOptions = {},
): {
  isServable(objectId: string, signal?: AbortSignal): Promise<boolean>;
} {
  return {
    async isServable(objectId, signal) {
      if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const read = (executor: Executor) => readServable(executor, objectId);
      if (signal === undefined) return read(db);
      return createUnitOfWork(db, {
        signal,
        ...(options.cancelBackend ? { cancelBackend: options.cancelBackend } : {}),
      }).execute(({ transaction }) => read(transaction));
    },
  };
}

async function readServable(executor: Executor, objectId: string): Promise<boolean> {
      const hiddenBookmark = bookmarkHidePublicExistsSql('n.id', 'n.collection_id');
      const hiddenCollection = collectionHidePublicExistsSql('c.id');
      const result = await sql<{ servable: boolean }>`
        SELECT EXISTS (
          SELECT 1
            FROM link_preview_targets t
            JOIN nodes n
              ON n.kind = 'bookmark'
             AND n.deleted_at IS NULL
             AND n.url IS NOT NULL
             AND public.link_preview_url_key(n.url) = t.url_key
            JOIN collections c
              ON c.id = n.collection_id
             AND c.deleted_at IS NULL
             AND c.visibility IN ('public', 'unlisted')
           WHERE t.object_id = ${objectId}::uuid
             AND t.status = 'ready'
             AND t.generic = false
             AND n.visibility NOT IN ('private', 'protected')
             AND NOT EXISTS (
               WITH RECURSIVE ancestors AS (
                 -- Same numbering as readParentAncestry: the parent is depth 0.
                 -- A root reached by depth 256 is legal; depth 256 with a parent is not.
                 SELECT p.id, p.parent_id, p.visibility, ARRAY[p.id] AS path, 0 AS depth, false AS cycle
                   FROM nodes p
                  WHERE p.collection_id = n.collection_id
                    AND p.id = n.parent_id
                 UNION ALL
                 SELECT p.id, p.parent_id, p.visibility, a.path || p.id, a.depth + 1, p.id = ANY(a.path)
                   FROM nodes p
                   JOIN ancestors a ON p.id = a.parent_id
                  WHERE p.collection_id = n.collection_id
                    AND NOT a.cycle
                    AND a.depth < ${PUBLICATION_TARGET_ACCESS_MAX_DEPTH}
               )
               SELECT 1 FROM ancestors
                WHERE visibility IN ('private', 'protected')
                   OR cycle
                   OR (depth = ${PUBLICATION_TARGET_ACCESS_MAX_DEPTH} AND parent_id IS NOT NULL)
             )
             AND NOT ${sql.raw(hiddenBookmark)}
             AND NOT ${sql.raw(hiddenCollection)}
             AND NOT EXISTS (
               SELECT 1 FROM bookmark_preview_prefs prefs
                WHERE prefs.node_id = n.id AND prefs.mode = 'none'
             )
        ) AS servable
      `.execute(executor);
      return result.rows[0]?.servable === true;
}

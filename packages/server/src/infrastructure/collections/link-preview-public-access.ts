/**
 * LP-04 object-route gate. A preview UUID is a shared copy of one page URL.
 * Serve it only while at least one bookmark still exposes that URL to an
 * anonymous reader: public or unlisted collection, no private/protected
 * ancestor, no active hide_public on the bookmark or collection, and no
 * owner veto. Any other object id, including one that used to be public,
 * fails closed. A signed-in reader may also load the copy for a bookmark in a
 * collection they own or belong to (a private Gallery).
 */
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/runtime.js';
import { createUnitOfWork, type DatabaseTransaction, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import {
  bookmarkHidePublicExistsSql,
  buildPublicationTargetAncestorRestrictionSql,
  collectionPublicationAllowedSql,
} from '../database/collection-control-sql.js';

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
  isReadableBySubject(objectId: string, subjectId: string): Promise<boolean>;
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
    async isReadableBySubject(objectId, subjectId) {
      if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
      const result = await sql<{ readable: boolean }>`
        SELECT EXISTS (
          SELECT 1
            FROM link_preview_targets t
            JOIN nodes n
              ON n.kind = 'bookmark'
             AND n.deleted_at IS NULL
             AND n.url IS NOT NULL
             AND public.link_preview_url_key(n.url) = t.url_key
            JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
           WHERE t.object_id = ${objectId}::uuid
             AND t.status = 'ready'
             AND t.generic = false
             AND (c.owner_subject_id = ${subjectId} OR EXISTS (
               SELECT 1 FROM collection_members m
                WHERE m.collection_id = c.id AND m.subject_id = ${subjectId}
             ))
             AND NOT EXISTS (
               SELECT 1 FROM bookmark_preview_prefs prefs
                WHERE prefs.node_id = n.id AND prefs.mode = 'none'
             )
        ) AS readable
      `.execute(db);
      return result.rows[0]?.readable === true;
    },
  };
}

async function readServable(executor: Executor, objectId: string): Promise<boolean> {
      const hiddenBookmark = bookmarkHidePublicExistsSql('n.id', 'n.collection_id');
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
             AND NOT ${sql.raw(buildPublicationTargetAncestorRestrictionSql('n'))}
             AND NOT ${sql.raw(hiddenBookmark)}
             AND ${sql.raw(collectionPublicationAllowedSql('c'))}
             AND NOT EXISTS (
               SELECT 1 FROM bookmark_preview_prefs prefs
                WHERE prefs.node_id = n.id AND prefs.mode = 'none'
             )
        ) AS servable
      `.execute(executor);
      return result.rows[0]?.servable === true;
}

import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from '../database/index.js';
import { createUnitOfWork, type UnitOfWorkOptions } from '../database/unit-of-work.js';
import { bookmarkHidePublicExistsSql, buildPublicationTargetAncestorRestrictionSql,
  collectionPublicationAllowedSql } from '../database/collection-control-sql.js';
import { IMAGE_ID_PATTERN } from '../../modules/collections/index.js';

/** Access follows the current node binding, never the upload author or a shared URL hash. */
export function createPostgresImagePublicAccess(db: Kysely<DatabaseSchema>, options: Pick<UnitOfWorkOptions, 'cancelBackend'> = {}) {
  return {
    async isServable(objectId: string, signal?: AbortSignal): Promise<boolean> {
      if (!IMAGE_ID_PATTERN.test(objectId)) return false;
      return createUnitOfWork(db, { ...options, signal }).execute(async ({ transaction }) => {
        const hiddenNode = bookmarkHidePublicExistsSql('n.id', 'n.collection_id');
        const result = await sql<{ allowed: boolean }>`SELECT EXISTS (
          SELECT 1 FROM node_cover_prefs p
          JOIN nodes n ON n.id = p.node_id AND n.collection_id = p.collection_id AND n.deleted_at IS NULL
          JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
          WHERE p.asset_id = ${objectId}::uuid AND p.mode = 'custom'
            AND c.visibility IN ('public', 'unlisted') AND n.visibility NOT IN ('private', 'protected')
            AND NOT ${sql.raw(buildPublicationTargetAncestorRestrictionSql('n'))}
            AND NOT ${sql.raw(hiddenNode)} AND ${sql.raw(collectionPublicationAllowedSql('c'))}
        ) AS allowed`.execute(transaction);
        return result.rows[0]?.allowed === true;
      });
    },
    async isReadableBySubject(objectId: string, subjectId: string): Promise<boolean> {
      if (!IMAGE_ID_PATTERN.test(objectId)) return false;
      const result = await sql<{ allowed: boolean }>`SELECT EXISTS (
        SELECT 1 FROM node_cover_prefs p
        JOIN nodes n ON n.id = p.node_id AND n.collection_id = p.collection_id AND n.deleted_at IS NULL
        JOIN collections c ON c.id = n.collection_id AND c.deleted_at IS NULL
        WHERE p.asset_id = ${objectId}::uuid AND p.mode = 'custom'
          AND (c.owner_subject_id = ${subjectId} OR EXISTS (
            SELECT 1 FROM collection_members m WHERE m.collection_id = c.id AND m.subject_id = ${subjectId}
          ))
      ) AS allowed`.execute(db);
      return result.rows[0]?.allowed === true;
    },
  };
}

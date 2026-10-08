import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './runtime.js';
import {
  accountRestrictPublicationExistsSql,
  buildPublicationTargetAncestorRestrictionSql,
} from './collection-control-sql.js';

const UUID_OBJECT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Public favicon admission is a positive check against the current live
 * bookmark binding.  Historical object attribution is deliberately ignored:
 * an object URL is only readable while it is still bound to a live bookmark
 * in a public collection whose node and ancestor chain are publicly visible.
 */
export async function isFaviconPubliclyAccessible(
  db: Kysely<DatabaseSchema>,
  objectId: string,
): Promise<boolean> {
  if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
  const ancestorRestriction = buildPublicationTargetAncestorRestrictionSql('n');
  const result = await sql<{ accessible: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM bookmark_icons i
        JOIN nodes n
          ON n.id = i.node_id
         AND n.collection_id = i.collection_id
        JOIN collections c
          ON c.id = i.collection_id
        LEFT JOIN accounts owner_account
          ON owner_account.subject_id = c.owner_subject_id
       WHERE i.object_id = ${objectId}::uuid
         AND n.kind = 'bookmark'
         AND n.deleted_at IS NULL
         AND c.deleted_at IS NULL
         AND c.visibility = 'public'
         AND NOT (owner_account.id IS NOT NULL AND ${sql.raw(accountRestrictPublicationExistsSql('owner_account.id'))})
         AND n.visibility = 'inherit'
         AND NOT ${sql.raw(ancestorRestriction)}
         AND NOT EXISTS (
           SELECT 1 FROM moderation_actions ma
            WHERE ma.target_kind = 'bookmark'
              AND ma.target_id = n.id
              AND ma.parent_id = c.id
              AND ma.state = 'active'
              AND ma.action = 'hide_public'
         )
         AND NOT EXISTS (
           SELECT 1 FROM moderation_actions ma
            WHERE ma.target_kind = 'collection'
              AND ma.target_id = c.id
              AND ma.state = 'active'
              AND ma.action = 'hide_public'
         )
    ) AS accessible
  `.execute(db);
  return result.rows[0]?.accessible === true;
}

/**
 * Compatibility helper for callers that only need the old negative answer.
 * New public object routes must use `isFaviconPubliclyAccessible` so missing
 * or retired bindings fail closed rather than being treated as visible.
 */
export async function isFaviconHiddenPublic(
  db: Kysely<DatabaseSchema>,
  objectId: string,
): Promise<boolean> {
  if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
  return !(await isFaviconPubliclyAccessible(db, objectId));
}

/** restrict_publication still blocks avatar objects after the governance module is gone. */
export async function isAvatarPublicationRestricted(
  db: Kysely<DatabaseSchema>,
  objectId: string,
): Promise<boolean> {
  if (!UUID_OBJECT_PATTERN.test(objectId)) return false;
  const result = await sql<{ hidden: boolean }>`
    SELECT EXISTS (
      SELECT 1
        FROM profiles p
        JOIN moderation_actions ma
          ON ma.target_kind = 'account'
         AND ma.target_id = p.account_id
         AND ma.state = 'active'
         AND ma.action = 'restrict_publication'
       WHERE p.avatar_url IS NOT NULL
         AND lower(p.avatar_url) LIKE '%/api/v1/avatar/' || lower(${objectId})
      UNION
      SELECT 1
        FROM avatar_objects ao
        JOIN moderation_actions ma
          ON ma.target_kind = 'account'
         AND ma.target_id = ao.account_id
         AND ma.state = 'active'
         AND ma.action = 'restrict_publication'
       WHERE ao.object_id = ${objectId}::uuid
    ) AS hidden
  `.execute(db);
  return result.rows[0]?.hidden === true;
}
